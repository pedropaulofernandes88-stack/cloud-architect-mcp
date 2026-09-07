import { z } from 'zod';

export const architectureInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]{2,19}$/, 'name deve ser um slug minúsculo de 3 a 20 caracteres'),
    blueprint: z.enum(['storage', 'event-backbone']),
    environment: z.enum(['dev', 'staging', 'prod']),
  })
  .strict();

export const applyInputSchema = z
  .object({
    planId: z.string().regex(/^pln-[0-9a-f-]{36}$/i, 'planId inválido'),
    digest: z.string().regex(/^[a-f0-9]{64}$/, 'digest SHA-256 inválido'),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

export const getPlanInputSchema = z
  .object({
    planId: z.string().regex(/^pln-[0-9a-f-]{36}$/i, 'planId inválido'),
  })
  .strict();

export const statusInputSchema = z
  .object({
    operationId: z.string().regex(/^op-[a-f0-9]{48}$/, 'operationId inválido'),
  })
  .strict();

export type ArchitectureInputValue = z.infer<typeof architectureInputSchema>;
