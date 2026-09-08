import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  DomainError,
  type Operation,
  type Plan,
  type Principal,
  type Repository,
} from './contracts.js';

const defaultLimit = 20;
const maxLimit = 50;
const maxCursorBytes = 1024;
const cursorVersion = 1;

type HistoryKind = 'plan' | 'operation';
type Cursor = { v: 1; k: HistoryKind; s: string; p: string };

export type PlanHistoryItem = Omit<Plan, 'ownerId' | 'template'>;
export type OperationHistoryItem = Omit<Operation, 'ownerId' | 'outputs'>;

export const historyInputSchema = z
  .object({
    limit: z.number().int().min(1).max(maxLimit).optional(),
    cursor: z.string().min(1).max(maxCursorBytes).optional(),
  })
  .strict();

export async function listPlans(
  repository: Repository,
  principal: Principal,
  input: unknown,
): Promise<{ items: PlanHistoryItem[]; nextCursor?: string }> {
  const query = parseQuery(principal, input, 'plan');
  const page = await repository.listPlans(principal.ownerId, query);
  return {
    items: page.items.map(planSummary),
    ...(page.nextPosition
      ? { nextCursor: encodeCursor('plan', principal.ownerId, page.nextPosition) }
      : {}),
  };
}

export async function listOperations(
  repository: Repository,
  principal: Principal,
  input: unknown,
): Promise<{ items: OperationHistoryItem[]; nextCursor?: string }> {
  const query = parseQuery(principal, input, 'operation');
  const page = await repository.listOperations(principal.ownerId, query);
  return {
    items: page.items.map(operationSummary),
    ...(page.nextPosition
      ? { nextCursor: encodeCursor('operation', principal.ownerId, page.nextPosition) }
      : {}),
  };
}

function parseQuery(
  principal: Principal,
  input: unknown,
  kind: HistoryKind,
): { limit: number; before?: string } {
  requireReadScope(principal);
  const parsed = historyInputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Entrada inválida.');
  const before = parsed.data.cursor
    ? decodeCursor(parsed.data.cursor, kind, principal.ownerId)
    : undefined;
  return { limit: parsed.data.limit ?? defaultLimit, ...(before ? { before } : {}) };
}

function requireReadScope(principal: Principal): void {
  if (!principal.scopes.includes('architecture:read'))
    throw new DomainError('FORBIDDEN', 'Escopo obrigatório: architecture:read.');
}

function encodeCursor(kind: HistoryKind, ownerId: string, position: string): string {
  return Buffer.from(
    JSON.stringify({
      v: cursorVersion,
      k: kind,
      s: ownerScope(ownerId),
      p: position,
    } satisfies Cursor),
  ).toString('base64url');
}

function decodeCursor(cursor: string, kind: HistoryKind, ownerId: string): string {
  if (Buffer.byteLength(cursor, 'utf8') > maxCursorBytes || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new DomainError('INVALID_INPUT', 'Cursor inválido.');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError('INVALID_INPUT', 'Cursor inválido.');
  }
  if (
    !isCursor(value) ||
    value.v !== cursorVersion ||
    value.k !== kind ||
    value.s !== ownerScope(ownerId)
  )
    throw new DomainError('INVALID_INPUT', 'Cursor inválido para esta consulta.');
  if (!isPosition(value.p)) throw new DomainError('INVALID_INPUT', 'Cursor inválido.');
  return value.p;
}

function isCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    typeof record.v === 'number' &&
    (record.k === 'plan' || record.k === 'operation') &&
    typeof record.s === 'string' &&
    typeof record.p === 'string'
  );
}

function isPosition(position: string): boolean {
  const separator = position.lastIndexOf('#');
  if (separator <= 0 || separator === position.length - 1 || position.length > 512) return false;
  return Number.isFinite(Date.parse(position.slice(0, separator)));
}

function ownerScope(ownerId: string): string {
  return createHash('sha256').update(ownerId, 'utf8').digest('base64url');
}

function planSummary(plan: Plan): PlanHistoryItem {
  const { ownerId: _ownerId, template: _template, ...summary } = plan;
  return summary;
}

function operationSummary(operation: Operation): OperationHistoryItem {
  const { ownerId: _ownerId, outputs: _outputs, ...summary } = operation;
  return summary;
}
