/**
 * COLETOR DE PREÇO DE RENOVAÇÃO POR TERMINAÇÃO
 *
 * Copia o catálogo de renovação da Namecheap para `tld_pricing`, de onde o
 * painel lê o custo de manter. Roda 1x por dia, às 04:40 UTC.
 *
 * O leitor do XML mora em `pricing-xml.js`, sem dependência nenhuma, para
 * poder ser provado sem credencial. Aqui fica só o I/O.
 *
 * ── O QUE ISTO SUBSTITUI ─────────────────────────────────────────────────
 *
 * Uma tabela de 51 terminações DIGITADA À MÃO em `src/lib/dashboard/precos.ts`
 * do repositório do painel, capturada em 29/09/2026. Envelhecia sozinha e
 * cobria só o que alguém lembrou de digitar — `.fit` e `.br` apareciam como
 * "sem preço" na tela por não estarem na lista.
 *
 * ── UMA CHAMADA TRAZ TUDO ────────────────────────────────────────────────
 *
 * `namecheap.users.getPricing` aceita `ProductName` opcional. O fluxo de
 * compra passa a terminação e recebe uma; aqui OMITIMOS o campo e vem o
 * catálogo inteiro.
 *
 * Isso importa pelo limite da Namecheap: 20 por minuto, 700 por hora, 8.000
 * por dia. Em laço, 400 terminações levariam 20 minutos e comeriam metade da
 * cota horária. Assim custa UMA requisição por dia.
 *
 * ── O QUE ISTO AINDA NÃO É ───────────────────────────────────────────────
 *
 * Preço de TABELA da conta, não o contratado domínio a domínio. Um domínio
 * pego em promoção pode renovar por outro valor. Fica exato quando o fluxo
 * de compra gravar o renew junto com o register.
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');
const { lerPrecos, ANOS } = require('./pricing-xml');

const API = 'https://api.namecheap.com/xml.response';

// Criado na primeira chamada, e não no carregamento do módulo: assim quem
// só quiser o leitor de XML não precisa das credenciais do Supabase.
let supabase = null;
function banco() {
  if (!supabase) {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

/** O IP precisa estar na whitelist da Namecheap. Mesma lógica do saldo. */
let ipDoServidor = null;
async function obterIP() {
  if (ipDoServidor) return ipDoServidor;
  const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
  ipDoServidor = data.ip;
  return ipDoServidor;
}

/**
 * O catálogo de renovação, cru.
 *
 * `ProductCategory: 'RENEW'` em vez de `REGISTER`, que é o que o fluxo de
 * compra usa — são preços diferentes, e renovar costuma custar bem mais que
 * registrar no primeiro ano.
 */
async function buscarXML() {
  const { data } = await axios.get(API, {
    params: {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: 'namecheap.users.getPricing',
      ClientIp: await obterIP(),
      ProductType: 'DOMAIN',
      ProductCategory: 'RENEW',
      // ProductName OMITIDO de propósito: é o que traz o catálogo todo.
    },
    timeout: 60000,
  });
  return data;
}

/**
 * Busca e grava. É o que o cron chama.
 *
 * Upsert por `tld`: a coleta de amanhã sobrescreve a de hoje. Não há
 * histórico de preço de propósito — o painel quer saber quanto custa
 * renovar AGORA, e guardar a série exigiria data na chave e uma decisão
 * sobre qual linha ler que ninguém pediu.
 *
 * Terminação que SOME do catálogo fica na tabela com a data velha, e é o
 * certo: ela continua valendo até prova em contrário, e `atualizado_em`
 * denuncia que parou de ser atualizada. Apagar o que não veio
 * transformaria uma falha parcial da API em sumiço de preço na tela.
 */
async function sincronizar() {
  console.log('💲 [PRECOS] Buscando catálogo de renovação na Namecheap...');

  const xml = await buscarXML();

  // A Namecheap responde HTTP 200 com o erro dentro do XML. Sem este teste,
  // IP fora da whitelist viraria "0 terminações" no log — que parece coleta
  // vazia, não falha de autenticação, e mandaria quem investiga para o lado
  // errado.
  const erro = String(xml).match(/<Error Number="(\d+)">([^<]*)<\/Error>/i);
  if (erro) throw new Error(`Namecheap recusou (${erro[1]}): ${erro[2]}`);

  const precos = lerPrecos(xml);
  if (!precos.length) {
    throw new Error('Nenhuma terminação lida — o formato do XML pode ter mudado');
  }

  const agora = new Date().toISOString();
  const linhas = precos.map((p) => ({
    tld: p.tld,
    renovacao_usd: p.renovacao,
    taxa_icann_usd: p.icann,
    anos: ANOS,
    atualizado_em: agora,
  }));

  const { error } = await banco().from('tld_pricing').upsert(linhas, { onConflict: 'tld' });
  if (error) throw new Error(`Falha ao gravar: ${error.message}`);

  // O `.com` no log porque é 60% da renovação da base — é o número que vale
  // bater contra a fatura sem precisar abrir o banco.
  const com = precos.find((p) => p.tld === '.com');
  console.log(
    `✅ [PRECOS] ${precos.length} terminações gravadas` +
      (com ? ` · .com US$ ${(com.renovacao + com.icann).toFixed(2)}` : ''),
  );

  return { gravadas: precos.length };
}

/**
 * Preço de REGISTRO e de RENOVAÇÃO de UMA terminação. Não grava nada.
 *
 * Existe para responder uma pergunta que a tabela `tld_pricing` não
 * responde: ela guarda só renovação, e quem decide se a compra por IA
 * consegue comprar é o preço de REGISTRO, contra o teto de US$ 5,00 que
 * `wordpress/index.js` e `atomicat/index.js` aplicam.
 *
 * Os dois são preços independentes. `.online` registra barato por promoção
 * de primeiro ano e renova por US$ 35,88 — um não diz nada sobre o outro.
 *
 * UMA chamada traz as duas: pedindo `ProductName` sem `ProductCategory`, a
 * Namecheap devolve todas as categorias daquela terminação.
 *
 * O teto é lido da própria classe de compra, não copiado para cá. O
 * construtor dela só atribui propriedades — nenhum I/O, nenhuma conexão —,
 * então instanciar é barato e garante que esta resposta diga o teto REAL.
 * Um `5.00` digitado aqui viraria mentira no dia em que alguém mudasse lá.
 */
async function consultar(tld) {
  const limpo = String(tld || '').trim().toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9.]+$/.test(limpo)) throw new Error(`Terminação inválida: ${tld}`);

  const { data: xml } = await axios.get(API, {
    params: {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: 'namecheap.users.getPricing',
      ClientIp: await obterIP(),
      ProductType: 'DOMAIN',
      ProductName: limpo,
      // ProductCategory omitido: traz register, renew, transfer e reativação
      // de uma vez, e queremos as duas primeiras.
    },
    timeout: 60000,
  });

  const erro = String(xml).match(/<Error Number="(\d+)">([^<]*)<\/Error>/i);
  if (erro) throw new Error(`Namecheap recusou (${erro[1]}): ${erro[2]}`);

  const achar = (categoria) =>
    lerPrecos(xml, categoria).find((p) => p.tld === '.' + limpo) ?? null;

  const registro = achar('register');
  const renovacao = achar('renew');

  const { priceLimit } = new (require('../../purchase-domains/wordpress'))();

  // O custo que o teto compara é preço + ICANN: é assim que o fluxo de
  // compra soma antes de decidir. Comparar só o `YourPrice` daria um
  // "passa" otimista em terminação que estoura por causa da taxa.
  const custoDeRegistro = registro ? registro.renovacao + registro.icann : null;

  return {
    tld: '.' + limpo,
    registro: registro && {
      preco: registro.renovacao,
      icann: registro.icann,
      total: Number(custoDeRegistro.toFixed(2)),
    },
    renovacao: renovacao && {
      preco: renovacao.renovacao,
      icann: renovacao.icann,
      total: Number((renovacao.renovacao + renovacao.icann).toFixed(2)),
    },
    tetoDaCompraPorIA: priceLimit,
    // `null` quando a Namecheap não deu preço de registro: aí não dá para
    // afirmar nem que passa nem que não passa.
    passaNoTeto: custoDeRegistro === null ? null : custoDeRegistro <= priceLimit,
  };
}

module.exports = { sincronizar, consultar };
