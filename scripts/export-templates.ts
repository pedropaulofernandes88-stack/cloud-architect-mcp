import { mkdir, writeFile } from 'node:fs/promises';
import { createPlan } from '../src/domain/planner.js';

await mkdir('.local/templates', { recursive: true });
for (const blueprint of ['storage', 'event-backbone'] as const) {
  const plan = createPlan(
    'schema-validation',
    { name: 'schema-check', blueprint, environment: 'dev' },
    'us-east-1',
    new Date('2026-09-07T12:00:00Z'),
    () => '00000000-0000-4000-8000-000000000001',
  );
  await writeFile(
    `.local/templates/${blueprint}.json`,
    JSON.stringify(plan.template, null, 2) + '\n',
  );
}
console.log('Templates dos dois blueprints exportados para validação local.');
