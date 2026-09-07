import { StartExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, DynamoDBBatchResponse, DynamoDBRecord } from 'aws-lambda';

type SfnClient = Pick<SFNClient, 'send'>;

export interface DispatcherOptions {
  stateMachineArn: string;
  client?: SfnClient;
}

/**
 * DynamoDB Streams is an at-least-once outbox transport. Starting a Standard
 * workflow with the deterministic operation id makes a duplicate record safe.
 */
export function createDispatcher(options: DispatcherOptions) {
  const client = options.client ?? new SFNClient({});
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const failures: Array<{ itemIdentifier: string }> = [];
    for (const record of event.Records) {
      if (!isPendingOperationInsert(record)) continue;
      try {
        // Lambda's generated stream type and the SDK's AttributeValue type are
        // structurally equivalent but come from distinct packages.
        const image = unmarshall(
          (record.dynamodb?.NewImage ?? {}) as Record<string, AttributeValue>,
        );
        const ownerId = asString(image.ownerId, 'ownerId');
        const operationId = asString(image.id, 'id');
        await client.send(
          new StartExecutionCommand({
            stateMachineArn: options.stateMachineArn,
            name: operationId,
            input: JSON.stringify({ ownerId, operationId }),
          }),
        );
      } catch (error) {
        // A repeated stream record must not turn an already-created workflow into a failure.
        if (!isExecutionAlreadyExists(error))
          failures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? 'unknown' });
      }
    }
    return { batchItemFailures: failures };
  };
}

let configuredHandler: ReturnType<typeof createDispatcher> | undefined;
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  configuredHandler ??= createDispatcher({
    stateMachineArn: requiredEnvironment('STATE_MACHINE_ARN'),
  });
  return configuredHandler(event);
}

function isPendingOperationInsert(record: DynamoDBRecord): boolean {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return false;
  const image = record.dynamodb.NewImage;
  return image.kind?.S === 'operation' && image.status?.S === 'PENDING';
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Evento sem ${name}.`);
  return value;
}

function isExecutionAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ExecutionAlreadyExists'
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}.`);
  return value;
}
