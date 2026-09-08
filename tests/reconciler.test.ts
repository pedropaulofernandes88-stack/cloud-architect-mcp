import { DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { describe, expect, it } from 'vitest';

import { MemoryRepository } from '../src/adapters/memory.js';
import { createReconciler } from '../src/reconciler.js';
import { planDigest } from '../src/domain/repository-rules.js';

const now = '2026-09-07T12:00:00.000Z';
const stateMachineArn = 'arn:aws:states:sa-east-1:111111111111:stateMachine:camcp';

async function operation(status: 'PENDING' | 'RUNNING' | 'NEEDS_ATTENTION' = 'NEEDS_ATTENTION') {
  const repository = new MemoryRepository();
  const plan = {
    id: 'pln-00000000-0000-4000-8000-000000000001',
    ownerId: 'owner',
    digest: '',
    createdAt: now,
    expiresAt: '2026-09-08T12:00:00.000Z',
    input: { name: 'dados', blueprint: 'storage' as const, environment: 'dev' as const },
    region: 'sa-east-1',
    stackName: 'camcp-dev-dados',
    template: { Resources: {} },
    summary: [],
    status: 'PLANNED' as const,
  };
  const approved = { ...plan, digest: planDigest(plan) };
  await repository.putPlan(approved);
  await repository.approvePlan('owner', approved.id, approved.digest, 'admin', now);
  const created = await repository.enqueueOperation(
    'owner',
    approved.id,
    approved.digest,
    'reconcile',
    now,
  );
  if (status !== 'PENDING')
    await repository.updateOperation('owner', created.id, {
      status: status === 'RUNNING' ? 'RUNNING' : 'NEEDS_ATTENTION',
      updatedAt: now,
    });
  return { repository, operation: await repository.getOperation('owner', created.id) };
}

describe('EventBridge reconciler', () => {
  it('reconcilia uma execução terminal confiável sem criar recursos', async () => {
    const setup = await operation();
    if (!setup.operation) throw new Error('operação ausente');
    const calls: unknown[] = [];
    const reconciler = createReconciler({
      repository: setup.repository,
      stateMachineArn,
      region: 'sa-east-1',
      now: () => new Date(now),
      clientSFN: {
        send: async (command: unknown) => {
          expect(command).toBeInstanceOf(DescribeExecutionCommand);
          return {
            executionArn: 'arn:exec',
            stateMachineArn,
            name: setup.operation!.id,
            status: 'TIMED_OUT',
            input: JSON.stringify({ ownerId: 'owner', operationId: setup.operation!.id }),
          };
        },
      },
      cloudFormation: {
        send: async (command: unknown) => {
          calls.push(command);
          return {
            Stacks: [
              {
                StackId: 'stack',
                StackStatus: 'CREATE_COMPLETE',
                Tags: [{ Key: 'camcp:operationId', Value: setup.operation!.id }],
              },
            ],
          };
        },
      },
    });
    await reconciler({ detail: { executionArn: 'arn:exec' } });
    await expect(setup.repository.getOperation('owner', setup.operation.id)).resolves.toMatchObject(
      { status: 'SUCCEEDED' },
    );
    expect(calls).toHaveLength(1);
  });

  it('ignora execução de outra state machine, input malicioso, duplicata e estado terminal local', async () => {
    const setup = await operation();
    if (!setup.operation) throw new Error('operação ausente');
    let described = 0;
    const reconciler = createReconciler({
      repository: setup.repository,
      stateMachineArn,
      region: 'sa-east-1',
      clientSFN: {
        send: async () => {
          described += 1;
          return {
            executionArn: 'arn:exec',
            stateMachineArn: 'arn:other',
            name: setup.operation!.id,
            status: 'FAILED',
            input: JSON.stringify({ ownerId: 'owner', operationId: setup.operation!.id }),
          };
        },
      },
      cloudFormation: {
        send: async () => {
          throw new Error('não deve reconciliar');
        },
      },
    });
    await reconciler({ detail: { executionArn: 'arn:exec' } });
    await reconciler({ detail: { executionArn: 'arn:exec' } });
    await reconciler({ detail: { executionArn: 1 } });
    expect(described).toBe(2);
    await expect(setup.repository.getOperation('owner', setup.operation.id)).resolves.toMatchObject(
      { status: 'NEEDS_ATTENTION' },
    );
  });

  it('preserva estado terminal local e não aceita stack com tag de outra operação', async () => {
    const setup = await operation();
    if (!setup.operation) throw new Error('operação ausente');
    const good = {
      executionArn: 'arn:exec',
      stateMachineArn,
      name: setup.operation.id,
      status: 'FAILED',
      input: JSON.stringify({ ownerId: 'owner', operationId: setup.operation.id }),
    };
    const badTag = createReconciler({
      repository: setup.repository,
      stateMachineArn,
      region: 'sa-east-1',
      now: () => new Date(now),
      clientSFN: { send: async () => good },
      cloudFormation: {
        send: async () => ({
          Stacks: [
            {
              StackId: 'stack',
              StackStatus: 'CREATE_COMPLETE',
              Tags: [{ Key: 'camcp:operationId', Value: 'other' }],
            },
          ],
        }),
      },
    });
    await badTag({ detail: { executionArn: 'arn:exec' } });
    await expect(setup.repository.getOperation('owner', setup.operation.id)).resolves.toMatchObject(
      { status: 'NEEDS_ATTENTION', message: expect.stringContaining('não possui') },
    );

    await setup.repository.updateOperation('owner', setup.operation.id, {
      status: 'SUCCEEDED',
      updatedAt: now,
    });
    const terminal = createReconciler({
      repository: setup.repository,
      stateMachineArn,
      region: 'sa-east-1',
      clientSFN: { send: async () => good },
      cloudFormation: {
        send: async () => {
          throw new Error('não deve tocar CloudFormation');
        },
      },
    });
    await terminal({ detail: { executionArn: 'arn:exec' } });
    await expect(setup.repository.getOperation('owner', setup.operation.id)).resolves.toMatchObject(
      { status: 'SUCCEEDED' },
    );
  });
});
