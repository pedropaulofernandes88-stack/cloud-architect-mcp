import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DomainError,
  type Plan,
  type HistoryPage,
  type HistoryQuery,
  type Operation,
  type OperationUpdate,
  type Repository,
} from '../domain/contracts.js';
import { approve, enqueue, operationId, applyOperationUpdate } from '../domain/repository-rules.js';

/** Local durable store. Transactions also coordinate the server and approval CLI. */
export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (owner, kind, id)
      );
      CREATE INDEX IF NOT EXISTS records_history_idx
      ON records(owner, kind, (json_extract(payload, '$.createdAt') || '#' || id) DESC);`);
  }

  close(): void {
    this.db.close();
  }

  private read<T>(owner: string, kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT payload FROM records WHERE owner = ? AND kind = ? AND id = ?')
      .get(owner, kind, id);
    return row ? (JSON.parse(String(row.payload)) as T) : undefined;
  }

  private write(owner: string, kind: string, id: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO records (owner,kind,id,payload) VALUES (?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET payload = excluded.payload',
      )
      .run(owner, kind, id, JSON.stringify(value));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async putPlan(plan: Plan): Promise<void> {
    this.transaction(() => {
      if (this.read(plan.ownerId, 'plan', plan.id))
        throw new DomainError('CONFLICT', 'Plano já existe.');
      this.write(plan.ownerId, 'plan', plan.id, plan);
    });
  }

  async getPlan(owner: string, id: string): Promise<Plan | undefined> {
    return this.read<Plan>(owner, 'plan', id);
  }

  async listPlans(owner: string, query: HistoryQuery): Promise<HistoryPage<Plan>> {
    return this.history<Plan>(owner, 'plan', query);
  }

  async listOperations(owner: string, query: HistoryQuery): Promise<HistoryPage<Operation>> {
    return this.history<Operation>(owner, 'operation', query);
  }

  async approvePlan(
    owner: string,
    id: string,
    digest: string,
    reviewer: string,
    at: string,
  ): Promise<Plan> {
    return this.transaction(() => {
      const plan = this.read<Plan>(owner, 'plan', id);
      if (!plan) throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
      const approved = approve(plan, digest, reviewer, at);
      this.write(owner, 'plan', id, approved);
      return approved;
    });
  }

  async enqueueOperation(
    owner: string,
    planId: string,
    digest: string,
    key: string,
    at: string,
  ): Promise<Operation> {
    return this.transaction(() => {
      const result = enqueue(
        this.read<Plan>(owner, 'plan', planId),
        this.read<Operation>(owner, 'operation', operationId(owner, key)),
        owner,
        planId,
        digest,
        key,
        at,
      );
      if (!result.replay) {
        this.write(owner, 'plan', planId, result.plan);
        this.write(owner, 'operation', result.operation.id, result.operation);
      }
      return result.operation;
    });
  }

  async getOperation(owner: string, id: string): Promise<Operation | undefined> {
    return this.read<Operation>(owner, 'operation', id);
  }

  async updateOperation(owner: string, id: string, update: OperationUpdate): Promise<void> {
    this.transaction(() => {
      const operation = this.read<Operation>(owner, 'operation', id);
      if (!operation) throw new DomainError('NOT_FOUND', 'Operação não encontrada.');
      this.write(owner, 'operation', id, applyOperationUpdate(operation, update));
    });
  }

  pendingOperations(): Operation[] {
    return this.db
      .prepare(
        "SELECT payload FROM records WHERE kind = 'operation' AND json_extract(payload, '$.status') IN ('PENDING','RUNNING') ORDER BY id LIMIT 100",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as Operation);
  }

  private history<T extends { id: string; createdAt: string }>(
    owner: string,
    kind: 'plan' | 'operation',
    query: HistoryQuery,
  ): HistoryPage<T> {
    const position = "json_extract(payload, '$.createdAt') || '#' || id";
    const rows = query.before
      ? this.db
          .prepare(
            `SELECT payload, ${position} AS position FROM records
             WHERE owner = ? AND kind = ? AND ${position} < ?
             ORDER BY ${position} DESC LIMIT ?`,
          )
          .all(owner, kind, query.before, query.limit + 1)
      : this.db
          .prepare(
            `SELECT payload, ${position} AS position FROM records
             WHERE owner = ? AND kind = ?
             ORDER BY ${position} DESC LIMIT ?`,
          )
          .all(owner, kind, query.limit + 1);
    const hasNext = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => JSON.parse(String(row.payload)) as T),
      ...(hasNext && last ? { nextPosition: String(last.position) } : {}),
    };
  }
}
