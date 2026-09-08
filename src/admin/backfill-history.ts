import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

interface Options {
  client: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  ownerId: string;
  write: boolean;
  maxPages?: number;
  after?: string;
}
export interface BackfillResult {
  dryRun: boolean;
  examined: number;
  updated: number;
  unchanged: number;
  nextAfter?: string;
}

/** Bounded, owner-scoped migration. Only the two derived index attributes are changed. */
export async function backfillHistory(options: Options): Promise<BackfillResult> {
  const maxPages = options.maxPages ?? 20;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(options.ownerId) ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  ) {
    throw new Error('Proprietário ou limite de páginas inválido.');
  }
  if (options.after && !/^(PLAN#pln-[0-9a-f-]{36}|OP#op-[0-9a-f]{48})$/i.test(options.after)) {
    throw new Error('Cursor administrativo inválido.');
  }
  const partition = `OWNER#${options.ownerId}`;
  let after = options.after;
  const result: BackfillResult = { dryRun: !options.write, examined: 0, updated: 0, unchanged: 0 };
  for (let page = 0; page < maxPages; page += 1) {
    const response = await options.client.send(
      new QueryCommand({
        TableName: options.tableName,
        KeyConditionExpression: '#pk = :owner',
        ExpressionAttributeNames: { '#pk': 'PK' },
        ExpressionAttributeValues: { ':owner': partition },
        ConsistentRead: true,
        Limit: 100,
        ...(after ? { ExclusiveStartKey: { PK: partition, SK: after } } : {}),
      }),
    );
    for (const item of response.Items ?? []) {
      const kind = item.kind;
      const validId = kind === 'plan' ? /^pln-[0-9a-f-]{36}$/i : /^op-[0-9a-f]{48}$/;
      if (
        (kind !== 'plan' && kind !== 'operation') ||
        item.PK !== partition ||
        item.ownerId !== options.ownerId ||
        typeof item.id !== 'string' ||
        !validId.test(item.id) ||
        item.SK !== `${kind === 'plan' ? 'PLAN' : 'OP'}#${item.id}` ||
        typeof item.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        new Date(item.createdAt).toISOString() !== item.createdAt
      ) {
        throw new Error(
          'Registro incompatível com o histórico; interrompido antes de alterar esse registro.',
        );
      }
      result.examined += 1;
      const timelinePK = `${partition}#${kind}`;
      const timelineSK = `${item.createdAt}#${item.id}`;
      if (item.timelinePK === timelinePK && item.timelineSK === timelineSK) {
        result.unchanged += 1;
        continue;
      }
      if (options.write) {
        await options.client.send(
          new UpdateCommand({
            TableName: options.tableName,
            Key: { PK: partition, SK: item.SK },
            UpdateExpression: 'SET #timelinePK = :timelinePK, #timelineSK = :timelineSK',
            ConditionExpression:
              '#id = :id AND #created = :created AND #kind = :kind AND #owner = :owner',
            ExpressionAttributeNames: {
              '#timelinePK': 'timelinePK',
              '#timelineSK': 'timelineSK',
              '#id': 'id',
              '#created': 'createdAt',
              '#kind': 'kind',
              '#owner': 'ownerId',
            },
            ExpressionAttributeValues: {
              ':timelinePK': timelinePK,
              ':timelineSK': timelineSK,
              ':id': item.id,
              ':created': item.createdAt,
              ':kind': kind,
              ':owner': options.ownerId,
            },
          }),
        );
      }
      result.updated += 1;
    }
    if (!response.LastEvaluatedKey) return result;
    if (
      response.LastEvaluatedKey.PK !== partition ||
      typeof response.LastEvaluatedKey.SK !== 'string' ||
      response.LastEvaluatedKey.SK === after
    ) {
      throw new Error('Paginação administrativa não avançou dentro do proprietário.');
    }
    after = response.LastEvaluatedKey.SK;
  }
  return { ...result, nextAfter: after };
}
