# Evidências de validação

Data: 7 de setembro de 2026. Ambiente local: Windows, Node.js 24.19.0, npm 11.17.0.

## Primeira versão

- `npm run check`: aprovado, com typecheck, três bundles Lambda e 30 testes em sete arquivos no commit inicial.
- `npm run synth`: aprovado, com aviso esperado dos valores JWT usados exclusivamente para síntese offline.
- `npm run demo`: cliente e servidor oficiais confirmaram MCP `2026-07-28`, recusa de apply sem aprovação e repetição da mesma operação.
- Servidor HTTP local executado em loopback e acessado pelo cliente de exemplo; catálogo e plano foram retornados pelo transporte HTTP real.
- Aprovação pela CLI e apply pelo cliente HTTP terminaram em `SUCCEEDED`, explicitamente identificado como simulação local.
- Teste SQLite com dois processos concorrentes confirmou uma única operação para a mesma chave.

## Correções da auditoria inicial

- Tags SQS passaram para o formato CloudFormation correto; nomes físicos foram limitados para S3.
- Aprovações AWS passaram a registros imutáveis em partição separada, fora do alcance de escrita da role MCP.
- Permissões transacionais DynamoDB passaram a usar as ações constituintes e condições IAM apropriadas.
- Recuperação de criação CloudFormation passou a reconhecer token repetido e verificar a identidade da stack.
- Falhas parciais do stream passaram a usar sequence number; foram configurados destino SQS e permissão de envio.
- Erros de Step Functions passaram a preservar os IDs da operação; o acompanhamento ganhou um prazo explícito.
- HTTP passou a rejeitar streams não suportados, limitar corpo e evitar exposição de erros internos.

## Auditoria e evolução 0.2.0

- `npm run check`: aprovado com **37 testes em sete arquivos**, typecheck e três bundles Lambda.
- `npm run format:check`: aprovado.
- `npm run synth`: aprovado; o aviso JWT indica configuração de síntese offline.
- `npm run demo`: aprovado com seis ferramentas e MCP 2026-07-28.
- `cfn-lint 1.56.0`: dois blueprints aprovados sem supressões; infraestrutura CDK aprovada com exceção documentada de `W3005` para dependências de roles redundantes geradas pelo CDK.
- `npm audit --omit=dev`: nenhuma vulnerabilidade reportada nas dependências de execução na consulta realizada.
- `get_plan` e `validate_plan` acrescentaram recuperação entre sessões e prontidão local, incluindo testes de autorização e todos os estados relevantes.
- Smoke HTTP após reinício do servidor recuperou o plano previamente criado e identificou corretamente a operação já enfileirada.
- A auditoria posterior bloqueou um caminho de falsificação do estado `QUEUED`: o worker exige a aprovação persistida na partição separada, mesmo quando o item base afirma já estar enfileirado.
- As atualizações de operações ganharam controle de concorrência por revisão interna. Campos opcionais indefinidos são removidos na serialização DynamoDB.
- O relógio do worker é injetável: o teste de rollback confirma a consulta efetiva à CloudFormation, separado do teste de prazo excedido.
- As actions da CI foram fixadas por SHA e a validação CloudFormation foi incluída no pipeline.

## Limites da evidência

Não foram executados deploy, bootstrap, chamadas mutáveis AWS, testes com DynamoDB/Streams reais, autenticação real do provedor JWT ou provisionamento CloudFormation em conta sandbox. Testes dos adapters AWS usam clientes controlados. A síntese valida a montagem da infraestrutura, não prova a autorização IAM nem o comportamento real dos serviços.

Não houve benchmark, cálculo de custo nem teste de capacidade. O status de entrega é **implementado com validações AWS pendentes**.
