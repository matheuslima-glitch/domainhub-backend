/**
 * AS CONTAS DA NAMECHEAP
 *
 * O sistema nasceu com uma conta só, lida direto de `config.NAMECHEAP_*` em
 * 19 lugares. Este módulo passa a ser o único que sabe quantas contas
 * existem e quais são as credenciais de cada uma.
 *
 * ── POR QUE DUAS ─────────────────────────────────────────────────────────
 *
 * Para dividir as compras por IA entre a conta principal e a do Paulo, na
 * proporção 2:1. O motivo é de operação, não de código — espalhar os
 * domínios reduz o estrago se uma conta for suspensa.
 *
 * ── SEM A SEGUNDA, NADA MUDA ─────────────────────────────────────────────
 *
 * `NAMECHEAP_2_*` é OPCIONAL. Sem elas, `listar()` devolve uma conta só e
 * todo o resto do sistema se comporta exatamente como antes. É o que
 * permite mergear e deployar antes de as credenciais do Paulo existirem.
 *
 * Isso importa porque há um pré-requisito fora do nosso alcance: o IP do
 * Render precisa estar na whitelist DAQUELA conta — a whitelist é por
 * conta. Enquanto não estiver, é melhor o sistema rodar com uma conta do
 * que falhar em metade das chamadas.
 *
 * ── O APELIDO É GRAVADO NO BANCO ─────────────────────────────────────────
 *
 * `domains.registrar_account` guarda o apelido de quem comprou. Sem isso,
 * trocar nameserver ou consultar um domínio da conta do Paulo usaria a
 * credencial errada e falharia — e o cron de sincronia nem enxergaria
 * aqueles domínios.
 *
 * Por isso o apelido é texto curto e estável (`principal`, `paulo`) e não
 * um índice: índice muda de significado se alguém reordenar a lista, e aí
 * as linhas antigas passariam a apontar para a conta errada em silêncio.
 */

const config = require('../../config/env');

/**
 * A cota de cada conta no rodízio.
 *
 * `principal: 2` e `paulo: 1` é a regra pedida: a cada três compras, duas
 * na principal e uma na nova.
 *
 * A cota NÃO é proporção fixa calculada uma vez — é peso. `escolher()`
 * usa a razão entre o que já foi comprado e a cota, então a distribuição
 * se corrige sozinha quando uma compra falha.
 */
const DEFINICAO = [
  {
    apelido: 'principal',
    cota: 2,
    user: () => config.NAMECHEAP_API_USER,
    key: () => config.NAMECHEAP_API_KEY,
  },
  {
    apelido: 'paulo',
    cota: 1,
    user: () => config.NAMECHEAP_2_API_USER,
    key: () => config.NAMECHEAP_2_API_KEY,
  },
];

/** As contas que de fato têm credencial. A principal sempre está aqui. */
function listar() {
  return DEFINICAO.filter((c) => c.user() && c.key()).map((c) => ({
    apelido: c.apelido,
    cota: c.cota,
  }));
}

/** Tem mais de uma conta configurada? */
function temRodizio() {
  return listar().length > 1;
}

/** O apelido da conta principal. É a de sempre, e a única garantida. */
const PRINCIPAL = 'principal';

/**
 * Os parâmetros de autenticação de uma conta, para entrar na query string.
 *
 * Apelido desconhecido ou sem credencial CAI NA PRINCIPAL, em vez de
 * lançar. É a escolha certa aqui: um domínio gravado como `paulo` numa
 * época em que aquela conta existia não pode derrubar a sincronia inteira
 * se a credencial for removida depois. Com o retorno na principal, a
 * chamada falha só para aquele domínio, e o log diz por quê.
 */
function parametros(apelido) {
  const existentes = listar().map((c) => c.apelido);
  const alvo = existentes.includes(apelido) ? apelido : PRINCIPAL;
  const def = DEFINICAO.find((c) => c.apelido === alvo);

  return {
    ApiUser: def.user(),
    ApiKey: def.key(),
    UserName: def.user(),
    // Quem chama usa isto no log, para a mensagem dizer qual conta falhou.
    _apelido: alvo,
  };
}

/**
 * Qual conta deve receber a PRÓXIMA compra.
 *
 * `contagens` é `{ principal: n, paulo: m }` — quantas compras cada conta
 * já recebeu DESDE QUE O RODÍZIO COMEÇOU. Função pura: quem chama lê o
 * banco e passa os números.
 *
 * ── POR QUE SÓ AS COMPRAS NOVAS ──────────────────────────────────────────
 *
 * A base tem ~2.700 domínios, todos na principal. Contando o histórico, a
 * razão da principal seria altíssima e o rodízio mandaria as próximas
 * ~1.350 compras SEGUIDAS para a conta do Paulo, "compensando" um passado
 * que não é para compensar. Quem chama filtra por
 * `registrar_account is not null`, que só existe a partir daqui.
 *
 * ── A REGRA ──────────────────────────────────────────────────────────────
 *
 * Escolhe a conta com a menor razão `usado / cota`. Empate vai para a
 * primeira da lista, que é a principal.
 *
 * Com cotas 2 e 1, a sequência sai P, Pa, P, P, Pa, P, P, Pa — e a cada
 * três compras o placar está exatamente em 2:1.
 *
 * Isso se AUTOCORRIGE: se uma compra na conta do Paulo falhar, a razão
 * dela não sobe, e ela é escolhida de novo na vez seguinte. Um contador
 * guardado em algum lugar não teria essa propriedade — ele avançaria mesmo
 * na falha, e o desvio seria permanente.
 */
function escolher(contagens = {}) {
  const contas = listar();
  if (contas.length <= 1) return PRINCIPAL;

  let melhor = contas[0];
  let menorRazao = Infinity;

  for (const c of contas) {
    const usado = Number(contagens[c.apelido]) || 0;
    const razao = usado / c.cota;
    // `<` e não `<=`: empate fica com quem veio antes, e a principal é a
    // primeira. Sem isso o desempate penderia para a última conta da lista.
    if (razao < menorRazao) {
      menorRazao = razao;
      melhor = c;
    }
  }

  return melhor.apelido;
}

module.exports = { listar, temRodizio, parametros, escolher, PRINCIPAL };
