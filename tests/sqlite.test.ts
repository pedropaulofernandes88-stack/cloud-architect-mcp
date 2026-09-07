import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import { ArchitectureService } from '../src/domain/service.js';
import { LOCAL_PRINCIPAL } from '../src/local-config.js';

const root = resolve('.local');
const directories: string[] = [];
const repositories: SqliteRepository[] = [];
const children: ChildProcess[] = [];
function storePath(): string {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'test-sqlite-'));
  directories.push(directory);
  return join(directory, 'state.db');
}
function connect(path: string): SqliteRepository {
  const repository = new SqliteRepository(path);
  repositories.push(repository);
  return repository;
}
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== root) throw new Error('Cleanup fora da área de teste.');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Persistência SQLite real', () => {
  it('aprovação por outra conexão, replay e isolamento sobrevivem à troca de instância', async () => {
    const path = storePath();
    const repository = connect(path);
    const service = new ArchitectureService(repository, { region: 'us-east-1' });
    const plan = await service.plan(LOCAL_PRINCIPAL, {
      name: 'test-data',
      blueprint: 'storage',
      environment: 'dev',
    });
    const admin = connect(path);
    await admin.approvePlan(
      plan.ownerId,
      plan.id,
      plan.digest,
      'operator',
      new Date().toISOString(),
    );
    const replacement = new ArchitectureService(connect(path), { region: 'us-east-1' });
    const input = { planId: plan.id, digest: plan.digest, idempotencyKey: 'restart-key' };
    const operation = await replacement.apply(LOCAL_PRINCIPAL, input);
    await expect(service.apply(LOCAL_PRINCIPAL, input)).resolves.toMatchObject({
      id: operation.id,
    });
    await expect(
      service.status(
        { ...LOCAL_PRINCIPAL, ownerId: 'another-owner' },
        { operationId: operation.id },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repository.putPlan(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      replacement.apply(LOCAL_PRINCIPAL, { ...input, idempotencyKey: 'different' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('dois processos disputando o mesmo comando produzem uma só operação', async () => {
    const path = storePath();
    const repository = connect(path);
    const service = new ArchitectureService(repository, { region: 'us-east-1' });
    const plan = await service.plan(LOCAL_PRINCIPAL, {
      name: 'test-race',
      blueprint: 'storage',
      environment: 'dev',
    });
    await repository.approvePlan(
      plan.ownerId,
      plan.id,
      plan.digest,
      'operator',
      new Date().toISOString(),
    );
    const payload = {
      path,
      owner: plan.ownerId,
      planId: plan.id,
      digest: plan.digest,
      key: 'simultaneous',
    };
    const runners = [0, 1].map(() => {
      const child = fork(fileURLToPath(new URL('./fixtures/sqlite-apply.ts', import.meta.url)), {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      });
      children.push(child);
      let output = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const ready = new Promise<void>((resolveReady, reject) => {
        child.once('error', reject);
        child.once('message', (message: { ready?: boolean }) =>
          message.ready ? resolveReady() : reject(new Error('Worker não pronto.')),
        );
      });
      const result = new Promise<string>((resolveResult, reject) => {
        child.on('message', (message: { id?: string; error?: string }) => {
          if (message.id) resolveResult(message.id);
          if (message.error) reject(new Error(message.error));
        });
        child.once('exit', (code) => {
          if (code) reject(new Error(output || `Worker exit ${code}`));
        });
      });
      return { child, ready, result };
    });
    await Promise.all(runners.map((runner) => runner.ready));
    for (const runner of runners) runner.child.send(payload);
    const ids = await Promise.all(runners.map((runner) => runner.result));
    expect(new Set(ids).size).toBe(1);
    expect(repository.pendingOperations()).toHaveLength(1);
  }, 15_000);
});
