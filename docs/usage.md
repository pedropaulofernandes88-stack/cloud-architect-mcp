# O que a ferramenta faz e como usar

O Cloud Architect MCP permite que um agente de IA monte uma proposta de infraestrutura AWS, mostre exatamente quais recursos serão criados e acompanhe a implantação após a aprovação de um operador.

## Um exemplo concreto

Você pede ao agente conectado: “Preciso de armazenamento privado e versionado para os documentos do meu projeto, em desenvolvimento”.

1. O agente consulta `list_blueprints` e escolhe `storage`.
2. Chama `plan_architecture` com nome, ambiente e blueprint.
3. Você recebe o template CloudFormation completo, o resumo e um identificador. Nesse momento, nenhum recurso foi provisionado.
4. `get_plan` recupera essa proposta em outra conversa ou chamada, sem depender de uma sessão MCP.
5. `validate_plan` informa se o conteúdo permanece íntegro, se o prazo de 24 horas ainda vale, se há aprovação administrativa e se ele já foi enfileirado.
6. Um operador revisa o template e aprova seu digest pela CLI, usando uma identidade administrativa.
7. O agente chama `apply_architecture`. Na AWS, a operação é persistida e o workflow cria os recursos.
8. `get_operation` acompanha o resultado. Uma desconexão da conversa não interrompe o workflow.

Uma chamada repetida com a mesma chave de idempotência retorna a mesma operação. Se você quiser mudar a proposta, gere um novo plano, revise e aprove novamente.

## Retomar e comparar propostas

Use `list_plans` para localizar planos anteriores e `list_operations` para acompanhar as execuções. Ambos aceitam `{ "limit": 10 }`; se houver `nextCursor`, passe-o como `cursor` na próxima chamada. O cursor só vale para o mesmo proprietário e tipo de histórico. Na AWS, um registro recém-criado pode levar algum tempo para aparecer no índice.

Preencha `examples/compare-plans.json` com dois IDs e execute:

```sh
npm run client -- --tool compare_plans --input examples/compare-plans.json
```

`sameDefinition: true` indica definição equivalente após normalizar a identidade gerada. Ainda assim, `createsDistinctStack: true` avisa que aplicar os dois planos criaria stacks diferentes. A comparação auxilia a revisão; a aprovação continua individual e vinculada ao digest de cada plano.

`NEEDS_ATTENTION` significa que não há evidência suficiente para concluir o resultado da operação. Pode haver recursos reais em criação. A reconciliação administrativa consulta a CloudFormation e atualiza o registro sem iniciar provisionamento; veja [recuperação](deployment.md#recuperação).

## Aplicações disponíveis hoje

| Necessidade                                      | Uso do MVP                                                      | O que ainda fica a cargo da aplicação                         |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Armazenar documentos e artefatos com privacidade | Blueprint `storage` cria S3 privado, versionado e criptografado | Upload, download e autorização dos usuários finais            |
| Preparar ingestão de eventos                     | `event-backbone` cria fila, DLQ e tabela DynamoDB               | Produtores, consumidores e regras de processamento            |
| Padronizar infraestrutura de projetos internos   | Catálogo e templates com parâmetros controlados                 | Políticas organizacionais e novos blueprints                  |
| Dar ferramentas AWS a agentes com revisão humana | Plano, digest, aprovação externa e aplicação acompanhada        | Provedor de identidade, conta AWS e configuração IAM validada |
| Estudar MCP stateless e serverless               | Modo local, cliente oficial, SQLite, testes e CDK               | Nenhuma conta AWS é necessária para simular                   |

## O que a validação significa

`validate_plan` verifica o registro local do plano. `readyToApply: true` significa que os pré-requisitos internos estão satisfeitos naquele instante. Não é uma cotação de preço, validação de quotas, teste de permissões AWS ou garantia de que CloudFormation vai concluir. O apply verifica os pré-requisitos novamente de forma transacional.

## Modos de execução

**Local:** roda no seu computador, usa SQLite e simula a criação de recursos. O resultado identifica `SIMULATED`.

**AWS:** após uma implantação autorizada e configurada, usa API Gateway, Lambda, DynamoDB Streams, Step Functions e CloudFormation. Esse modo cria recursos reais e pode gerar custos.

## Limites atuais

O MVP trabalha com dois blueprints e cria novas stacks em uma conta/região configurada. Ainda não atualiza nem exclui arquiteturas, calcula custos, cria aplicações completas, inventaria recursos preexistentes ou administra outras nuvens. A arquitetura de eventos é uma base de infraestrutura, não um pipeline de processamento completo.

Veja [README](../README.md) para os comandos e [implantação](deployment.md) para os requisitos do modo AWS.
