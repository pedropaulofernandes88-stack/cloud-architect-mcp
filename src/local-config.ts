import { resolve } from 'node:path';
import type { Principal } from './domain/contracts.js';

export const LOCAL_PRINCIPAL: Principal = {
  ownerId: 'local-developer',
  scopes: ['architecture:read', 'architecture:plan', 'architecture:apply'],
};
export function localDatabasePath(): string {
  return resolve(process.env.LOCAL_DB ?? '.local/architect.db');
}
