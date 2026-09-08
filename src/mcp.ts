import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Principal } from './domain/contracts.js';
import { DomainError } from './domain/contracts.js';
import { ArchitectureService } from './domain/service.js';
import { historyInputSchema } from './domain/history.js';
import { comparePlansInputSchema } from './domain/comparison.js';
import {
  applyInputSchema,
  architectureInputSchema,
  getPlanInputSchema,
  statusInputSchema,
} from './domain/schemas.js';

const serverInfo = { name: 'cloud-architect-mcp', version: '0.3.0' };

export function createMcpEndpoint(service: ArchitectureService, principal: Principal) {
  return createMcpHandler(
    () => {
      const server = new McpServer(serverInfo);

      server.registerTool(
        'list_blueprints',
        {
          title: 'Listar arquiteturas disponíveis',
          description: 'Lista os blueprints de arquitetura de nuvem suportados.',
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async () => execute(() => service.catalog(principal)),
      );

      server.registerTool(
        'plan_architecture',
        {
          title: 'Planejar arquitetura',
          description:
            'Gera e persiste um plano de arquitetura. A aprovação não é realizada por esta ferramenta.',
          inputSchema: architectureInputSchema,
        },
        async (input) => execute(() => service.plan(principal, input)),
      );

      server.registerTool(
        'get_plan',
        {
          title: 'Consultar plano',
          description: 'Recupera um plano de arquitetura pertencente ao solicitante.',
          inputSchema: getPlanInputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.getPlan(principal, input)),
      );

      server.registerTool(
        'list_plans',
        {
          title: 'Histórico de planos',
          description:
            'Lista seus planos do mais recente ao mais antigo, em páginas de até 50 registros. Use nextCursor para continuar. Na AWS, novos registros podem levar alguns instantes para aparecer no índice.',
          inputSchema: historyInputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.listPlans(principal, input)),
      );

      server.registerTool(
        'list_operations',
        {
          title: 'Histórico de operações',
          description:
            'Lista suas operações por data de criação, em páginas, incluindo as que precisam de atenção. Consulte get_operation para acompanhar uma operação específica.',
          inputSchema: historyInputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.listOperations(principal, input)),
      );

      server.registerTool(
        'compare_plans',
        {
          title: 'Comparar propostas de arquitetura',
          description:
            'Compara duas propostas suas. Separa mudanças da arquitetura dos nomes gerados automaticamente. É uma comparação de planos para revisão, não um CloudFormation change set nem uma atualização de recursos existentes.',
          inputSchema: comparePlansInputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.comparePlans(principal, input)),
      );

      server.registerTool(
        'validate_plan',
        {
          title: 'Validar prontidão local do plano',
          description:
            'Verifica localmente integridade, expiração, aprovação administrativa e fila. Não comprova disponibilidade do provedor, permissões IAM ou custo.',
          inputSchema: getPlanInputSchema,
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.validatePlan(principal, input)),
      );

      server.registerTool(
        'apply_architecture',
        {
          title: 'Enfileirar arquitetura aprovada',
          description:
            'Enfileira a execução de um plano previamente aprovado, vinculada ao digest e à chave de idempotência.',
          inputSchema: applyInputSchema,
          annotations: { destructiveHint: true, idempotentHint: true },
        },
        async (input) => execute(() => service.apply(principal, input)),
      );

      server.registerTool(
        'get_operation',
        {
          title: 'Consultar operação',
          description: 'Consulta o status de uma operação de provisionamento.',
          inputSchema: statusInputSchema,
          annotations: { readOnlyHint: true },
        },
        async (input) => execute(() => service.status(principal, input)),
      );

      return server;
    },
    { legacy: 'reject', responseMode: 'json' },
  );
}

async function execute(operation: () => Promise<unknown> | unknown) {
  try {
    const result = await operation();
    return {
      content: [{ type: 'text' as const, text: toText(result) }],
      structuredContent: result,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: publicErrorMessage(error) }],
      isError: true,
    };
  }
}

function toText(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  console.error(
    JSON.stringify({
      event: 'mcp_tool_failure',
      type: error instanceof Error ? error.name : 'Unknown',
    }),
  );
  return 'Erro interno ao processar a operação.';
}
