import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  DomainError,
  type Operation,
  type OperationUpdate,
  type HistoryPage,
  type HistoryQuery,
  type Plan,
  type Repository,
} from '../domain/contracts.js';
import { approve, applyOperationUpdate, enqueue, operationId } from '../domain/repository-rules.js';

type StoredPlan = Plan & {
  PK: string;
  SK: string;
  kind: 'plan';
  timelinePK?: string;
  timelineSK?: string;
};
type StoredOperation = Operation & {
  PK: string;
  SK: string;
  kind: 'operation';
  revision?: number;
  timelinePK?: string;
  timelineSK?: string;
};
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
const MAX_BATCH_RETRIES = 3;
const BATCH_RETRY_BASE_MS = 10;
const BATCH_RETRY_JITTER_MS = 5;
const BATCH_RETRY_MAX_MS = 25;
const TIMELINE_INDEX = 'Timeline';

/** DynamoDB implementation. PK scopes every read and conditional write to its owner. */
export class DynamoRepository implements Repository {
  private readonly client: DynamoClient;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly options: {
      tableName: string;
      client?: DynamoClient;
      clientConfig?: DynamoDBClientConfig;
      /** Allows deterministic retry tests without waiting in real time. */
      wait?: (milliseconds: number) => Promise<void>;
      random?: () => number;
    },
  ) {
    this.client =
      options.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient(options.clientConfig ?? {}), {
        marshallOptions: { removeUndefinedValues: true },
      });
    this.wait = options.wait ?? wait;
    this.random = options.random ?? Math.random;
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
    return this.hydratePlan(plan, approval);
  }

  async listPlans(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Plan>> {
    const timeline = await this.queryTimeline(ownerId, 'plan', query);
    const plans = await this.batchGet(timeline.keys).then((items) =>
      items.map((item) => this.fromPlan(item as unknown as StoredPlan)),
    );
    const approvals = await this.batchGet(plans.map((plan) => this.approvalKey(ownerId, plan.id)));
    const approvalByPlanId = new Map(
      approvals
        .filter((approval) => approval.kind === 'approval')
        .map((approval) => [String(approval.planId), approval as StoredApproval]),
    );
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    return {
      items: timeline.ids
        .map((id) => planById.get(id))
        .filter((plan): plan is Plan => plan !== undefined)
        .map((plan) => this.hydratePlan(plan, approvalByPlanId.get(plan.id))),
      ...(timeline.nextPosition ? { nextPosition: timeline.nextPosition } : {}),
    };
  }

  async listOperations(ownerId: string, query: HistoryQuery): Promise<HistoryPage<Operation>> {
    const timeline = await this.queryTimeline(ownerId, 'operation', query);
    const operations = await this.batchGet(timeline.keys).then((items) =>
      items.map((item) => this.fromOperation(item as unknown as StoredOperation)),
    );
    const operationById = new Map(operations.map((operation) => [operation.id, operation]));
    return {
      items: timeline.ids
        .map((id) => operationById.get(id))
        .filter((operation): operation is Operation => operation !== undefined),
      ...(timeline.nextPosition ? { nextPosition: timeline.nextPosition } : {}),
    };
  }

  private hydratePlan(plan: Plan, approval: StoredApproval | undefined): Plan {
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
              '#status = :currentStatus AND #updatedAt = :currentUpdatedAt AND (attribute_not_exists(#revision) OR #revision = :revision)',
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

  private async queryTimeline(
    ownerId: string,
    kind: 'plan' | 'operation',
    query: HistoryQuery,
  ): Promise<{ keys: Array<{ PK: string; SK: string }>; ids: string[]; nextPosition?: string }> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.options.tableName,
        IndexName: TIMELINE_INDEX,
        KeyConditionExpression: '#pk = :pk' + (query.before ? ' AND #sk < :before' : ''),
        ExpressionAttributeNames: { '#pk': 'timelinePK', '#sk': 'timelineSK' },
        ExpressionAttributeValues: {
          ':pk': this.timelinePartition(ownerId, kind),
          ...(query.before ? { ':before': query.before } : {}),
        },
        ScanIndexForward: false,
        Limit: query.limit + 1,
      }),
    );
    const candidates = (response.Items ?? []).map((item) => {
      const candidate = this.timelineItem(item, ownerId, kind);
      if (!candidate) throw new Error('Índice Timeline contém um item inconsistente.');
      return candidate;
    });
    const page = candidates.slice(0, query.limit);
    return {
      keys: page.map(({ PK, SK }) => ({ PK, SK })),
      ids: page.map(({ id }) => id),
      ...(candidates.length > query.limit && page.at(-1)
        ? { nextPosition: page.at(-1)!.position }
        : {}),
    };
  }

  private timelineItem(
    item: Record<string, unknown>,
    ownerId: string,
    kind: 'plan' | 'operation',
  ): { PK: string; SK: string; id: string; position: string } | undefined {
    const expectedPK = `OWNER#${ownerId}`;
    const expectedTimelinePK = this.timelinePartition(ownerId, kind);
    const prefix = kind === 'plan' ? 'PLAN#' : 'OP#';
    if (
      item.PK !== expectedPK ||
      item.timelinePK !== expectedTimelinePK ||
      typeof item.SK !== 'string' ||
      !item.SK.startsWith(prefix) ||
      typeof item.timelineSK !== 'string'
    )
      return undefined;
    const id = item.SK.slice(prefix.length);
    const position = item.timelineSK;
    return id && validPosition(position)
      ? { PK: expectedPK, SK: item.SK, id, position }
      : undefined;
  }

  private async batchGet(
    keys: Array<{ PK: string; SK: string }>,
  ): Promise<Record<string, unknown>[]> {
    if (keys.length === 0) return [];
    let pending = keys;
    const items: Record<string, unknown>[] = [];
    for (let attempt = 0; pending.length > 0 && attempt < MAX_BATCH_RETRIES; attempt += 1) {
      const response = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.options.tableName]: { Keys: pending, ConsistentRead: true },
          },
        }),
      );
      items.push(
        ...((response.Responses?.[this.options.tableName] ?? []) as Record<string, unknown>[]),
      );
      pending = (response.UnprocessedKeys?.[this.options.tableName]?.Keys ?? []) as Array<{
        PK: string;
        SK: string;
      }>;
      if (pending.length > 0 && attempt < MAX_BATCH_RETRIES - 1)
        await this.wait(batchRetryDelay(attempt, this.random));
    }
    if (pending.length > 0) throw new Error('DynamoDB não processou todos os itens do histórico.');
    return items;
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

  private timelinePartition(ownerId: string, kind: 'plan' | 'operation'): string {
    return `OWNER#${ownerId}#${kind}`;
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
    return {
      ...plan,
      ...this.planKey(plan.ownerId, plan.id),
      ...this.timelineKeys(plan.ownerId, 'plan', plan.createdAt, plan.id),
      kind: 'plan',
    };
  }

  private operationItem(operation: Operation, revision = revisionOf(operation)): StoredOperation {
    return {
      ...operation,
      ...this.operationKey(operation.ownerId, operation.id),
      ...this.timelineKeys(operation.ownerId, 'operation', operation.createdAt, operation.id),
      kind: 'operation',
      revision,
    };
  }

  private fromPlan(item: StoredPlan): Plan {
    const {
      PK: _pk,
      SK: _sk,
      kind: _kind,
      timelinePK: _timelinePK,
      timelineSK: _timelineSK,
      ...plan
    } = item;
    return plan;
  }

  private fromOperation(item: StoredOperation): Operation {
    const {
      PK: _pk,
      SK: _sk,
      kind: _kind,
      revision,
      timelinePK: _timelinePK,
      timelineSK: _timelineSK,
      ...operation
    } = item;
    return Object.defineProperty(operation, '__revision', { value: revision, enumerable: false });
  }

  private timelineKeys(ownerId: string, kind: 'plan' | 'operation', createdAt: string, id: string) {
    return { timelinePK: this.timelinePartition(ownerId, kind), timelineSK: `${createdAt}#${id}` };
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function batchRetryDelay(attempt: number, random: () => number): number {
  const exponential = Math.min(BATCH_RETRY_MAX_MS, BATCH_RETRY_BASE_MS * 2 ** attempt);
  const jitter = Math.floor(Math.min(1, Math.max(0, random())) * BATCH_RETRY_JITTER_MS);
  return Math.min(BATCH_RETRY_MAX_MS, exponential + jitter);
}

function validPosition(value: string): boolean {
  const separator = value.lastIndexOf('#');
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    value.length <= 512 &&
    Number.isFinite(Date.parse(value.slice(0, separator)))
  );
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
