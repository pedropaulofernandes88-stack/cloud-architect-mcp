import { parseArgs } from 'node:util';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { SqliteRepository } from '../adapters/sqlite.js';
import { DynamoRepository } from '../adapters/dynamodb.js';
import { LOCAL_PRINCIPAL, localDatabasePath } from '../local-config.js';
import type { Repository } from '../domain/contracts.js';

export function argumentsForCommand() {
  return parseArgs({
    options: {
      aws: { type: 'boolean', default: false },
      plan: { type: 'string' },
      operation: { type: 'string' },
      owner: { type: 'string' },
      digest: { type: 'string' },
    },
    strict: true,
  }).values;
}

export async function commandContext(
  aws: boolean,
  owner?: string,
): Promise<{
  repository: Repository;
  ownerId: string;
  reviewer: string;
  close: () => void;
}> {
  if (aws) {
    if (!process.env.TABLE_NAME || !owner)
      throw new Error('AWS exige TABLE_NAME e --owner obtido do plano.');
    const sts = new STSClient({ maxAttempts: 3 });
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Arn) throw new Error('Identidade IAM não confirmada.');
      return {
        repository: new DynamoRepository({ tableName: process.env.TABLE_NAME }),
        ownerId: owner,
        reviewer: identity.Arn,
        close() {},
      };
    } finally {
      sts.destroy();
    }
  }
  const repository = new SqliteRepository(localDatabasePath());
  return {
    repository,
    ownerId: owner ?? LOCAL_PRINCIPAL.ownerId,
    reviewer: 'local-operator',
    close: () => repository.close(),
  };
}
