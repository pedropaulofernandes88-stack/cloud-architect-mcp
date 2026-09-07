import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { Principal } from '../src/domain/contracts.js';
import { ArchitectureService } from '../src/domain/service.js';
import { MemoryRepository } from '../src/adapters/memory.js';
import { createHttpApp } from '../src/http.js';
import { createMcpEndpoint } from '../src/mcp.js';

const fullPrincipal: Principal = {
  ownerId: 'owner-a',
  scopes: ['architecture:read', 'architecture:plan', 'architecture:apply'],
};
const endpoints: Array<ReturnType<typeof createMcpEndpoint>> = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
});

function service(repository = new MemoryRepository()): ArchitectureService {
  return new ArchitectureService(repository, {
    region: 'us-east-1',
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    id: () => '123e4567-e89b-12d3-a456-426614174000',
  });
}

async function modernClient(
  endpoint: ReturnType<typeof createMcpEndpoint>,
  seenRequests?: Request[],
): Promise<Client> {
  endpoints.push(endpoint);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => {
      const request = new Request(url, init);
      seenRequests?.push(request.clone());
      return endpoint.fetch(request);
    },
  });
  const client = new Client(
    { name: 'integration-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe('MCP 2026-07-28', () => {
  it('usa o cliente v2 sem initialize/sessão e expõe as ferramentas do servidor', async () => {
    const seenRequests: Request[] = [];
    const client = await modernClient(createMcpEndpoint(service(), fullPrincipal), seenRequests);

    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'apply_architecture',
      'get_operation',
      'get_plan',
      'list_blueprints',
      'plan_architecture',
      'validate_plan',
    ]);
    expect(
      tools.tools.find((tool) => tool.name === 'list_blueprints')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(tools.tools.find((tool) => tool.name === 'validate_plan')?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(seenRequests.some((request) => request.headers.has('mcp-session-id'))).toBe(false);
    expect(seenRequests.some((request) => request.headers.get('mcp-method') === 'initialize')).toBe(
      false,
    );
  });

  it('rejeita metadados modernos sem os cabeçalhos MCP espelhados', async () => {
    const endpoint = createMcpEndpoint(service(), fullPrincipal);
    endpoints.push(endpoint);
    const response = await endpoint.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32020 } });
  });

  it('recusa subscriptions/listen antes de abrir um fluxo SSE', async () => {
    const app = createHttpApp(service(), async () => fullPrincipal, {
      allowedHosts: ['test.local'],
      allowedOrigins: [],
    });
    const response = await app.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          host: 'test.local',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'subscriptions/listen',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );

    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ id: 5, error: { code: -32601 } });
    await app.close();
  });

  it('mantém planos isolados por proprietário e aplica escopos no serviço', async () => {
    const repository = new MemoryRepository();
    const serviceInstance = service(repository);
    const ownerA = await modernClient(createMcpEndpoint(serviceInstance, fullPrincipal));
    const planned = await ownerA.callTool({
      name: 'plan_architecture',
      arguments: { name: 'app-storage', blueprint: 'storage', environment: 'dev' },
    });
    const plan = planned.structuredContent as { id: string; digest: string };

    const ownerB = await modernClient(
      createMcpEndpoint(serviceInstance, { ownerId: 'owner-b', scopes: fullPrincipal.scopes }),
    );
    const foreignApply = await ownerB.callTool({
      name: 'apply_architecture',
      arguments: { planId: plan.id, digest: plan.digest, idempotencyKey: 'foreign' },
    });
    expect(foreignApply.isError).toBe(true);
    expect(foreignApply.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('NOT_FOUND') },
    ]);

    const readOnly = await modernClient(
      createMcpEndpoint(serviceInstance, { ownerId: 'owner-c', scopes: ['architecture:read'] }),
    );
    const forbidden = await readOnly.callTool({
      name: 'plan_architecture',
      arguments: { name: 'app-storage', blueprint: 'storage', environment: 'dev' },
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('FORBIDDEN') },
    ]);
  });

  it('recupera e valida um plano em outro endpoint sem sessão', async () => {
    const repository = new MemoryRepository();
    const serviceInstance = service(repository);
    const planner = await modernClient(createMcpEndpoint(serviceInstance, fullPrincipal));
    const planned = await planner.callTool({
      name: 'plan_architecture',
      arguments: { name: 'ready-storage', blueprint: 'storage', environment: 'dev' },
    });
    const plan = planned.structuredContent as { id: string; digest: string; ownerId: string };

    const reader = await modernClient(createMcpEndpoint(serviceInstance, fullPrincipal));
    const recovered = await reader.callTool({ name: 'get_plan', arguments: { planId: plan.id } });
    expect(recovered.structuredContent).toMatchObject({
      id: plan.id,
      digest: plan.digest,
      ownerId: plan.ownerId,
    });

    const beforeApproval = await reader.callTool({
      name: 'validate_plan',
      arguments: { planId: plan.id },
    });
    expect(beforeApproval.structuredContent).toMatchObject({
      readyToApply: false,
      checks: { integrity: true, notExpired: true, approved: false, notQueued: true },
    });

    await repository.approvePlan(
      fullPrincipal.ownerId,
      plan.id,
      plan.digest,
      'admin-identity',
      '2026-09-07T00:00:00.000Z',
    );
    const afterApproval = await reader.callTool({
      name: 'validate_plan',
      arguments: { planId: plan.id },
    });
    expect(afterApproval.structuredContent).toMatchObject({
      readyToApply: true,
      checks: { integrity: true, notExpired: true, approved: true, notQueued: true },
    });

    await planner.callTool({
      name: 'apply_architecture',
      arguments: { planId: plan.id, digest: plan.digest, idempotencyKey: 'ready-plan-apply' },
    });
    const afterApply = await reader.callTool({
      name: 'validate_plan',
      arguments: { planId: plan.id },
    });
    expect(afterApply.structuredContent).toMatchObject({
      readyToApply: false,
      status: 'QUEUED',
      checks: { approved: true, notQueued: false },
    });
  });

  it('não revela planos para outro proprietário e exige escopo de leitura', async () => {
    const repository = new MemoryRepository();
    const serviceInstance = service(repository);
    const ownerA = await modernClient(createMcpEndpoint(serviceInstance, fullPrincipal));
    const planned = await ownerA.callTool({
      name: 'plan_architecture',
      arguments: { name: 'private-storage', blueprint: 'storage', environment: 'dev' },
    });
    const plan = planned.structuredContent as { id: string };

    const ownerB = await modernClient(
      createMcpEndpoint(serviceInstance, { ownerId: 'owner-b', scopes: ['architecture:read'] }),
    );
    const foreign = await ownerB.callTool({ name: 'get_plan', arguments: { planId: plan.id } });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('NOT_FOUND') },
    ]);

    const noReadScope = await modernClient(
      createMcpEndpoint(serviceInstance, {
        ownerId: fullPrincipal.ownerId,
        scopes: ['architecture:plan'],
      }),
    );
    const forbidden = await noReadScope.callTool({
      name: 'validate_plan',
      arguments: { planId: plan.id },
    });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toMatchObject([
      { type: 'text', text: expect.stringContaining('FORBIDDEN') },
    ]);
  });

  it('não vaza mensagens de dependências inesperadas', async () => {
    const broken = service();
    broken.catalog = () => {
      throw new Error('DynamoDB secret connection string');
    };
    const client = await modernClient(createMcpEndpoint(broken, fullPrincipal));

    const result = await client.callTool({ name: 'list_blueprints', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject([
      { type: 'text', text: 'Erro interno ao processar a operação.' },
    ]);
  });
});
