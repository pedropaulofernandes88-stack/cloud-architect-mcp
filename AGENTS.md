# Cloud Architect MCP

- Preserve o idioma português na documentação e nas mensagens públicas.
- Use Node.js 24, TypeScript estrito e SDK MCP v2 modular.
- A pasta `src/domain` não deve depender de AWS ou do transporte MCP.
- O endpoint nunca aprova planos. Aprovações pertencem ao comando administrativo e a uma identidade IAM separada.
- Toda operação é vinculada ao proprietário e ao digest do plano aprovado. Repetições não podem provisionar duas vezes.
- Execute `npm run check`, `npm run format:check` e `npm run synth` antes de concluir mudanças relevantes.
- Não faça deploy, bootstrap CDK ou chamadas mutáveis à AWS sem autorização explícita.
- Não versione segredos, bancos locais, `node_modules`, `dist` ou `cdk.out`.
