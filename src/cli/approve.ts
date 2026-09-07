import { argumentsForCommand, commandContext } from './context.js';

async function main(): Promise<void> {
  const args = argumentsForCommand();
  if (!args.plan || !args.digest)
    throw new Error(
      'Uso: npm run approve -- --plan <id> --digest <sha256> [--aws --owner <ownerId>]',
    );
  const context = await commandContext(args.aws, args.owner);
  try {
    const plan = await context.repository.approvePlan(
      context.ownerId,
      args.plan,
      args.digest,
      context.reviewer,
      new Date().toISOString(),
    );
    console.log(
      JSON.stringify(
        {
          id: plan.id,
          digest: plan.digest,
          status: plan.status,
          approvedAt: plan.approvedAt,
          approvedBy: plan.approvedBy,
        },
        null,
        2,
      ),
    );
  } finally {
    context.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no comando.');
  process.exitCode = 1;
});
