import { z } from 'zod';

import { DomainError, type Plan, type Principal, type Repository } from './contracts.js';
import { planDigest } from './repository-rules.js';

const planIdSchema = z.string().regex(/^pln-[0-9a-f-]{36}$/i, 'planId inválido');
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_TEMPLATE_DEPTH = 32;
const MAX_TEMPLATE_NODES = 5_000;
const MAX_DEFINITION_CHANGES = 20;
const MAX_PHYSICAL_RESOURCES = 20;

export const comparePlansInputSchema = z
  .object({ leftPlanId: planIdSchema, rightPlanId: planIdSchema })
  .strict();

export type DifferenceKind = 'ADDED' | 'REMOVED' | 'CHANGED';

export interface PlanComparison {
  before: { planId: string; digest: string; status: Plan['status']; integrity: boolean };
  after: { planId: string; digest: string; status: Plan['status']; integrity: boolean };
  /** Equal after removing only planner-generated identity values. */
  sameDefinition: boolean;
  changes: {
    inputs: Array<{
      field: 'name' | 'blueprint' | 'environment' | 'region';
      before: string;
      after: string;
    }>;
    definition: Array<{ path: string; kind: DifferenceKind }>;
    definitionChangesTruncated: boolean;
    physicalIdentity: {
      stack: { before: string; after: string; changed: boolean };
      resources: Array<{
        logicalId: string;
        property: 'BucketName' | 'QueueName' | 'TableName';
        before?: string;
        after?: string;
      }>;
      resourcesTruncated: boolean;
      /** True means definitions match but applying them would still create a different stack. */
      createsDistinctStack: boolean;
    };
  };
  warnings: string[];
}

export async function comparePlans(
  repository: Repository,
  principal: Principal,
  input: unknown,
): Promise<PlanComparison> {
  requireReadScope(principal);
  const parsed = comparePlansInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'Entrada inválida.');
  }

  const [before, after] = await Promise.all([
    readOwnedPlan(repository, principal.ownerId, parsed.data.leftPlanId),
    readOwnedPlan(repository, principal.ownerId, parsed.data.rightPlanId),
  ]);
  assertPlanBudget(before);
  assertPlanBudget(after);

  const beforeIntegrity = hasIntegrity(before);
  const afterIntegrity = hasIntegrity(after);
  const beforeDefinition = normalizeDefinition(before);
  const afterDefinition = normalizeDefinition(after);
  const collector = new DifferenceCollector(MAX_DEFINITION_CHANGES);
  diffValues(beforeDefinition, afterDefinition, '', collector);
  const inputChanges = compareInputs(before, after);
  const warnings = [
    ...(beforeIntegrity ? [] : ['O plano inicial tem digest incompatível com seu conteúdo.']),
    ...(afterIntegrity ? [] : ['O plano final tem digest incompatível com seu conteúdo.']),
  ];

  return {
    before: {
      planId: before.id,
      digest: before.digest,
      status: before.status,
      integrity: beforeIntegrity,
    },
    after: {
      planId: after.id,
      digest: after.digest,
      status: after.status,
      integrity: afterIntegrity,
    },
    sameDefinition: inputChanges.length === 0 && collector.total === 0,
    changes: {
      inputs: inputChanges,
      definition: collector.changes,
      definitionChangesTruncated: collector.total > collector.changes.length,
      physicalIdentity: physicalIdentity(
        before,
        after,
        inputChanges.length === 0 && collector.total === 0,
      ),
    },
    warnings,
  };
}

function requireReadScope(principal: Principal): void {
  if (!principal.scopes.includes('architecture:read')) {
    throw new DomainError('FORBIDDEN', 'Escopo obrigatório: architecture:read.');
  }
}

async function readOwnedPlan(
  repository: Repository,
  ownerId: string,
  planId: string,
): Promise<Plan> {
  const plan = await repository.getPlan(ownerId, planId);
  if (!plan || plan.ownerId !== ownerId || plan.id !== planId) {
    throw new DomainError('NOT_FOUND', 'Plano não encontrado.');
  }
  return plan;
}

function hasIntegrity(plan: Plan): boolean {
  try {
    return plan.digest === planDigest(plan);
  } catch {
    return false;
  }
}

function assertPlanBudget(plan: Plan): void {
  try {
    assertValueBudget({
      input: plan.input,
      region: plan.region,
      stackName: plan.stackName,
      template: plan.template,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'INVALID_INPUT',
      'O plano contém dados que não podem ser comparados com segurança.',
    );
  }
}

function assertValueBudget(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_TEMPLATE_NODES || depth > MAX_TEMPLATE_DEPTH) {
      throw new DomainError('INVALID_INPUT', 'O plano excede o limite seguro de complexidade.');
    }
    if (typeof current === 'string') {
      bytes += Buffer.byteLength(current, 'utf8');
      if (bytes > MAX_TEMPLATE_BYTES)
        throw new DomainError('INVALID_INPUT', 'O plano excede o limite seguro de tamanho.');
      return;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      if (typeof current === 'number' && !Number.isFinite(current)) {
        throw new DomainError('INVALID_INPUT', 'O plano contém um número inválido.');
      }
      return;
    }
    if (typeof current !== 'object') {
      throw new DomainError('INVALID_INPUT', 'O plano contém um valor não serializável.');
    }
    if (seen.has(current))
      throw new DomainError('INVALID_INPUT', 'O plano contém referência circular.');
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    ) {
      throw new DomainError('INVALID_INPUT', 'O plano contém um objeto não serializável.');
    }
    for (const [key, item] of Object.entries(current)) {
      bytes += Buffer.byteLength(key, 'utf8');
      if (bytes > MAX_TEMPLATE_BYTES)
        throw new DomainError('INVALID_INPUT', 'O plano excede o limite seguro de tamanho.');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function normalizeDefinition(plan: Plan): { stackName: unknown; template: unknown } {
  const template = structuredClone(plan.template) as Record<string, unknown>;
  const expected = expectedNames(plan);
  const stackName =
    plan.stackName === expected.stackName ? expected.normalizedStackName : plan.stackName;
  const resources = asRecord(template.Resources);
  if (resources) {
    for (const [logicalId, resource] of Object.entries(resources)) {
      const properties = asRecord(asRecord(resource)?.Properties);
      if (!properties) continue;
      normalizeResourceName(
        properties,
        'BucketName',
        expected.resourceNames[`${logicalId}:BucketName`],
      );
      normalizeResourceName(
        properties,
        'QueueName',
        expected.resourceNames[`${logicalId}:QueueName`],
      );
      normalizeResourceName(
        properties,
        'TableName',
        expected.resourceNames[`${logicalId}:TableName`],
      );
      normalizePlanTags(properties.Tags, plan.id);
    }
  }
  return { stackName, template };
}

function expectedNames(plan: Plan): {
  stackName: string;
  normalizedStackName: string;
  resourceNames: Record<string, string>;
} {
  const suffix = plan.id.replaceAll('-', '').slice(-20);
  const base = `camcp-${plan.input.name}-${suffix}`;
  return {
    stackName: `camcp-${plan.input.environment}-${plan.input.name}-${plan.id}`,
    normalizedStackName: `camcp-${plan.input.environment}-${plan.input.name}-<plan-id>`,
    resourceNames: {
      'StorageBucket:BucketName': base,
      'DeadLetterQueue:QueueName': `${base}-dlq`,
      'MainQueue:QueueName': `${base}-main`,
      'EventTable:TableName': `${base}-events`,
    },
  };
}

function normalizeResourceName(
  properties: Record<string, unknown>,
  property: 'BucketName' | 'QueueName' | 'TableName',
  expected: string | undefined,
): void {
  if (expected && properties[property] === expected) properties[property] = '<plan-suffix>';
}

function normalizePlanTags(value: unknown, planId: string): void {
  if (!Array.isArray(value)) return;
  for (const tag of value) {
    const record = asRecord(tag);
    if (record?.Key === 'camcp:planId' && record.Value === planId) record.Value = '<plan-id>';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compareInputs(before: Plan, after: Plan): PlanComparison['changes']['inputs'] {
  const values: Array<{
    field: 'name' | 'blueprint' | 'environment' | 'region';
    before: string;
    after: string;
  }> = [
    { field: 'name', before: before.input.name, after: after.input.name },
    { field: 'blueprint', before: before.input.blueprint, after: after.input.blueprint },
    { field: 'environment', before: before.input.environment, after: after.input.environment },
    { field: 'region', before: before.region, after: after.region },
  ];
  return values.filter((value) => value.before !== value.after);
}

function physicalIdentity(
  before: Plan,
  after: Plan,
  sameDefinition: boolean,
): PlanComparison['changes']['physicalIdentity'] {
  const resources = new Map<
    string,
    {
      logicalId: string;
      property: 'BucketName' | 'QueueName' | 'TableName';
      before?: string;
      after?: string;
    }
  >();
  for (const [logicalId, property, value] of physicalNames(before)) {
    resources.set(`${logicalId}\u0000${property}`, { logicalId, property, before: value });
  }
  for (const [logicalId, property, value] of physicalNames(after)) {
    const key = `${logicalId}\u0000${property}`;
    const current = resources.get(key);
    resources.set(
      key,
      current ? { ...current, after: value } : { logicalId, property, after: value },
    );
  }
  const all = [...resources.values()].sort((left, right) =>
    `${left.logicalId}:${left.property}`.localeCompare(`${right.logicalId}:${right.property}`),
  );
  const stack = {
    before: before.stackName,
    after: after.stackName,
    changed: before.stackName !== after.stackName,
  };
  return {
    stack,
    resources: all.slice(0, MAX_PHYSICAL_RESOURCES),
    resourcesTruncated: all.length > MAX_PHYSICAL_RESOURCES,
    createsDistinctStack: sameDefinition && stack.changed,
  };
}

function physicalNames(
  plan: Plan,
): Array<[string, 'BucketName' | 'QueueName' | 'TableName', string]> {
  const result: Array<[string, 'BucketName' | 'QueueName' | 'TableName', string]> = [];
  const resources = asRecord(plan.template.Resources);
  if (!resources) return result;
  for (const logicalId of Object.keys(resources).sort()) {
    const properties = asRecord(asRecord(resources[logicalId])?.Properties);
    if (!properties) continue;
    for (const property of ['BucketName', 'QueueName', 'TableName'] as const) {
      if (typeof properties[property] === 'string')
        result.push([logicalId, property, properties[property]]);
    }
  }
  return result;
}

class DifferenceCollector {
  readonly changes: Array<{ path: string; kind: DifferenceKind }> = [];
  total = 0;

  constructor(private readonly limit: number) {}

  add(path: string, kind: DifferenceKind): void {
    this.total += 1;
    if (this.changes.length < this.limit) this.changes.push({ path: path || '/', kind });
  }
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  collector: DifferenceCollector,
): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const nextPath = `${path}/${index}`;
      if (index >= before.length) collector.add(nextPath, 'ADDED');
      else if (index >= after.length) collector.add(nextPath, 'REMOVED');
      else diffValues(before[index], after[index], nextPath, collector);
    }
    return;
  }
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);
  if (beforeRecord && afterRecord) {
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
    for (const key of keys) {
      const nextPath = `${path}/${escapePointer(key)}`;
      if (!(key in beforeRecord)) collector.add(nextPath, 'ADDED');
      else if (!(key in afterRecord)) collector.add(nextPath, 'REMOVED');
      else diffValues(beforeRecord[key], afterRecord[key], nextPath, collector);
    }
    return;
  }
  collector.add(path, 'CHANGED');
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}
