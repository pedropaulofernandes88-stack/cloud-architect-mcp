# Implantação e operação

Nenhum comando mutável AWS é executado pelo build, pelos testes ou pela síntese. Os passos abaixo são para uma futura implantação autorizada, inicialmente em conta sandbox.

## Pré-requisitos

- Node.js 24.x e dependências de `npm ci`.
- Conta e região AWS escolhidas explicitamente.
- Credenciais temporárias para bootstrap/deploy via perfil ou SSO; não grave chaves no repositório.
- Emissor JWT HTTPS com JWKS e audiência configurada. Tokens de acesso devem conter `sub`, `iss` e os scopes `architecture:read`, `architecture:plan` e/ou `architecture:apply`.
- Cliente MCP compatível com 2026-07-28. O cliente de exemplo aceita um bearer token existente; o projeto não cria um servidor de autorização.

## Preparar a infraestrutura

Inspecione os artefatos primeiro:

```sh
npm ci
npm run check
npm run synth
```

Os valores de `example.invalid` na configuração permitem sintetizar offline. Eles não constituem uma configuração funcional de autenticação. Para preparar um template utilizável, substitua os valores pelo emissor e pela audiência reais:

```sh
npm run synth -- -c jwtIssuer=https://SEU-EMISSOR -c jwtAudience=SUA-AUDIENCIA
```

Após autorização para alterar a conta, use o CDK com o perfil, conta e região previstos:

```sh
npx cdk bootstrap aws://CONTA/REGIAO --profile PERFIL
npx cdk deploy -c jwtIssuer=https://SEU-EMISSOR -c jwtAudience=SUA-AUDIENCIA --profile PERFIL
```

Verifique o diff do CDK e os papéis antes de confirmar. Use os outputs da stack para obter endpoint, tabela, workflow e fila de recuperação. Configure destinatários para os alarmes; criar um alarme sozinho não entrega notificações a uma equipe.

## Aprovar um plano AWS

O plano retornado por `plan_architecture` inclui seu `ownerId`. Esse identificador deve ser tratado como chave de recurso, não como credencial. O revisor utiliza a CLI em uma sessão com identidade IAM própria e permissões específicas para ler planos e registrar aprovações.

Configure `TABLE_NAME` e `AWS_REGION` no terminal administrativo. Depois:

```sh
npm run inspect -- --aws --owner <ownerId> --plan <planId>
npm run approve -- --aws --owner <ownerId> --plan <planId> --digest <sha256>
```

A CLI registra a identidade STS e valida o digest. O cliente MCP usa `apply_architecture` apenas depois disso. Não dê ao cliente as credenciais IAM do revisor.

Para o cliente de exemplo, configure `MCP_URL` com o endpoint HTTPS e `MCP_ACCESS_TOKEN` com um token de acesso válido no ambiente do processo. Ele não imprime o token. Não use o token de identidade OIDC como substituto de um token de acesso com scopes.

```sh
npm run client -- --tool list_blueprints
npm run client -- --tool plan_architecture --input examples/plan-storage.json
```

## Recuperação

Uma operação `NEEDS_ATTENTION` requer consulta ao estado real da stack; o status não significa rollback concluído. O reconciler EventBridge faz essa consulta para eventos de execuções `FAILED`, `TIMED_OUT` ou `ABORTED`, após validar a execução no serviço Step Functions. Como a entrega é de melhor esforço, use a CLI quando necessário:

```sh
npm run reconcile -- --aws --owner <ownerId> --operation <operationId>
```

Configure `TABLE_NAME` e `AWS_REGION` e use uma identidade IAM administrativa com acesso de leitura aos planos/aprovações, leitura e escrita das operações e `cloudformation:DescribeStacks` nas stacks `camcp-*`. O comando verifica a identidade STS, consulta a stack e atualiza apenas o acompanhamento. Não chama `CreateStack`, não faz replay do dispatcher e não apaga recursos. Estados terminais não são reabertos.

1. Consulte a operação por ID e a stack CloudFormation antes de repetir qualquer efeito.
2. Se a operação estiver pendente, confira o stream, os erros do dispatcher e a fila de recuperação. A falha de entrega não significa recusa do plano.
3. Se a execução já existe, acompanhe seu estado. O nome é o ID determinístico da operação; reenvios não devem criar outro nome.
4. Se houve falha/timeout após um pedido CloudFormation, confira `camcp:operationId` e eventos da stack. Recursos podem ter sido criados ou retidos. Não declare rollback completo só pelo status `FAILED` da operação.
5. Faça replay de entrega apenas após identificar a causa. Não altere a chave de idempotência para contornar um erro.

O destino SQS de uma falha de stream pode conter metadados sobre o lote, e a retenção do stream é limitada. Preserve a operação no banco; reconstrua a entrada `{ownerId, operationId}` verificada quando necessário. Reexecuções manuais e limpeza de recursos são ações administrativas com autorização própria.

Não existe varredura periódica de operações paradas nesta versão. Uma falha de entrega antes de `StartExecution` pode deixar a operação pendente até intervenção do operador. Reconciliação sem stack encontrada registra a incerteza e não autoriza novo provisionamento.

## Migrar o histórico de 0.2 para 0.3

Instalações novas já gravam os atributos do GSI `Timeline`. Em uma atualização, implante o índice e aguarde seu estado `ACTIVE`. SQLite cria o índice local ao abrir o banco e inclui os registros existentes automaticamente.

Na AWS, a migração é explícita por proprietário. Ela consulta a partição base com leitura consistente, sem `Scan`, e adiciona somente `timelinePK` e `timelineSK`. Primeiro inspecione a simulação:

```sh
npm run backfill:history -- --owner <ownerId> --max-pages 20
```

Após revisar o resultado, a opção `--write` grava os dois atributos derivados. O operador precisa de `dynamodb:Query` e `dynamodb:UpdateItem` na partição correspondente, além de identidade STS válida:

```sh
npm run backfill:history -- --owner <ownerId> --max-pages 20 --write
```

Se o resultado incluir `nextAfter`, continue com `--after <nextAfter>`. Cada página lê até 100 itens; o máximo permitido é 100 páginas por chamada. É seguro repetir uma execução: itens já indexados são contados como inalterados. A migração não modifica digests, aprovações ou estados e não torna um plano antigo válido novamente. Execute para cada proprietário conhecido e aguarde a propagação do GSI antes de conferir as listas.

## Validação em sandbox antes de produção

- Exercite acesso sem token, emissor/audiência errados, scopes ausentes e dois proprietários distintos.
- Confirme que a role da Lambda MCP não pode criar aprovações, passar a role CloudFormation nem chamar `CreateStack` diretamente.
- Execute os dois blueprints com plano revisado, aprovação CLI e acompanhamento até `CREATE_COMPLETE`.
- Repita o mesmo apply e a entrega do stream; confira uma única operação/stack.
- Simule resposta perdida no início, throttling, falha CloudFormation e entrega à fila de recuperação.
- Verifique custos, retenção, logs, alarmes e procedimento de limpeza aprovado.

Estes testes dependem de uma conta real e não são substituídos pela síntese CDK ou por mocks do SDK.
