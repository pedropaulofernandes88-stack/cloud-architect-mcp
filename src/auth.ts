import { createHash } from 'node:crypto';

import type { Principal } from './domain/contracts.js';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface ApiGatewayJwtEvent {
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
}

/**
 * Converts the JWT claims that API Gateway has already validated into the
 * application's principal. This deliberately does not parse Authorization
 * headers: signature and audience verification remain Gateway's job.
 */
export function principalFromApiGatewayJwt(
  event: ApiGatewayJwtEvent,
  expectedIssuer: string,
): Principal {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims) {
    throw new AuthenticationError('Token JWT ausente no authorizer do API Gateway.');
  }

  const subject = requiredString(claims.sub, 'sub');
  const issuer = requiredString(claims.iss, 'iss');
  if (issuer !== expectedIssuer) {
    throw new AuthenticationError('Emissor JWT não corresponde ao emissor esperado.');
  }

  return {
    ownerId: createHash('sha256').update(`${issuer}\0${subject}`, 'utf8').digest('hex'),
    scopes: readScopes(claims),
  };
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw new AuthorizationError(`Escopo obrigatório ausente: ${scope}.`);
  }
}

function requiredString(value: unknown, claim: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuthenticationError(`Claim JWT obrigatória inválida: ${claim}.`);
  }
  return value;
}

function readScopes(claims: Record<string, unknown>): readonly string[] {
  const rawScopes = claims.scopes ?? claims.scope;
  if (Array.isArray(rawScopes)) {
    return rawScopes.filter(
      (scope): scope is string => typeof scope === 'string' && scope.length > 0,
    );
  }
  if (typeof rawScopes === 'string') {
    return rawScopes.split(/\s+/).filter(Boolean);
  }
  return [];
}
