import { DescribeStacksCommand, CreateStackCommand } from '@aws-sdk/client-cloudformation';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { DynamoRepository } from '../src/adapters/dynamodb.js';
import { createDispatcher } from '../src/dispatcher.js';
import { createWorker } from '../src/worker.js';
import { MemoryRepository } from '../src/adapters/memory.js';
import type { Plan } from '../src/domain/contracts.js';
import { planDigest } from '../src/domain/repository-rules.js';

const now = '2026-09-07T12:00:00.000Z';

function plan(status: Plan['status'] = 'APPROVED'): Plan {
  const result: Plan = {
    id: 'pln-00000000-0000-4000-8000-000000000001',
    ownerId: 'owner',
    digest: '',
    createdAt: now,
    expiresAt: '2026-09-08T12:00:00.000Z',
    input: { name: 'dados', blueprint: 'storage', environment: 'dev' },
    region: 'sa-east-1',
    stackName: 'camcp-dev-dados-001',
    template: { Resources: {} },
    summary: [],
    status,
  };
  return { ...result, digest: planDigest(result) };
}

describe('AWS adapters', () => {
  it('enfileira plano e operação numa única transação DynamoDB', async () => {
    const commands: unknown[] = [];
    const repository = new DynamoRepository({
      tableName: 'operations',
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          if (
            command instanceof GetCommand &&
            command.input.Key?.PK === 'OWNER#owner' &&
            command.input.Key?.SK === `PLAN#${plan().id}`
          )
            return {
              Item: {
                ...plan('PLANNED'),
                PK: 'OWNER#owner',
                SK: `PLAN#${plan().id}`,
                kind: 'plan',
              },
            };
          if (command instanceof GetCommand && command.input.Key?.PK === 'APPROVAL#owner')
            return {
              Item: {
                PK: 'APPROVAL#owner',
                SK: `PLAN#${plan().id}`,
                kind: 'approval',
                planId: plan().id,
                digest: plan().digest,
                approvedBy: 'admin',
                approvedAt: now,
              },
            };
          return {};
        },
      },
    });

    const operation = await repository.enqueueOperation(
      'owner',
      plan().id,
      plan().digest,
      'key',
      now,
    );
    expect(operation.status).toBe('PENDING');
    const transaction = commands.find(
      (command) => command instanceof TransactWriteCommand,
    ) as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck?.Key).toMatchObject({
      PK: 'APPROVAL#owner',
    });
    expect(transaction.input.TransactItems?.[1]?.Update?.ExpressionAttributeValues).toMatchObject({
      ':planned': 'PLANNED',
    });
    expect(transaction.input.TransactItems?.[2]?.Put?.Item).toMatchObject({
      PK: 'OWNER#owner',
      kind: 'operation',
    });
  });

  it('inicia uma Standard execution apenas uma vez por INSERT PENDING e trata replay como sucesso', async () => {
    const calls: unknown[] = [];
    const dispatcher = createDispatcher({
      stateMachineArn: 'arn:aws:states:sa-east-1:111111111111:stateMachine:camcp',
      client: {
        send: async (command: unknown) => {
          calls.push(command);
          throw Object.assign(new Error('already'), { name: 'ExecutionAlreadyExists' });
        },
      },
    });
    const result = await dispatcher({
      Records: [
        {
          eventID: 'event-1',
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              kind: { S: 'operation' },
              status: { S: 'PENDING' },
              ownerId: { S: 'owner' },
              id: { S: 'op-a' },
            },
          },
        },
      ],
    });
    expect(result.batchItemFailures).toEqual([]);
    expect(calls[0]).toBeInstanceOf(StartExecutionCommand);
    expect((calls[0] as StartExecutionCommand).input).toMatchObject({
      name: 'op-a',
      input: JSON.stringify({ ownerId: 'owner', operationId: 'op-a' }),
    });
  });

  it('worker só cria a stack com template do plano autorizado e recursos permitidos', async () => {
    const repository = new MemoryRepository();
    const approved = plan('APPROVED');
    await repository.putPlan(approved);
    const operation = await repository.enqueueOperation(
      'owner',
      approved.id,
      approved.digest,
      'key',
      now,
    );
    const commands: unknown[] = [];
    const worker = createWorker({
      repository,
      executionRoleArn: 'arn:aws:iam::111111111111:role/camcp-execution',
      cloudFormation: {
        send: async (command: unknown) => {
          commands.push(command);
          return { StackId: 'stack-id' };
        },
      },
    });

    const result = await worker({ action: 'start', ownerId: 'owner', operationId: operation.id });
    expect(result.status).toBe('RUNNING');
    expect(commands[0]).toBeInstanceOf(CreateStackCommand);
    expect((commands[0] as CreateStackCommand).input).toMatchObject({
      ClientRequestToken: operation.id,
      ResourceTypes: ['AWS::S3::Bucket', 'AWS::SQS::Queue', 'AWS::DynamoDB::Table'],
    });
  });

  it('recupera uma criação cujo retorno se perdeu somente quando a tag pertence à operação', async () => {
    const repository = new MemoryRepository();
    const approved = plan('APPROVED');
    await repository.putPlan(approved);
    const operation = await repository.enqueueOperation(
      'owner',
      approved.id,
      approved.digest,
      'token-replay',
      now,
    );
    const worker = createWorker({
      repository,
      executionRoleArn: 'role',
      cloudFormation: {
        send: async (command: unknown) => {
          if (command instanceof CreateStackCommand)
            throw Object.assign(new Error('token'), { name: 'TokenAlreadyExistsException' });
          if (command instanceof DescribeStacksCommand)
            return {
              Stacks: [
                {
                  StackId: 'stack-id',
                  StackStatus: 'CREATE_IN_PROGRESS',
                  Tags: [{ Key: 'camcp:operationId', Value: operation.id }],
                },
              ],
            };
          throw new Error('comando inesperado');
        },
      },
    });
    await expect(
      worker({ action: 'start', ownerId: 'owner', operationId: operation.id }),
    ).resolves.toMatchObject({ status: 'RUNNING', stackId: 'stack-id' });
  });

  it('worker nunca marca rollback ou delete como sucesso', async () => {
    const repository = new MemoryRepository();
    // Seed through the public flow to preserve repository invariants.
    const approved = plan('APPROVED');
    await repository.putPlan(approved);
    const queued = await repository.enqueueOperation(
      'owner',
      approved.id,
      approved.digest,
      'worker-poll',
      now,
    );
    await repository.updateOperation('owner', queued.id, {
      status: 'RUNNING',
      updatedAt: now,
      stackId: 'stack-id',
    });
    const worker = createWorker({
      repository,
      executionRoleArn: 'role',
      cloudFormation: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(DescribeStacksCommand);
          return {
            Stacks: [
              { StackId: 'stack-id', StackStatus: 'ROLLBACK_COMPLETE', StackStatusReason: 'bad' },
            ],
          };
        },
      },
    });
    const result = await worker({ action: 'poll', ownerId: 'owner', operationId: queued.id });
    expect(result.status).toBe('FAILED');
  });
});
