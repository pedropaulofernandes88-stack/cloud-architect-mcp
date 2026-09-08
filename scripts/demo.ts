import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import { ArchitectureService } from '../src/domain/service.js';
import type { Plan, Operation } from '../src/domain/contracts.js';
import { LOCAL_PRINCIPAL } from '../src/local-config.js';
import { createMcpEndpoint } from '../src/mcp.js';

// Deliberately isolated simulation. Administrative approval here is a demo fixture.
const repository = new SqliteRepository(':memory:');
const endpoint = createMcpEndpoint(
  new ArchitectureService(repository, { region: 'us-east-1' }),
  LOCAL_PRINCIPAL,
);
const client = new Client(
  { name: 'cloud-architect-demo', version: '0.3.0' },
  { versionNegotiation: { mode: 'auto' } },
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => endpoint.fetch(new Request(url, init)),
    }),
  );
  const tools = await client.listTools();
  const result = await client.callTool({
    name: 'plan_architecture',
    arguments: {
      name: 'demo-events',
      blueprint: 'event-backbone',
      environment: 'dev',
    },
  });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const plan = result.structuredContent as unknown as Plan;
  const alternative = await client.callTool({
    name: 'plan_architecture',
    arguments: { ...plan.input },
  });
  if (alternative.isError) throw new Error(JSON.stringify(alternative.content));
  const alternativePlan = alternative.structuredContent as unknown as Plan;
  const comparison = await client.callTool({
    name: 'compare_plans',
    arguments: { leftPlanId: plan.id, rightPlanId: alternativePlan.id },
  });
  if (comparison.isError) throw new Error(JSON.stringify(comparison.content));
  const planHistory = await client.callTool({ name: 'list_plans', arguments: { limit: 1 } });
  if (planHistory.isError) throw new Error(JSON.stringify(planHistory.content));
  const firstPage = planHistory.structuredContent as { nextCursor: string };
  const nextPlanHistory = await client.callTool({
    name: 'list_plans',
    arguments: { limit: 1, cursor: firstPage.nextCursor },
  });
  if (nextPlanHistory.isError) throw new Error(JSON.stringify(nextPlanHistory.content));
  const args = { planId: plan.id, digest: plan.digest, idempotencyKey: randomUUID() };
  const blocked = await client.callTool({ name: 'apply_architecture', arguments: args });
  if (!blocked.isError) throw new Error('Invariante violada: aplicação sem aprovação.');
  await repository.approvePlan(
    LOCAL_PRINCIPAL.ownerId,
    plan.id,
    plan.digest,
    'SIMULATED-DEMO-REVIEWER',
    new Date().toISOString(),
  );
  const applied = await client.callTool({ name: 'apply_architecture', arguments: args });
  if (applied.isError) throw new Error(JSON.stringify(applied.content));
  const operation = applied.structuredContent as unknown as Operation;
  await repository.updateOperation(LOCAL_PRINCIPAL.ownerId, operation.id, {
    status: 'RUNNING',
    updatedAt: new Date().toISOString(),
  });
  await repository.updateOperation(LOCAL_PRINCIPAL.ownerId, operation.id, {
    status: 'SUCCEEDED',
    updatedAt: new Date().toISOString(),
    message: 'SIMULAÇÃO: nenhum recurso AWS criado.',
    outputs: { mode: 'SIMULATED' },
  });
  const replay = await client.callTool({ name: 'apply_architecture', arguments: args });
  if (replay.isError) throw new Error(JSON.stringify(replay.content));
  const repeated = replay.structuredContent as unknown as Operation;
  if (repeated.id !== operation.id) throw new Error('Invariante violada: operação duplicada.');
  const status = await client.callTool({
    name: 'get_operation',
    arguments: { operationId: operation.id },
  });
  if (status.isError) throw new Error(JSON.stringify(status.content));
  const operationHistory = await client.callTool({ name: 'list_operations', arguments: {} });
  if (operationHistory.isError) throw new Error(JSON.stringify(operationHistory.content));
  console.log(
    JSON.stringify(
      {
        mode: 'SIMULATED',
        protocol: client.getNegotiatedProtocolVersion(),
        tools: tools.tools.map((tool) => tool.name),
        plan: { id: plan.id, digest: plan.digest, resources: plan.template.Resources },
        approvalRequired: blocked.isError,
        replaySameOperation: true,
        comparison: comparison.structuredContent,
        planHistory: [planHistory.structuredContent, nextPlanHistory.structuredContent],
        operationHistory: operationHistory.structuredContent,
        operation: status.structuredContent,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await endpoint.close();
  repository.close();
}
