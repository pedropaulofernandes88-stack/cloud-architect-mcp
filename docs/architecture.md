# Decisões de arquitetura

## Recorte inicial

O primeiro produto entrega arquiteturas conhecidas como templates completos, com parâmetros validados. O cliente MCP pode ser um agente, uma interface de desenvolvimento ou o cliente de exemplo. O servidor não executa código fornecido pelo modelo.

Node.js 24 e TypeScript permitem compartilhar o domínio entre Lambda e execução local. O SDK `@modelcontextprotocol/server@2.0.0` implementa o protocolo; não existe implementação JSON-RPC artesanal. `createMcpHandler` cria o contexto de servidor por requisição, com `legacy: reject` e respostas JSON.

## Plano e operação

Um plano contém parâmetros, região, nome da stack, template, digest, proprietário e validade. O digest usa JSON canônico e cobre os dados que determinam os recursos. A aprovação verifica novamente essa integridade. Alterações exigem um novo plano e uma nova aprovação.

A chave de idempotência identifica um comando do proprietário. Reutilizá-la para outro plano ou digest é conflito. Um plano só gera uma operação, mesmo com duas chaves diferentes disputando simultaneamente. IDs de requisição JSON-RPC não são chaves de idempotência.

Estados do plano: `PLANNED → APPROVED → QUEUED`.

Estados da operação: `PENDING → RUNNING → SUCCEEDED | FAILED`. Falha também pode ocorrer antes de iniciar. Resultados terminais não podem ser reabertos pela repetição de uma mensagem. Uma falha da orquestração não prova que todos os recursos foram removidos: confirme sempre a situação da stack.

## Identidade e aprovação

Em produção, o API Gateway valida assinatura, emissor, audiência e validade do JWT. O adapter usa somente as claims fornecidas pelo authorizer confiável; não interpreta `clientInfo` nem um header de proprietário como identidade. O proprietário é derivado de emissor e subject. A aplicação valida o escopo da ferramenta e usa o proprietário em todas as leituras e alterações.

A aprovação não é uma ferramenta MCP. O operador revisa o template e usa uma identidade IAM administrativa na CLI; o registro inclui o ARN retornado por STS. O domínio comum exige o digest aprovado. Na AWS, a política de escrita da Lambda MCP não deve alcançar os registros de aprovação. A CLI local é uma conveniência para um único desenvolvedor, não uma separação entre usuários hostis no mesmo computador.

## Execução e falhas

Na AWS, a transação que aceita o plano também cria a operação. DynamoDB Streams aciona o dispatcher; não há promessa de continuar uma tarefa dentro de uma Lambda depois de retornar. Step Functions mantém a espera e invoca workers curtos para iniciar e consultar CloudFormation.

A execução Standard tem nome determinístico. Uma repetição do início reconhece a execução existente. O worker usa o ID da operação como `ClientRequestToken`, verifica a identidade da stack ao recuperar uma criação e só considera `CREATE_COMPLETE` um sucesso.

O repositório é retido e tem PITR. Falhas de entrega do stream possuem destino SQS e alarme. Isso não é entrega ilimitada: mensagens, streams e histórico dos serviços têm retenção finita, e a recuperação precisa ser acompanhada por um operador.

## Matriz de verificação

| Invariante                                   | Controle                                                 | Evidência local                                         | Limite                                    |
| -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| Um usuário não vê planos/operações de outro  | Chave por proprietário e scopes no serviço               | Testes negativos de domínio/protocolo/SQLite            | Authorizer e IAM precisam de sandbox      |
| Não executar sem aprovação do template exato | Digest e aprovação administrativa                        | Aprovação ausente, expirada e template adulterado       | Separação IAM exige validação AWS         |
| Repetir não cria segunda operação            | Transação, chave determinística e vínculo plano/operação | Concorrência SQLite entre processos e testes de adapter | Concorrência DynamoDB real ainda pendente |
| Trocar instância não perde estado            | Banco e outbox duráveis                                  | SQLite entre conexões e reinício                        | Streams reais ainda pendentes             |
| Não prender Lambda durante provisionamento   | Workers curtos e Step Functions                          | Build/synth e respostas controladas CloudFormation      | Duração e quotas reais não medidas        |
| Não vazar erros internos ao cliente          | Mensagem pública genérica e logs sem corpo/token         | Teste de falha de dependência                           | Revisão operacional de logs pendente      |

## Consequências

O catálogo pequeno restringe o impacto e permite revisar IAM por tipo de recurso. Expandir para VPC, Lambda de aplicação, bancos relacionais ou múltiplas contas exige acrescentar blueprint, permissões mínimas e testes de contrato do provedor.

Não há estimativas de economia, throughput, disponibilidade ou latência de produção. Custos incluem HTTP API, Lambdas, DynamoDB, Step Functions, logs e os recursos provisionados. Retenção deliberada requer procedimento de limpeza autorizado.
