# Design

## Context

Ver `proposal.md` (Why). Fatos que moldam a solução, levantados em 13/11/2026:

- **Plano das zonas:** cada domínio tem uma zona própria na conta principal (`CLOUDFLARE_ACCOUNT_ID`), no plano free, que aceita 5 regras personalizadas por zona. As regras que contam para o limite incluem as desativadas: a zona do `sugarresethub.com` mostrava "2/5" com duas regras desativadas.
- **Regras antigas:** a compra cria as regras de `sitemap` e `?s=` pela API antiga (`/filters` e `/firewall/rules`). Hoje o primeiro passo ainda grava, mas a regra fica como "Unused filter" e desativada. O segundo passo falha. A API de Firewall Rules está sem suporte desde 15/06/2025.
- **Regra que funciona:** a regra criada no painel em `sugarresethub.com` passou a responder `403` com `cf-mitigated: challenge`. O painel mostrou a chamada equivalente: `POST /zones/{zona}/rulesets/{ruleset}/rules` com `action: managed_challenge` e `position.index: 1`.
- **Credencial:** o backend fala com a Cloudflare usando a chave global (`X-Auth-Email` + `X-Auth-Key`), que enxerga todas as zonas da conta principal. A API de Rulesets aceita essa autenticação.
- **Padrões do repositório:**
  - lógica pura separada das chamadas de rede (`registrar-resposta.js` e `registrar.js`);
  - rotas de risco com a trava de super admin pela RPC `e_super_admin` (`src/routes/registrar`);
  - provas em `src/scripts/testa-*.js`, com a Cloudflare falsa via `axios.defaults.adapter`;
  - alertas pelo distribuidor `src/services/notify` (`espelhar`, com `critico`).

## Goals / Non-Goals

**Goals:**
- Aplicar, simular e remover a regra antibot numa lista de até 50 domínios, de forma idempotente e sem efeito colateral nas outras regras da zona.
- Reaproveitar os padrões do repositório (trava de super admin, lógica pura testável, distribuidor de alertas).

**Non-Goals:**
- Fila ou execução em segundo plano. Até 50 domínios cabem numa resposta síncrona.
- Token de API com escopo reduzido no lugar da chave global. Fica para a mudança que integrar a compra.
- Exceções na expressão para robôs verificados ou para o Checkmate. O piloto decide se elas são necessárias.

## Decisions

**1. A regra fica na zona de cada domínio, e não na zona principal.**
- A regra `filtro` da zona principal, com `http.host wildcard "*"`, não alcança os domínios. Isso foi comprovado por teste.
- Listas de hostname da Cloudflare só existem no plano Enterprise.
- A regra na zona do domínio foi a única alternativa testada que funcionou.

**2. API de Rulesets, fase `http_request_firewall_custom`.** As chamadas usadas:
- `GET /zones/{zona}/rulesets/phases/http_request_firewall_custom/entrypoint` lê as regras. O erro 404 significa que a zona ainda não tem conjunto de regras.
- `PUT` no mesmo endereço, com `{ rules: [regra] }`, cria o conjunto **só quando a leitura deu 404**. Usado com um conjunto existente, o `PUT` substituiria todas as regras.
- `POST /zones/{zona}/rulesets/{ruleset}/rules` com `position: { index: 1 }` cria a regra em primeiro lugar.
- `PATCH .../rules/{regra}` com `enabled: true` reativa a regra.
- `DELETE .../rules/{regra}` remove a regra.

A API de Firewall Rules foi descartada: é exatamente ela que hoje produz as "Unused filter" desativadas.

**3. Identificação da regra.**
- **Regra do DomainHub:** `ref: "domainhub-antibot"`. É o campo que a API oferece para referência externa, e a regra leva também a descrição `Antibot (DomainHub)`.
- **Regra equivalente feita à mão:** é reconhecida quando a ação é `managed_challenge` e a expressão, sem espaços extras, é `(http.host wildcard r"*")`. Isso evita duplicar a "Antibot-teste" do `sugarresethub.com`.
- **Remoção:** só apaga a regra com o `ref` do DomainHub. Regras feitas à mão nunca são apagadas pela automação.
- Alternativa descartada: identificar só pela descrição, que qualquer pessoa pode editar no painel.

**4. A expressão e a ação ficam em constantes num único lugar.** Se o piloto pedir exceções, por exemplo `and not cf.client.bot`, a mudança é de uma linha. Uma regra que já tenha o `ref` com expressão antiga é considerada existente. Atualizar a expressão de regras já criadas fica fora desta mudança.

**5. Zona por nome, e não pela listagem completa.**
- A rotina usa `GET /zones?name={dominio}` para cada domínio. Para até 50 domínios, isso custa menos do que a listagem completa (`listarZonas()`), que tem cerca de 21 páginas.
- Antes de qualquer chamada à Cloudflare, a rotina confere se o domínio existe em `domains`.
- Depois da busca, recusa a zona cujo id for igual a `CLOUDFLARE_MAIN_ZONE_ID`.

**6. Limite de regras.**
- Antes de criar a regra, a rotina conta todas as regras do conjunto, ativas ou não. Com 5 ou mais, o domínio sai como `limite`.
- Se outro processo encher a zona entre a leitura e a escrita, o erro da Cloudflare vira `erro` daquele domínio, sem derrubar o lote.

**7. Divisão do código.**
- `src/services/cloudflare/antibot-regras.js` é puro e sem rede. Ele normaliza a lista, decide a ação por zona a partir do conjunto lido e do modo, e monta o relatório.
- `src/services/cloudflare/antibot.js` faz as chamadas e executa o plano.
- `src/routes/antibot/index.js` valida o pedido, aplica a trava de super admin e responde.

O mesmo desenho do Registrar permite provar a lógica toda sem rede.

**8. Ritmo e concorrência.**
- **Ritmo:** a rotina trata um domínio por vez, com 250 ms de pausa. Cada domínio faz no máximo 4 chamadas, então são até ~200 chamadas por lote, muito abaixo do limite de 1.200 a cada 5 minutos.
- **Concorrência:** uma trava em memória impede dois lotes ao mesmo tempo, por exemplo num clique duplo. O segundo pedido recebe `409`.

**9. Alerta de falha.**
- Ao fim de um lote de aplicação ou remoção com pelo menos um `erro`, sai uma mensagem só, com `notify.espelhar(resumo, { critico: true })`.
- O Telegram recebe porque o alerta é crítico. O Discord, que recebe só falhas, também recebe.
- A simulação nunca alerta.

## Risks / Trade-offs

- [Robôs de revisão de anúncio barrados pelo desafio] → é o que o piloto mede. A remoção desfaz, e a exceção cabe na constante da decisão 4.
- [Navegadores internos de apps (Instagram, Facebook, TikTok) falhando no desafio] → piloto em domínios com tráfego, comparando a conversão antes e depois.
- [Checkmate marcando os domínios do piloto como fora do ar] → avisar quem recebe os alertas do Checkmate antes do piloto. Uma exceção para o IP dele pode entrar depois.
- [`PUT` no entrypoint apagar regras existentes] → o `PUT` só é usado quando a leitura deu 404, e há uma prova específica para isso.
- [A chave global apareceu num print em 10/11/2026] → trocar a chave e atualizar o Render antes da primeira aplicação real.
- [Lote de 50 domínios levando cerca de 1 minuto numa resposta HTTP] → aceitável para o uso manual de piloto. A aplicação em todos os domínios usa execução em segundo plano, na próxima mudança.
- [Regra criada à mão não é removida pelo modo de remoção] → comportamento intencional (decisão 3). O relatório indica `nada_a_remover`, e quem criou à mão apaga à mão.

## Migration Plan

1. Merge e deploy. Não há mudança de banco nem variável nova.
2. Trocar a `CLOUDFLARE_API_KEY` no Render.
3. Rodar a **simulação** com a lista do piloto e conferir o relatório.
4. Rodar a **aplicação** na mesma lista e conferir de fora que os domínios passaram a responder com o desafio.
5. Observar por 1 ou 2 dias a conversão, a aprovação dos anúncios e os alertas do Checkmate.
6. **Desfazer, se necessário:** rodar o modo de remoção com a mesma lista. O deploy pode ser revertido pelo Render sem efeito no banco.

## Open Questions

- Incluir uma exceção para robôs verificados (`cf.client.bot`) ou para o IP do Checkmate? Depende do resultado do piloto, e muda só a constante da decisão 4.
