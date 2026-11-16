# Proposal

## Why

Os domínios comprados pelo DomainHub não têm antibot. A única regra de desafio que existe (`filtro`, `http.host wildcard "*"`, desafio gerenciado) fica na zona principal `institutoexperience.com.br` e não alcança os domínios: em 13/11/2026, testes de fora mostraram o desafio só em `institutoexperience.com.br` e `servidor.institutoexperience.com.br`, nunca nos domínios comprados, fossem antigos ou novos.

No mesmo dia, uma regra igual criada à mão na zona de `sugarresethub.com` passou a responder com o desafio (`403`, `cf-mitigated: challenge`). Ou seja, a regra na zona de cada domínio funciona, e cabe no plano free, que aceita 5 regras personalizadas por zona.

Antes de ligar nos cerca de 600 domínios, é preciso um jeito seguro e repetível de aplicar e desfazer a regra num grupo pequeno, para medir o efeito em tráfego real: visitantes, robôs de anúncio e o monitor Checkmate. Fazer isso à mão, zona por zona, não escala e não deixa registro.

## What Changes

- Uma rotina nova no backend aplica, simula ou remove a **regra antibot** (desafio gerenciado para qualquer host) na zona de cada domínio de uma lista informada.
- Uma rota nova, `POST /api/antibot/lote`, só para super admin. O modo padrão é a **simulação**, que não altera nada.
- A rotina é idempotente. A regra leva uma referência própria (`ref`), então rodar de novo não duplica. Uma regra equivalente criada à mão, como a "Antibot-teste" do `sugarresethub.com`, também é reconhecida e não é duplicada.
- As travas:
  - só atua em domínios cadastrados na tabela `domains`;
  - nunca mexe na zona principal;
  - não ultrapassa o limite de 5 regras personalizadas da zona;
  - aceita no máximo 50 domínios por chamada.
- A rota devolve um relatório por domínio. Quando houver falha, um resumo vai para o Telegram.
- Tudo usa a API de Rulesets da Cloudflare. A API antiga de Firewall Rules, usada hoje na compra, parou de criar regras ativas.

**Fora de escopo (próxima mudança):**
- criar a regra durante a compra;
- aplicar em todos os domínios de uma vez;
- conferência diária;
- remover na exclusão;
- reabilitar os bloqueios de `sitemap` e `?s=` que ficaram como "Unused filter";
- domínios `.com` comprados na conta nova da Cloudflare.

## Capabilities

### New Capabilities
- `protecao-antibot`: aplicação, simulação e remoção da regra antibot na zona DNS de cada domínio do DomainHub, com relatório e aviso de falha.

### Modified Capabilities

(nenhuma)

## Impact

- **Código:**
  - serviço novo em `src/services/cloudflare/` (uma parte pura de decisão e uma de chamadas à API);
  - rota nova em `src/routes/antibot/`, montada em `src/server.js`;
  - script de prova `src/scripts/testa-antibot.js`, com `npm run testa:antibot`.
- **APIs externas:** a API de Rulesets da Cloudflare, com a mesma chave global que o backend já usa (`CLOUDFLARE_EMAIL` e `CLOUDFLARE_API_KEY`). Essa chave apareceu num print em 10/11/2026 e deve ser trocada antes da primeira execução real.
- **Banco:** nenhuma mudança de esquema. A rotina só lê `domains`.
- **Efeito nos domínios do piloto:**
  - todo visitante passa pela verificação da Cloudflare;
  - o Checkmate pode acusar esses domínios como fora do ar;
  - robôs de revisão de anúncios podem ser barrados.

  É exatamente isso que o piloto vai medir. O modo de remoção desfaz tudo.
