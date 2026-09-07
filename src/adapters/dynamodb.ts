import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  DomainError,
  type Operation,
  type OperationUpdate,
  type Plan,
  type Repository,
} from '../domain/contracts.js';
import { approve, applyOperationUpdate, enqueue, operationId } from '../domain/repository-rules.js';

type StoredPlan = Plan & { PK: string; SK: string; kind: 'plan' };
type StoredOperation = Operation & { PK: string; SK: string; kind: 'operation'; revision: number };
type StoredApproval = {
  PK: string;
  SK: string;
  kind: 'approval';
  planId: string;
  digest: string;
  approvedBy: string;
  approvedAt: string;
};
type DynamoClient = Pick<DynamoDBDocumentClient, 'send'>;

const MAX_CONFLICT_RETRIES = 3;

/** DynamoDB implementation. PK scopes every read and conditional write to its owner. */
export class DynamoRepository implements Repository {
  private readonly client: DynamoClient;

  constructor(
    private readonly options: {
      tableName: string;
      client?: DynamoClient;
      clientConfig?: DynamoDBClientConfig;
    },
  ) {
    this.client =
      options.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient(options.clientConfig ?? {}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async putPlan(plan: Plan): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.options.tableName,
        Item: this.planItem(plan),
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      }),
    );
  }

  async getPlan(ownerId: string, planId: string): Promise<Plan | undefined> {
    const plan = await this.getStoredPlan(ownerId, planId);
    if (!plan) return undefined;
    const approval = await this.getApproval(ownerId, planId);
    const base = {
      ...plan,
      status: 'PLANNED' as const,
      approvedAt: undefined,
      approvedBy: undefined,
    };
    if (!isValidApproval(approval, plan)) return base;
    return {
      ...base,
      status: plan.status === 'QUEUED' ? 'QUEUED' : 'APPROVED',
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
    };
  }

  private async getStoredPlan(ownerId: string, planId: string): Promise<Plan | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.planKey(ownerId, planId),
        ConsistentRead: true,
      }),
    );
    return response.Item ? this.fromPlan(response.Item as StoredPlan) : undefined;
  }

  async approvePlan(
    ownerId: string,
    planId: string,
    digest: string,
    approvedBy: string,
    at: string,
  ): Promise<Plan> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const stored = await this.getStoredPlan(ownerId, planId);
      if (stored?.status === 'QUEUED') {
        throw new DomainError(
          'CONFLICT',
          'O plano já possui uma operação ou estado de fila inválido.',
        );
      }
      const current = await this.getPlan(ownerId, planId);
      const next = approve(current, digest, approvedBy, at);
      if (next === current || next.status === current?.status) return next;
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.options.tableName,
            Item: {
              ...this.approvalKey(ownerId, planId),
              kind: 'approval',
              planId,
              digest,
              approvedBy,
              approvedAt: at,
            },
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
          }),
        );
        return next;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt === MAX_CONFLICT_RETRIES - 1) throw error;
      }
    }
    throw new Error('Não foi possível aprovar o plano após conflitos concorrentes.');
  }

  async enqueueOperation(
    ownerId: string,
    planId: string,
    digest: string,
    idempotencyKey: string,
    at: string,
  ): Promise<Operation> {
    const expectedOperationId = operationId(ownerId, idempotencyKey);
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const plan = await this.getPlan(ownerId, planId);
      const existingByKey = await this.getOperation(ownerId, expectedOperationId);
      const existing =
        existingByKey ??
        (plan?.operationId ? await this.getOperation(ownerId, plan.operationId) : undefined);
      const result = enqueue(plan, existing, ownerId, planId, digest, idempotencyKey, at);
      if (result.replay) return result.operation;

      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.options.tableName,
                  Key: this.approvalKey(ownerId, planId),
                  ConditionExpression: '#kind = :kind AND #digest = :digest',
                  ExpressionAttributeNames: { '#kind': 'kind', '#digest': 'digest' },
                  ExpressionAttributeValues: { ':kind': 'approval', ':digest': digest },
                },
              },
              {
                Update: {
                  TableName: this.options.tableName,
                  Key: this.planKey(ownerId, planId),
                  UpdateExpression: 'SET #status = :queued, #operationId = :operationId',
                  ConditionExpression:
                    '#status = :planned AND #digest = :digest AND attribute_not_exists(#operationId)',
                  ExpressionAttributeNames: {
                    '#status': 'status',
                    '#digest': 'digest',
                    '#operationId': 'operationId',
                  },
                  ExpressionAttributeValues: {
                    ':planned': 'PLANNED',
                    ':queued': 'QUEUED',
                    ':digest': digest,
                    ':operationId': result.operation.id,
                  },
                },
              },
              {
                Put: {
                  TableName: this.options.tableName,
                  Item: this.operationItem(result.operation),
                  ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
                },
              },
            ],
          }),
        );
        return result.operation;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt === MAX_CONFLICT_RETRIES - 1) throw error;
      }
    }
    throw new Error('Não foi possível enfileirar a operação após conflitos concorrentes.');
  }

  async getOperation(ownerId: string, operationIdValue: string): Promise<Operation | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.operationKey(ownerId, operationIdValue),
        ConsistentRead: true,
      }),
    );
    return response.Item ? this.fromOperation(response.Item as StoredOperation) : undefined;
  }

  async updateOperation(
    ownerId: string,
    operationIdValue: string,
    update: OperationUpdate,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const current = await this.getOperation(ownerId, operationIdValue);
      if (!current) throw new DomainError('NOT_FOUND', 'Operação não encontrada.');
      const next = applyOperationUpdate(current, update);
      if (next === current) return;
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.options.tableName,
            Item: this.operationItem(next, revisionOf(current) + 1),
            ConditionExpression:
              '#status = :currentStatus AND #updatedAt = :currentUpdatedAt AND #revision = :revision',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#updatedAt': 'updatedAt',
              '#revision': 'revision',
            },
            ExpressionAttributeValues: {
              ':currentStatus': current.status,
              ':currentUpdatedAt': current.updatedAt,
              ':revision': revisionOf(current),
            },
          }),
        );
        return;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt === MAX_CONFLICT_RETRIES - 1) throw error;
      }
    }
    throw new Error('Não foi possível atualizar a operação após conflitos concorrentes.');
  }

  private planKey(ownerId: string, planId: string) {
    return { PK: `OWNER#${ownerId}`, SK: `PLAN#${planId}` };
  }

  private operationKey(ownerId: string, operationIdValue: string) {
    return { PK: `OWNER#${ownerId}`, SK: `OP#${operationIdValue}` };
  }

  private approvalKey(ownerId: string, planId: string) {
    return { PK: `APPROVAL#${ownerId}`, SK: `PLAN#${planId}` };
  }

  private async getApproval(ownerId: string, planId: string): Promise<StoredApproval | undefined> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.options.tableName,
        Key: this.approvalKey(ownerId, planId),
        ConsistentRead: true,
      }),
    );
    return response.Item as StoredApproval | undefined;
  }

  private planItem(plan: Plan): StoredPlan {
    return { ...plan, ...this.planKey(plan.ownerId, plan.id), kind: 'plan' };
  }

  private operationItem(operation: Operation, revision = revisionOf(operation)): StoredOperation {
    return {
      ...operation,
      ...this.operationKey(operation.ownerId, operation.id),
      kind: 'operation',
      revision,
    };
  }

  private fromPlan(item: StoredPlan): Plan {
    const { PK: _pk, SK: _sk, kind: _kind, ...plan } = item;
    return plan;
  }

  private fromOperation(item: StoredOperation): Operation {
    const { PK: _pk, SK: _sk, kind: _kind, revision, ...operation } = item;
    return Object.defineProperty(operation, '__revision', { value: revision, enumerable: false });
  }
}

function revisionOf(operation: Operation): number {
  const value = (operation as Operation & { __revision?: unknown }).__revision;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isValidApproval(
  approval: StoredApproval | undefined,
  plan: Plan,
): approval is StoredApproval {
  return (
    approval?.kind === 'approval' &&
    approval.planId === plan.id &&
    approval.digest === plan.digest &&
    typeof approval.approvedAt === 'string' &&
    approval.approvedAt.length > 0 &&
    typeof approval.approvedBy === 'string' &&
    approval.approvedBy.length > 0
  );
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'ConditionalCheckFailedException' ||
      error.name === 'TransactionCanceledException')
  );
}
