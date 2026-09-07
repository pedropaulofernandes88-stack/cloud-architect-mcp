import { argumentsForCommand, commandContext } from './context.js';

async function main(): Promise<void> {
  const args = argumentsForCommand();
  if ((!args.plan && !args.operation) || (args.plan && args.operation))
    throw new Error('Informe exatamente um: --plan <id> ou --operation <id>.');
  const context = await commandContext(args.aws, args.owner);
  try {
    const record = args.plan
      ? await context.repository.getPlan(context.ownerId, args.plan)
      : await context.repository.getOperation(context.ownerId, args.operation!);
    if (!record) throw new Error('Registro não encontrado.');
    console.log(JSON.stringify(record, null, 2));
  } finally {
    context.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no comando.');
  process.exitCode = 1;
});
