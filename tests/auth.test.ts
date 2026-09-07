import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  AuthorizationError,
  principalFromApiGatewayJwt,
  requireScope,
} from '../src/auth.js';

const issuer = 'https://issuer.example/';

describe('principalFromApiGatewayJwt', () => {
  it('deriva um proprietário estável e preserva os escopos validados pelo Gateway', () => {
    const principal = principalFromApiGatewayJwt(
      {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                iss: issuer,
                sub: 'alice',
                scopes: ['architecture:read', 'architecture:plan'],
              },
            },
          },
        },
      },
      issuer,
    );

    expect(principal).toEqual({
      ownerId: '23963ab867f54f0f04d06c704b10e7acef9f35cbb75c50b7c7c61e6f93f5b9f1',
      scopes: ['architecture:read', 'architecture:plan'],
    });
  });

  it('aceita o claim OAuth scope separado por espaços', () => {
    const principal = principalFromApiGatewayJwt(
      {
        requestContext: {
          authorizer: {
            jwt: {
              claims: { iss: issuer, sub: 'alice', scope: 'architecture:read architecture:apply' },
            },
          },
        },
      },
      issuer,
    );

    expect(principal.scopes).toEqual(['architecture:read', 'architecture:apply']);
  });

  it('rejeita ausência de authorizer e emissor divergente', () => {
    expect(() => principalFromApiGatewayJwt({}, issuer)).toThrow(AuthenticationError);
    expect(() =>
      principalFromApiGatewayJwt(
        {
          requestContext: {
            authorizer: { jwt: { claims: { iss: 'https://other.example/', sub: 'alice' } } },
          },
        },
        issuer,
      ),
    ).toThrow('Emissor JWT');
  });

  it('rejeita o escopo que não foi concedido', () => {
    expect(() =>
      requireScope({ ownerId: 'owner', scopes: ['architecture:read'] }, 'architecture:apply'),
    ).toThrow(AuthorizationError);
  });
});
