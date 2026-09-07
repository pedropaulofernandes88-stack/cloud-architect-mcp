import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { principalFromApiGatewayJwt, type ApiGatewayJwtEvent } from './auth.js';
import { ArchitectureService } from './domain/service.js';
import { createHttpApp, type HttpApp } from './http.js';
import { DynamoRepository } from './adapters/dynamodb.js';

let lambdaService: ArchitectureService | undefined;
const maxMcpRequestBytes = 64 * 1024;

export interface LambdaHandlerOptions {
  service?: ArchitectureService;
  environment?: NodeJS.ProcessEnv;
}

export function createLambdaHandler(options: LambdaHandlerOptions = {}) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const bodyValidation = validateEventBody(event);
    if (bodyValidation) return plainGatewayResponse(bodyValidation.status, bodyValidation.message);

    const httpRequest = requestFromGatewayEvent(event);
    const configuredApp = createLambdaApp(event, options);
    const response = await configuredApp.fetch(httpRequest);
    return gatewayResponse(response);
  };
}

export const handler = createLambdaHandler();

function createLambdaApp(event: APIGatewayProxyEventV2, options: LambdaHandlerOptions): HttpApp {
  const environment = options.environment ?? process.env;
  const issuer = requiredEnvironment('EXPECTED_ISSUER', environment);
  const service =
    options.service ??
    lambdaService ??
    (lambdaService = new ArchitectureService(
      new DynamoRepository({ tableName: requiredEnvironment('TABLE_NAME', environment) }),
      {
        region: environment.AWS_REGION ?? 'us-east-1',
      },
    ));
  const publicUrl = environment.PUBLIC_URL ?? `https://${event.requestContext.domainName}`;
  const allowedHosts = [new URL(publicUrl).host];

  return createHttpApp(
    service,
    async () => principalFromApiGatewayJwt(event as unknown as ApiGatewayJwtEvent, issuer),
    {
      allowedHosts,
      allowedOrigins: splitEnvironmentList(environment.ALLOWED_ORIGINS),
      publicUrl,
      issuer,
    },
  );
}

function validateEventBody(
  event: APIGatewayProxyEventV2,
): { status: number; message: string } | undefined {
  if (!event.body) return undefined;
  if (!event.isBase64Encoded) {
    return Buffer.byteLength(event.body, 'utf8') > maxMcpRequestBytes
      ? { status: 413, message: 'Corpo da requisição excede 64 KiB.' }
      : undefined;
  }

  const encoded = event.body;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return { status: 400, message: 'Corpo Base64 inválido.' };
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  return decodedLength > maxMcpRequestBytes
    ? { status: 413, message: 'Corpo da requisição excede 64 KiB.' }
    : undefined;
}

function requestFromGatewayEvent(event: APIGatewayProxyEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }

  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body
    : undefined;
  const host = event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return new Request(`https://${host}${event.rawPath}${query}`, {
    method: event.requestContext.http.method,
    headers,
    body,
  });
}

async function gatewayResponse(response: Response): Promise<APIGatewayProxyStructuredResultV2> {
  const body = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: body.toString('base64'),
    isBase64Encoded: true,
  };
}

function plainGatewayResponse(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
    isBase64Encoded: false,
  };
}

function splitEnvironmentList(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}.`);
  return value;
}
