/**
 * A TERMINAÇÃO QUE A COMPRA POR IA REGISTRA.
 *
 * Um lugar só, para os dois fluxos — WordPress e Atomicat. Trocar a
 * terminação é trocar a linha do `TLD` aqui embaixo.
 *
 * SEM NENHUMA DEPENDÊNCIA de propósito: não importa `config`, que lança
 * quando falta variável de ambiente. É o que permite `npm run testa:tld`
 * rodar em qualquer máquina, sem credencial de produção, para provar as
 * expressões regulares.
 *
 * ── POR QUE `site` DESDE 21/10/2026 ──────────────────────────────────────
 *
 * Era `online`. Os preços foram medidos na própria API da Namecheap, pela
 * rota `GET /api/precos/consultar`:
 *
 *                 registro    renovação
 *   .online       US$ 3,08    US$ 35,88
 *   .site         US$ 1,18    US$ 30,18
 *                 ─────────   ──────────
 *                 −US$ 1,90   −US$ 5,70 por ano
 *
 * A cada 100 domínios comprados, são US$ 190 a menos na compra e US$ 570
 * por ano a menos de renovação.
 *
 * ── E NÃO É SÓ ECONOMIA: É MARGEM ────────────────────────────────────────
 *
 * Os dois fluxos barram qualquer domínio acima de US$ 5,00 (`priceLimit`).
 * O `.online` estava em US$ 3,08 — só 1,6× de folga — e JÁ TINHA SUBIDO:
 * as compras antigas da base saíram por cerca de US$ 1,20.
 *
 * Se o registro passasse de US$ 5,00, a compra por IA pararia por completo
 * e EM SILÊNCIO: as 10 tentativas seriam barradas e o log diria "domínio
 * indisponível", não "preço estourou". `.site` a US$ 1,18 devolve 4,2× de
 * folga.
 *
 * ── POR QUE UM MÓDULO, E NÃO LITERAL EM CADA ARQUIVO ─────────────────────
 *
 * `.online` aparecia em ONZE lugares no Atomicat e em DOIS no WordPress: o
 * prompt da IA, duas validações de sufixo, uma expressão regular de
 * formato, o texto de dois erros e comentários.
 *
 * Esquecer UM quebra o fluxo inteiro de um jeito difícil de diagnosticar: a
 * IA passa a gerar a terminação nova, a validação esquecida rejeita, as 10
 * tentativas se esgotam e o log culpa a disponibilidade do domínio.
 */

/** A terminação, SEM o ponto. É só isto que se troca. */
const TLD = 'site';

/** Com o ponto. É o que se compara com `endsWith` e o que vai no prompt. */
const SUFIXO = '.' + TLD;

/**
 * O formato aceito para um domínio gerado pela IA.
 *
 * O ponto É ESCAPADO, e isso não é detalhe: sem o escape ele vira curinga
 * e a validação passa a aceitar `exemplosite` — sem ponto nenhum — como se
 * fosse `exemplo.site`. Já escorreguei nisso montando a expressão com
 * concatenação solta.
 *
 * `[a-z0-9]+` não aceita hífen nem acento, que é a regra que o prompt já
 * pedia e esta linha faz valer.
 */
const FORMATO = new RegExp('^[a-z0-9]+' + SUFIXO.replace(/\./g, '\\.') + '$');

/**
 * Acha um domínio da terminação certa dentro de um texto solto.
 *
 * Usado só como rede quando a resposta da IA não vem em JSON válido.
 */
const DENTRO_DO_TEXTO = new RegExp('([a-z0-9]+' + SUFIXO.replace(/\./g, '\\.') + ')', 'i');

module.exports = { TLD, SUFIXO, FORMATO, DENTRO_DO_TEXTO };
