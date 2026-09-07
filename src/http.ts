import { AuthenticationError } from './auth.js';
import type { Principal } from './domain/contracts.js';
import { ArchitectureService } from './domain/service.js';
import { createMcpEndpoint } from './mcp.js';

const maxMcpRequestBytes = 64 * 1024;

export interface HttpAppOptions {
  allowedHosts: string[];
  allowedOrigins: string[];
  publicUrl?: string;
  issuer?: string;
}

export interface HttpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createHttpApp(
  service: ArchitectureService,
  authenticate: (request: Request) => Promise<Principal>,
  options: HttpAppOptions,
): HttpApp {
  let closed = false;

  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) return textResponse(503, 'Aplicação encerrada.');
      const protection = validateRequestOrigin(request, options);
      if (protection) return protection;

      const path = new URL(request.url).pathname;
      if (path === '/health') return jsonResponse(200, { status: 'ok' });
      if (isProtectedResourceMetadataPath(path) && options.publicUrl && options.issuer) {
        return jsonResponse(200, protectedResourceMetadata(options.publicUrl, options.issuer));
      }
      if (path !== '/mcp') return textResponse(404, 'Não encontrado.');
      if (request.method !== 'POST')
        return textResponse(405, 'Método não permitido.', { allow: 'POST' });

      const requestBody = await readLimitedBody(request);
      if (!requestBody) return textResponse(413, 'Corpo da requisição excede 64 KiB.');
      if (isSubscriptionRequest(requestBody)) {
        return jsonRpcMethodNotFound(
          requestBody,
          'subscriptions/listen não é suportado neste endpoint.',
        );
      }

      let principal: Principal;
      try {
        principal = await authenticate(request);
      } catch (error) {
        const headers =
          error instanceof AuthenticationError
            ? authenticationHeaders(options.publicUrl)
            : undefined;
        return textResponse(
          error instanceof AuthenticationError ? 401 : 403,
          'Não autorizado.',
          headers,
        );
      }

      const endpoint = createMcpEndpoint(service, principal);
      try {
        const response = await endpoint.fetch(
          new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: new TextDecoder().decode(requestBody),
            signal: request.signal,
          }),
        );
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          return textResponse(501, 'Fluxos SSE não são suportados neste endpoint.');
        }

        const payload = await response.arrayBuffer();
        return new Response(payload, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        await endpoint.close();
      }
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

async function readLimitedBody(request: Request): Promise<Uint8Array | undefined> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxMcpRequestBytes)) return undefined;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxMcpRequestBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateRequestOrigin(request: Request, options: HttpAppOptions): Response | undefined {
  const urlAuthority = new URL(request.url).host.toLowerCase();
  const hostAuthority = authorityOf(request.headers.get('host') ?? urlAuthority);
  const allowed = options.allowedHosts
    .map(authorityOf)
    .filter((host): host is string => host !== undefined);
  if (!hostAuthority || hostAuthority !== urlAuthority || !allowed.includes(hostAuthority)) {
    return textResponse(403, 'Host não permitido.');
  }

  const origin = request.headers.get('origin');
  if (origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    const isAllowed =
      normalizedOrigin !== undefined &&
      options.allowedOrigins.some(
        (allowedOrigin) => normalizeOrigin(allowedOrigin) === normalizedOrigin,
      );
    if (!isAllowed) return textResponse(403, 'Origin não permitida.');
  }
  return undefined;
}

function authorityOf(value: string): string | undefined {
  if (!value || /[/?#\\]/.test(value)) return undefined;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function isProtectedResourceMetadataPath(path: string): boolean {
  return (
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/mcp'
  );
}

function isSubscriptionRequest(body: Uint8Array): boolean {
  try {
    return JSON.parse(new TextDecoder().decode(body))?.method === 'subscriptions/listen';
  } catch {
    return false;
  }
}

function jsonRpcMethodNotFound(body: Uint8Array, message: string): Response {
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { id?: unknown };
    if (typeof parsed.id === 'string' || typeof parsed.id === 'number') id = parsed.id;
  } catch {
    // The SDK handles malformed JSON after this targeted rejection check.
  }
  return jsonResponse(200, { jsonrpc: '2.0', id, error: { code: -32601, message } });
}

function protectedResourceMetadata(publicUrl: string, issuer: string) {
  const base = publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl;
  return {
    resource: base.endsWith('/mcp') ? base : `${base}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['architecture:read', 'architecture:plan', 'architecture:apply'],
  };
}

function authenticationHeaders(publicUrl: string | undefined): HeadersInit | undefined {
  if (!publicUrl) return undefined;
  const resource = new URL(publicUrl);
  const resourcePath = resource.pathname.endsWith('/mcp')
    ? resource.pathname
    : `${resource.pathname.replace(/\/$/, '')}/mcp`;
  const resourceMetadata = new URL(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    resource.origin,
  ).href;
  return { 'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"` };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
}
