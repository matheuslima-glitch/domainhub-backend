# Tasks

## 1. Lógica pura de decisão (`src/services/cloudflare/antibot-regras.js`)

- [x] 1.1 Implementar a normalização e a validação do pedido: de 1 a 50 domínios, sem espaços, em minúsculas, sem repetidos, e modo entre `simular`, `aplicar` e `remover`, com `simular` como padrão. Verificar com provas em `src/scripts/testa-antibot.js` para lista vazia, 51 domínios, nomes repetidos com caixa diferente e modo desconhecido.
- [x] 1.2 Implementar a decisão por zona a partir do conjunto de regras lido e do modo. Os resultados possíveis:
  - conjunto inexistente: criar o conjunto;
  - regra com `ref` do DomainHub e ativa: `ja_existia`;
  - regra com `ref` do DomainHub e desativada: `reativada`;
  - regra equivalente feita à mão: `ja_existia`;
  - 5 regras ou mais: `limite`;
  - remoção com o `ref`: apagar;
  - remoção sem o `ref`: `nada_a_remover`.

  Verificar com uma prova para cada caso.
- [x] 1.3 Implementar o relatório, com o resultado de cada domínio e o total por resultado, e o texto do resumo de falhas. Verificar com provas de lote misto: cada domínio aparece uma vez e a contagem bate.

## 2. Chamadas à Cloudflare (`src/services/cloudflare/antibot.js`)

- [x] 2.1 Implementar a busca de zona por nome (`GET /zones?name=`), a recusa da zona principal (`CLOUDFLARE_MAIN_ZONE_ID`) e a leitura do entrypoint `http_request_firewall_custom`, em que 404 significa sem conjunto. Verificar com provas contra uma Cloudflare falsa: `sem_zona`, `recusado` e o 404 tratado como zona sem conjunto.
- [x] 2.2 Implementar a execução do plano:
  - `PUT` no entrypoint só depois de um 404;
  - `POST` da regra com `ref: "domainhub-antibot"`, a descrição `Antibot (DomainHub)`, `action: managed_challenge`, a expressão constante e `position.index: 1`;
  - `PATCH` para reativar;
  - `DELETE` para remover.

  Verificar com provas que contam as escritas: zero na simulação, zero em `ja_existia`, `limite` e `nada_a_remover`, e o `PUT` nunca chamado quando o conjunto já existe.
- [x] 2.3 Implementar o lote:
  - um domínio por vez, com 250 ms de pausa;
  - falha isolada, em que o erro de um domínio não para os outros;
  - trava em memória contra dois lotes simultâneos;
  - alerta `notify.espelhar(resumo, { critico: true })` só quando houver `erro` fora da simulação.

  Verificar com provas: a falha no meio do lote não interrompe os seguintes, sai exatamente um alerta com erro, nenhum alerta sai em lote limpo ou em simulação, e o segundo lote simultâneo é recusado.

## 3. Rota, montagem e documentação

- [x] 3.1 Criar `POST /api/antibot/lote` em `src/routes/antibot/index.js`. A rota:
  - aplica a trava de super admin pela RPC `e_super_admin`, com 403 para quem não é super admin e 503 se o cargo não puder ser conferido;
  - recusa entrada inválida com 400;
  - recusa um segundo lote simultâneo com 409;
  - consulta `domains` e marca como `desconhecido` o domínio que não estiver lá, sem chamada à Cloudflare.

  Verificar com provas pela rota real em express, usando Supabase e Cloudflare falsos.
- [x] 3.2 Montar a rota em `src/server.js` depois do `authMiddleware` e registrar `npm run testa:antibot` no `package.json`. Verificar que `npm run testa:antibot` passa e que a rota não aparece na lista de caminhos públicos.
- [x] 3.3 Documentar no cabeçalho da rota como usar: os comandos de Console para simular, aplicar e remover, e o significado de cada resultado. Verificar que o comando documentado corresponde ao corpo aceito pela rota, por uma prova que usa o mesmo corpo.

## 4. Verificação integrada

- [x] 4.1 Rodar `openspec validate antibot-em-lote --strict` e verificar que passa sem erros.
- [x] 4.2 Rodar todas as suítes do backend (`testa:registro`, `testa:registrar`, `testa:tld`, `testa:presenca`, `testa:rodizio`, `testa:precos` e `testa:antibot`) e verificar que todas terminam com 0 falha.

## Workflow follow-up

- Abrir o PR com o aval do usuário, fazer o merge e o deploy.
- Trocar a `CLOUDFLARE_API_KEY` no Render antes da primeira aplicação real.
- Piloto com a lista do usuário: simulação, aplicação, conferência de fora e 1 a 2 dias de observação. Remover a regra se o resultado for ruim.
- Arquivar a mudança depois do piloto (`openspec-archive-change`).
- Abrir a próxima mudança com a regra na compra, a aplicação em todos os domínios, a conferência diária, a remoção na exclusão, a reativação dos bloqueios de `sitemap` e `?s=` e os domínios `.com` da conta nova.
