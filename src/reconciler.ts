import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';

import { DynamoRepository } from './adapters/dynamodb.js';
import type { Repository } from './domain/contracts.js';
import { createWorker } from './worker.js';

type StepFunctions = Pick<SFNClient, 'send'>;
type CloudFormation = Pick<CloudFormationClient, 'send'>;

export interface ReconcilerOptions {
  repository: Repository;
  clientSFN?: StepFunctions;
  cloudFormation?: CloudFormation;
  stateMachineArn: string;
  region: string;
  now?: () => Date;
}

/** Handles only terminal Standard workflow events. EventBridge delivery is best-effort and unordered. */
export function createReconciler(options: ReconcilerOptions) {
  const sfn = options.clientSFN ?? new SFNClient({});
  const cloudFormation = options.cloudFormation ?? new CloudFormationClient({});
  const worker = createWorker({
    repository: options.repository,
    cloudFormation,
    executionRoleArn: '',
    region: options.region,
    now: options.now,
  });
  return async (event: unknown): Promise<void> => {
    const executionArn = executionArnFrom(event);
    if (!executionArn) return;
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (!isTrustedFailure(execution, options.stateMachineArn, executionArn)) return;
    const input = parseInput(execution.input);
    if (!input) return;
    const operation = await options.repository.getOperation(input.ownerId, input.operationId);
    if (!operation || operation.status === 'SUCCEEDED' || operation.status === 'FAILED') return;
    // Identity is established by the authoritative execution, deterministic name and exact input.
    await worker({ action: 'reconcile', ownerId: input.ownerId, operationId: input.operationId });
  };
}

let configuredHandler: ReturnType<typeof createReconciler> | undefined;
export async function handler(event: unknown): Promise<void> {
  configuredHandler ??= createReconciler({
    repository: new DynamoRepository({ tableName: requiredEnvironment('TABLE_NAME') }),
    stateMachineArn: requiredEnvironment('STATE_MACHINE_ARN'),
    region: requiredEnvironment('AWS_REGION'),
  });
  return configuredHandler(event);
}

function executionArnFrom(event: unknown): string | undefined {
  const detail =
    event && typeof event === 'object' ? (event as { detail?: unknown }).detail : undefined;
  const value =
    detail && typeof detail === 'object'
      ? (detail as { executionArn?: unknown }).executionArn
      : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTrustedFailure(
  execution: {
    executionArn?: string;
    stateMachineArn?: string;
    name?: string;
    status?: string;
    input?: string;
  },
  stateMachineArn: string,
  executionArn: string,
): boolean {
  if (!['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status ?? '')) return false;
  if (execution.executionArn !== executionArn || execution.stateMachineArn !== stateMachineArn)
    return false;
  const input = parseInput(execution.input);
  return input !== undefined && execution.name === input.operationId;
}

function parseInput(value: unknown): { ownerId: string; operationId: string } | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.ownerId !== 'string' ||
      typeof record.operationId !== 'string'
    )
      return undefined;
    return record.ownerId && record.operationId
      ? { ownerId: record.ownerId, operationId: record.operationId }
      : undefined;
  } catch {
    return undefined;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}.`);
  return value;
}
