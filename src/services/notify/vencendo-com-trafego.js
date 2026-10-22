/**
 * AVISO DE DOMÍNIO VENCENDO COM TRÁFEGO
 *
 * Roda todo dia e avisa no Telegram sobre domínios perto de expirar —
 * ordenados pelo tráfego que ainda recebem.
 *
 * ── O QUE ISTO PROTEGE, E POR QUE É O MAIS CARO ──────────────────────────
 *
 * Domínio que morre recebendo tráfego pago. A mídia continua sendo
 * injetada, as conversões vão a zero, e ninguém percebe até alguém olhar.
 *
 * Esse prejuízo é muito maior que o de uma renovação cobrada duas vezes:
 * a cobrança dupla custa o preço de um domínio e aparece na fatura; o
 * domínio morto custa todo dia e não aparece em lugar nenhum.
 *
 * ── POR QUE ESTE AVISO É INDEPENDENTE DA RENOVAÇÃO ───────────────────────
 *
 * Porque ele pega TODAS as causas de morte, não só a que conhecemos:
 *
 *   - renovação que a API deu como feita mas não pegou
 *   - domínio que ninguém lembrou de renovar
 *   - renovação recusada por saldo e não notada
 *   - domínio que nem passou pelo DomainHub
 *
 * Um aviso que só cobrisse falha da nossa API cobriria o caso menos
 * provável. Este olha o estado do mundo, não o nosso registro dele.
 *
 * ── A ORDENAÇÃO É POR TRÁFEGO, NÃO POR DATA ──────────────────────────────
 *
 * Um domínio parado que vence amanhã pode simplesmente morrer — é até o
 * que a aba "Sem acesso" sugere fazer. Um domínio com 50 mil requisições
 * vencendo em 20 dias é urgente.
 *
 * Ordenar por data poria o irrelevante no topo da mensagem.
 */

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

/**
 * A janela do aviso.
 *
 * 30 dias porque é o tempo de alguém decidir, conferir saldo e renovar sem
 * pressa. Menos que isso vira urgência; mais vira ruído diário sobre coisa
 * que ainda nem precisa de decisão.
 */
const DIAS = 30;

/**
 * Quantos domínios a mensagem lista.
 *
 * O resto vira uma linha de resumo. Mensagem de Telegram tem limite de
 * 4.096 caracteres, e uma lista de 200 domínios não é lida por ninguém —
 * viraria a notificação que todo mundo ignora.
 */
const NA_MENSAGEM = 15;

let supabase = null;
function banco() {
  if (!supabase) {
    supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

function dataBR(iso) {
  if (!iso) return '?';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

function diasAte(iso) {
  const hoje = new Date();
  hoje.setUTCHours(0, 0, 0, 0);
  const alvo = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return Math.round((alvo - hoje) / 86400000);
}

/**
 * Busca e avisa. É o que o cron chama.
 *
 * Só domínios ATIVOS: desativado que expira é o resultado esperado, não
 * um problema a comunicar.
 */
async function enviar() {
  const limite = new Date(Date.now() + DIAS * 86400000).toISOString().slice(0, 10);

  const { data, error } = await banco()
    .from('domains')
    .select('domain_name, expiration_date, requests_30d, traffic_source')
    .eq('status', 'active')
    .not('expiration_date', 'is', null)
    .lte('expiration_date', limite)
    // Por TRÁFEGO, não por data. Ver o cabeçalho.
    .order('requests_30d', { ascending: false, nullsFirst: false })
    // Teto explícito: o PostgREST corta em mil EM SILÊNCIO, e uma lista
    // truncada sem aviso aqui esconderia justamente o que o aviso existe
    // para mostrar.
    .limit(500);

  if (error) throw new Error(`Não deu para ler os domínios: ${error.message}`);

  const lista = data || [];
  if (!lista.length) {
    console.log(`✅ [VENCENDO] Nenhum domínio ativo vence nos próximos ${DIAS} dias`);
    return { encontrados: 0, enviado: false };
  }

  const vencidos = lista.filter((d) => diasAte(d.expiration_date) < 0);
  const comTrafego = lista.filter((d) => (d.requests_30d || 0) > 0);

  const linhas = lista.slice(0, NA_MENSAGEM).map((d) => {
    const dias = diasAte(d.expiration_date);
    const req = Number(d.requests_30d || 0);
    const quando = dias < 0 ? `JÁ VENCEU há ${-dias}d` : `${dias}d`;
    return (
      `• *${d.domain_name}*\n` +
      `   ⏳ ${quando} · ${dataBR(d.expiration_date)}\n` +
      `   📊 ${req.toLocaleString('pt-BR')} req/30d` +
      (d.traffic_source ? ` · ${d.traffic_source}` : '')
    );
  });

  const texto = [
    `*⏳ Domínios vencendo em até ${DIAS} dias*`,
    '',
    vencidos.length ? `🚨 *${vencidos.length} JÁ VENCIDO(S)*` : null,
    `${lista.length} no total · ${comTrafego.length} ainda recebendo tráfego`,
    '',
    ...linhas,
    lista.length > NA_MENSAGEM ? `\n_e mais ${lista.length - NA_MENSAGEM} no painel._` : null,
    '',
    '_Ordenado por tráfego: o de cima é o que mais custa se morrer._',
  ]
    .filter((l) => l !== null)
    .join('\n');

  // `critico: true` porque a política do canal suprime informativas — um
  // aviso de domínio prestes a morrer não pode ser engolido por isso.
  const resultados = await require('./index').espelhar(texto, {
    critico: true,
    chaveAlerta: `vencendo:${new Date().toISOString().slice(0, 10)}`,
  });

  console.log(
    `⏳ [VENCENDO] ${lista.length} domínios (${comTrafego.length} com tráfego, ` +
      `${vencidos.length} vencidos) · avisado em ${resultados.filter((r) => r.success).length} canal(is)`
  );

  return {
    encontrados: lista.length,
    comTrafego: comTrafego.length,
    vencidos: vencidos.length,
    enviado: true,
    canais: resultados,
  };
}

module.exports = { enviar, DIAS };
