import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { MemoryRepository } from '../src/adapters/memory.js';
import { ArchitectureService } from '../src/domain/service.js';
import { createLambdaHandler } from '../src/lambda.js';

const issuer = 'https://issuer.example/';

function createService(): ArchitectureService {
  return new ArchitectureService(new MemoryRepository(), {
    region: 'us-east-1',
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    id: () => '123e4567-e89b-12d3-a456-426614174000',
  });
}

function eventFor(
  body: string,
  claims?: Record<string, unknown>,
  isBase64Encoded = true,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    rawQueryString: '',
    headers: {
      host: 'test.local',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'plan_architecture',
    },
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test.local',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: '/mcp',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'test',
      routeKey: 'POST /mcp',
      stage: '$default',
      time: '07/Sep/2026:00:00:00 +0000',
      timeEpoch: 0,
      ...(claims ? { authorizer: { jwt: { claims } } } : {}),
    },
    body: isBase64Encoded ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded,
  } as APIGatewayProxyEventV2;
}

function planRequest(name = 'app-storage'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      name: 'plan_architecture',
      arguments: { name, blueprint: 'storage', environment: 'dev' },
    },
  });
}

function decodeGatewayJson(result: { body?: string }): Record<string, unknown> {
  return JSON.parse(Buffer.from(result.body ?? '', 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('adaptador Lambda', () => {
  it('limita o tamanho Base64 antes de alocar o Buffer', async () => {
    const handler = createLambdaHandler({
      service: createService(),
      environment: { EXPECTED_ISSUER: issuer },
    });
    const result = await handler(eventFor(Buffer.alloc(65_537).toString('utf8')));

    expect(result).toMatchObject({ statusCode: 413, isBase64Encoded: false });
  });

  it('rejeita claims ausentes ou emissor divergente sem depender de DynamoDB', async () => {
    const handler = createLambdaHandler({
      service: createService(),
      environment: { EXPECTED_ISSUER: issuer, PUBLIC_URL: 'https://test.local' },
    });

    const missing = await handler(eventFor(planRequest()));
    expect(missing.statusCode).toBe(401);
    expect(missing.headers?.['www-authenticate']).toContain('resource_metadata');

    const wrongIssuer = await handler(
      eventFor(planRequest(), {
        iss: 'https://other.example/',
        sub: 'alice',
        scope: 'architecture:plan',
      }),
    );
    expect(wrongIssuer.statusCode).toBe(401);
  });

  it('deriva o proprietário de cada evento, sem reutilizar o principal de uma invocação anterior', async () => {
    const handler = createLambdaHandler({
      service: createService(),
      environment: { EXPECTED_ISSUER: issuer },
    });
    const scopes = { iss: issuer, scope: 'architecture:plan' };

    const first = await handler(eventFor(planRequest('first-plan'), { ...scopes, sub: 'alice' }));
    const second = await handler(eventFor(planRequest('second-plan'), { ...scopes, sub: 'bob' }));
    const firstPlan = (
      decodeGatewayJson(first).result as { structuredContent: { ownerId: string } }
    ).structuredContent;
    const secondPlan = (
      decodeGatewayJson(second).result as { structuredContent: { ownerId: string } }
    ).structuredContent;

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(firstPlan.ownerId).not.toBe(secondPlan.ownerId);
  });
});
