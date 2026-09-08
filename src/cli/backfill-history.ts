import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { backfillHistory } from '../admin/backfill-history.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      write: { type: 'boolean', default: false },
      after: { type: 'string' },
      'max-pages': { type: 'string', default: '20' },
    },
    strict: true,
  });
  if (!values.owner || !process.env.TABLE_NAME || !process.env.AWS_REGION) {
    throw new Error(
      'Configure TABLE_NAME/AWS_REGION e use --owner <ownerId> [--write] [--after <cursor>] [--max-pages 20]. Sem --write, apenas simula as atualizações.',
    );
  }
  const base = new DynamoDBClient({ maxAttempts: 3 });
  const sts = new STSClient({ maxAttempts: 3 });
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Arn) throw new Error('Identidade IAM não confirmada.');
    const result = await backfillHistory({
      client: DynamoDBDocumentClient.from(base),
      tableName: process.env.TABLE_NAME,
      ownerId: values.owner,
      write: values.write,
      maxPages: Number(values['max-pages']),
      after: values.after,
    });
    console.log(
      JSON.stringify(
        {
          ...result,
          operator: identity.Arn,
          note: result.dryRun
            ? 'updated indica quantos registros seriam atualizados.'
            : 'Apenas os atributos derivados do índice foram atualizados.',
        },
        null,
        2,
      ),
    );
  } finally {
    base.destroy();
    sts.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no backfill.');
  process.exitCode = 1;
});
