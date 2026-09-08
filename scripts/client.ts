import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { values } = parseArgs({
  options: { tool: { type: 'string' }, input: { type: 'string' } },
  strict: true,
});
const supported = [
  'list_blueprints',
  'plan_architecture',
  'get_plan',
  'validate_plan',
  'apply_architecture',
  'get_operation',
  'list_plans',
  'list_operations',
  'compare_plans',
];
if (!values.tool || !supported.includes(values.tool))
  throw new Error(
    `Use --tool ${supported.join(' | ')} e, quando necessário, --input <arquivo.json>.`,
  );
const url = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8787/mcp');
const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
if (url.username || url.password || (!local && url.protocol !== 'https:'))
  throw new Error('O endpoint remoto exige HTTPS e não aceita credenciais na URL.');
const token = local ? undefined : process.env.MCP_ACCESS_TOKEN;
if (!local && !token) throw new Error('Configure MCP_ACCESS_TOKEN com um token de acesso válido.');
const input: unknown = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : {};
if (!input || typeof input !== 'object' || Array.isArray(input))
  throw new Error('O arquivo de argumentos deve conter um objeto JSON.');
const client = new Client(
  { name: 'cloud-architect-cli', version: '0.3.0' },
  { versionNegotiation: { mode: 'auto' } },
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }),
  );
  const result = await client.callTool({
    name: values.tool,
    arguments: input as Record<string, unknown>,
  });
  console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha na chamada MCP.');
  process.exitCode = 1;
} finally {
  await client.close();
}
