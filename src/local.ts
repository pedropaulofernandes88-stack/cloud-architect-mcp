import { createServer } from 'node:http';
import { SqliteRepository } from './adapters/sqlite.js';
import { ArchitectureService } from './domain/service.js';
import { createHttpApp } from './http.js';
import { LOCAL_PRINCIPAL, localDatabasePath } from './local-config.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
const origin = `http://127.0.0.1:${port}`;
const repository = new SqliteRepository(localDatabasePath());
const service = new ArchitectureService(repository, {
  region: process.env.AWS_REGION ?? 'us-east-1',
});
const app = createHttpApp(service, async () => LOCAL_PRINCIPAL, {
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  allowedOrigins: [],
});

const server = createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/')) {
      res.writeHead(400).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 65_536) {
        res.writeHead(413).end('Pedido excede 64 KiB.');
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((part) => headers.append(key, part));
      else if (value !== undefined) headers.set(key, value);
    }
    const body = Buffer.concat(chunks);
    const request = new Request(origin + req.url, {
      method: req.method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    });
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('Erro interno.');
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

// Local simulator replays persisted work after a process restart; it never calls AWS.
let simulating = false;
const simulator = setInterval(async () => {
  if (simulating) return;
  simulating = true;
  try {
    for (const operation of repository.pendingOperations()) {
      await repository.updateOperation(operation.ownerId, operation.id, {
        status: operation.status === 'PENDING' ? 'RUNNING' : 'SUCCEEDED',
        updatedAt: new Date().toISOString(),
        message: 'SIMULAÇÃO LOCAL: nenhum recurso AWS foi criado.',
        outputs: { mode: 'SIMULATED' },
      });
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'local_simulator_error',
        type: error instanceof Error ? error.name : 'Unknown',
      }),
    );
  } finally {
    simulating = false;
  }
}, 500);

server.listen(port, '127.0.0.1', () => {
  console.log(`MCP 2026-07-28 em ${origin}/mcp (SIMULAÇÃO LOCAL; sem recursos AWS).`);
  console.log('Aprovação administrativa: npm run approve -- --plan <id> --digest <sha256>');
});
function stop(): void {
  clearInterval(simulator);
  server.close(() => {
    repository.close();
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
