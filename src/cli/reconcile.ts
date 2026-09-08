import { argumentsForCommand, commandContext } from './context.js';
import { createWorker } from '../worker.js';

async function main(): Promise<void> {
  const args = argumentsForCommand();
  if (!args.aws || !args.owner || !args.operation || !process.env.AWS_REGION) {
    throw new Error(
      'Uso: npm run reconcile -- --aws --owner <ownerId> --operation <operationId>; configure TABLE_NAME e AWS_REGION.',
    );
  }
  const context = await commandContext(true, args.owner);
  try {
    // The administrative identity needs DescribeStacks and record updates, never CreateStack.
    const worker = createWorker({
      repository: context.repository,
      executionRoleArn: '',
      region: process.env.AWS_REGION,
    });
    const result = await worker({
      action: 'reconcile',
      ownerId: context.ownerId,
      operationId: args.operation,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    context.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha na reconciliação.');
  process.exitCode = 1;
});
