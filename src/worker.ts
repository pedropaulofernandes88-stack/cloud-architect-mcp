import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  type Output,
  type Stack,
} from '@aws-sdk/client-cloudformation';

import { DynamoRepository } from './adapters/dynamodb.js';
import type { Operation, Repository } from './domain/contracts.js';
import { assertPlanIntegrity } from './domain/repository-rules.js';

type CloudFormation = Pick<CloudFormationClient, 'send'>;
export type WorkerAction = 'start' | 'poll' | 'fail';
export interface WorkerEvent {
  action: WorkerAction;
  ownerId: string;
  operationId: string;
  message?: string;
}

export interface WorkerOptions {
  repository: Repository;
  cloudFormation?: CloudFormation;
  executionRoleArn: string;
}

const RESOURCE_TYPES = ['AWS::S3::Bucket', 'AWS::SQS::Queue', 'AWS::DynamoDB::Table'];
const WORKFLOW_DEADLINE_MS = 55 * 60 * 1000;

export function createWorker(options: WorkerOptions) {
  const cloudFormation = options.cloudFormation ?? new CloudFormationClient({});
  return async (event: WorkerEvent): Promise<Operation> => {
    assertEvent(event);
    switch (event.action) {
      case 'start':
        return start(options.repository, cloudFormation, options.executionRoleArn, event);
      case 'poll':
        return poll(options.repository, cloudFormation, event);
      case 'fail':
        return fail(options.repository, event);
    }
  };
}

let configuredHandler: ReturnType<typeof createWorker> | undefined;
export async function handler(event: WorkerEvent): Promise<Operation> {
  configuredHandler ??= createWorker({
    repository: new DynamoRepository({ tableName: requiredEnvironment('TABLE_NAME') }),
    executionRoleArn: requiredEnvironment('EXECUTION_ROLE_ARN'),
  });
  return configuredHandler(event);
}

async function start(
  repository: Repository,
  cloudFormation: CloudFormation,
  executionRoleArn: string,
  event: WorkerEvent,
): Promise<Operation> {
  const operation = await mustGetOperation(repository, event);
  if (operation.status !== 'PENDING') return operation;
  const plan = await repository.getPlan(event.ownerId, operation.planId);
  if (
    !plan ||
    plan.status !== 'QUEUED' ||
    plan.operationId !== operation.id ||
    plan.digest !== operation.planDigest
  ) {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
      message: 'Plano enfileirado inválido ou divergente.',
    });
    return await mustGetOperation(repository, event);
  }
  assertPlanIntegrity(plan);

  try {
    const response = await cloudFormation.send(
      new CreateStackCommand({
        StackName: operation.stackName,
        TemplateBody: JSON.stringify(plan.template),
        ClientRequestToken: operation.id,
        RoleARN: executionRoleArn,
        ResourceTypes: RESOURCE_TYPES,
        Tags: [{ Key: 'camcp:operationId', Value: operation.id }],
      }),
    );
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
      stackId: response.StackId,
    });
    return mustGetOperation(repository, event);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await describeStack(cloudFormation, operation.stackName);
    if (!hasOperationTag(existing, operation.id)) {
      await repository.updateOperation(event.ownerId, operation.id, {
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
        message: 'Já existe uma stack sem a tag desta operação.',
      });
      return mustGetOperation(repository, event);
    }
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
      stackId: existing.StackId,
    });
    return mustGetOperation(repository, event);
  }
}

async function poll(
  repository: Repository,
  cloudFormation: CloudFormation,
  event: WorkerEvent,
): Promise<Operation> {
  const operation = await mustGetOperation(repository, event);
  if (operation.status === 'SUCCEEDED' || operation.status === 'FAILED') return operation;
  if (Date.now() - Date.parse(operation.createdAt) >= WORKFLOW_DEADLINE_MS) {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
      message: 'A operação excedeu o prazo operacional de 55 minutos.',
    });
    return mustGetOperation(repository, event);
  }
  const stack = await describeStack(cloudFormation, operation.stackId ?? operation.stackName);
  const status = stack.StackStatus ?? 'UNKNOWN';
  if (!operation.stackId && !hasOperationTag(stack, operation.id)) {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
      stackId: stack.StackId,
      message: 'A stack consultada não pertence a esta operação.',
    });
  } else if (status === 'CREATE_COMPLETE') {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'SUCCEEDED',
      updatedAt: new Date().toISOString(),
      stackId: stack.StackId,
      outputs: outputs(stack.Outputs),
    });
  } else if (isFailedStackStatus(status)) {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
      stackId: stack.StackId,
      message: stack.StackStatusReason ?? status,
    });
  } else if (operation.status === 'PENDING') {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
      stackId: stack.StackId,
    });
  }
  return mustGetOperation(repository, event);
}

async function fail(repository: Repository, event: WorkerEvent): Promise<Operation> {
  const operation = await mustGetOperation(repository, event);
  if (operation.status === 'PENDING' || operation.status === 'RUNNING') {
    await repository.updateOperation(event.ownerId, operation.id, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
      message: event.message ?? 'O workflow excedeu o tempo ou falhou.',
    });
  }
  return mustGetOperation(repository, event);
}

async function mustGetOperation(repository: Repository, event: WorkerEvent): Promise<Operation> {
  const operation = await repository.getOperation(event.ownerId, event.operationId);
  if (!operation) throw new Error('Operação não encontrada para o owner informado.');
  return operation;
}

async function describeStack(cloudFormation: CloudFormation, name: string): Promise<Stack> {
  const response = await cloudFormation.send(new DescribeStacksCommand({ StackName: name }));
  const stack = response.Stacks?.[0];
  if (!stack) throw new Error('CloudFormation não retornou a stack.');
  return stack;
}

function outputs(values: Output[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (values ?? []).flatMap((value) =>
      value.OutputKey && value.OutputValue ? [[value.OutputKey, value.OutputValue]] : [],
    ),
  );
}

function hasOperationTag(stack: Stack, operationId: string): boolean {
  return (
    stack.Tags?.some((tag) => tag.Key === 'camcp:operationId' && tag.Value === operationId) ?? false
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AlreadyExistsException' || error.name === 'TokenAlreadyExistsException')
  );
}

function isFailedStackStatus(status: string): boolean {
  return status.includes('FAILED') || status.includes('ROLLBACK') || status.startsWith('DELETE_');
}

function assertEvent(event: WorkerEvent): void {
  if (
    !event ||
    !['start', 'poll', 'fail'].includes(event.action) ||
    !event.ownerId ||
    !event.operationId
  ) {
    throw new Error('Evento do worker inválido.');
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}.`);
  return value;
}
