# Evidências de validação

Data: 7 de setembro de 2026. Ambiente local: Windows, Node.js 24.19.0, npm 11.17.0.

## Primeira versão

- `npm run check`: aprovado, com typecheck, três bundles Lambda e 27 testes em seis arquivos.
- `npm run synth`: aprovado, com aviso esperado dos valores JWT usados exclusivamente para síntese offline.
- `npm run demo`: cliente e servidor oficiais confirmaram MCP `2026-07-28`, recusa de apply sem aprovação e repetição da mesma operação.
- Servidor HTTP local executado em loopback e acessado pelo cliente de exemplo; catálogo e plano foram retornados pelo transporte HTTP real.
- Teste SQLite com dois processos concorrentes confirmou uma única operação para a mesma chave.

## Correções da auditoria inicial

- Tags SQS passaram para o formato CloudFormation correto; nomes físicos foram limitados para S3.
- Aprovações AWS passaram a registros imutáveis em partição separada, fora do alcance de escrita da role MCP.
- Permissões transacionais DynamoDB passaram a usar as ações constituintes e condições IAM apropriadas.
- Recuperação de criação CloudFormation passou a reconhecer token repetido e verificar a identidade da stack.
- Falhas parciais do stream passaram a usar sequence number; foram configurados destino SQS e permissão de envio.
- Erros de Step Functions passaram a preservar os IDs da operação; o acompanhamento ganhou um prazo explícito.
- HTTP passou a rejeitar streams não suportados, limitar corpo e evitar exposição de erros internos.

## Limites da evidência

Não foram executados deploy, bootstrap, chamadas mutáveis AWS, testes com DynamoDB/Streams reais, autenticação real do provedor JWT ou provisionamento CloudFormation em conta sandbox. Testes dos adapters AWS usam clientes controlados. A síntese valida a montagem da infraestrutura, não prova a autorização IAM nem o comportamento real dos serviços.

Não houve benchmark, cálculo de custo nem teste de capacidade. O status de entrega é **implementado com validações AWS pendentes**.
