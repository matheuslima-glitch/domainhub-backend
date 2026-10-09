// =====================================================
// RELATÓRIO DE DOMÍNIOS CRÍTICOS — PARA GRUPO
//
// Monta e envia o resumo de domínios suspensos, expirados e a expirar.
//
// POR QUE ELE EXISTE, SE JÁ HAVIA UM RELATÓRIO
//
// O relatório que existia é por PESSOA. Para ele sair, sete condições
// precisam estar satisfeitas ao mesmo tempo (ver o cron de notificações em
// server.js): contato ativo, algum `alert_*` ligado, hoje estar em
// `notification_days`, a hora bater com `notification_interval_hours`, não ter
// estourado `notification_frequency`, haver domínio crítico, e só então o
// envio acontece — e é dali que os canais paralelos são espelhados.
//
// Essas condições fazem sentido para o WhatsApp, onde cada contato tem número,
// horário e limite próprios. NÃO fazem sentido para um GRUPO: um grupo não tem
// preferência individual, e filtrar a mensagem dele pela agenda de uma pessoa
// é acoplar duas coisas que não têm relação.
//
// Pior: em 09/10/2026 as notificações estavam em silêncio total, e o silêncio
// pode estar em qualquer uma das sete portas. Pendurar o grupo na mesma
// corrente faria o canal novo nascer mudo pelo mesmo motivo.
//
// Por isso este módulo lê o banco por conta própria e tem cron próprio.
//
// CONTAGEM EXATA, LISTA CURTA — a distinção importa:
// As contagens vêm de `count: 'exact', head: true`, que o PostgREST responde
// com o total real. As LISTAS de nomes vêm com `.limit()` explícito.
//
// Isso é deliberado: o PostgREST corta resposta em 1.000 linhas SEM AVISAR, e
// este projeto já foi mordido por isso quatro vezes. Uma contagem derivada de
// `data.length` diria "1.000 expirando" para sempre, a partir de 1.001. Com
// `head: true` o número é o verdadeiro, e o corte da lista é escolha nossa e
// está escrito na mensagem.
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

// Quantos nomes aparecem por bloco. O Telegram aceita 4.096 caracteres; com
// três blocos de 8 sobra folga larga para os cabeçalhos e o rodapé.
const NOMES_POR_BLOCO = 8;

// Janela de "vai expirar". Mesma do relatório por pessoa, para os dois não
// discordarem sobre o que é urgente.
const DIAS_PARA_EXPIRAR = 15;

const COLUNAS = 'domain_name, status, expiration_date, requests_30d, traffic_source';

class RelatorioCriticos {
  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  /** Total real da consulta, sem trazer as linhas. Imune ao teto de 1.000. */
  async contar(montar) {
    const { count, error } = await montar(
      this.client.from('domains').select('*', { count: 'exact', head: true })
    );
    if (error) throw new Error(`Supabase (contagem): ${error.message}`);
    return count || 0;
  }

  /**
   * Os N domínios mais relevantes do grupo.
   *
   * Ordenado por `requests_30d` — tráfego VIVO dos últimos 30 dias, escrito
   * todo dia pelo coletor da Cloudflare. O relatório por pessoa ordena por
   * `monthly_visits`, que é a importação congelada de 15/08/2026 e não se move
   * desde então; um domínio que morreu em setembro ainda aparece no topo dela.
   *
   * `nullsFirst: false` põe quem não tem medição no fim: domínio sem zona na
   * Cloudflare não é "o menos importante", é "desconhecido", e desconhecido
   * não deve ocupar o topo de uma lista de urgência.
   */
  async listar(montar) {
    const { data, error } = await montar(this.client.from('domains').select(COLUNAS))
      .order('requests_30d', { ascending: false, nullsFirst: false })
      .limit(NOMES_POR_BLOCO);
    if (error) throw new Error(`Supabase (lista): ${error.message}`);
    return data || [];
  }

  /** `1.348 req/30d`, ou nada quando o domínio não é medido. */
  rotuloTrafego(d) {
    if (d.requests_30d == null) return '';
    return ` — ${Number(d.requests_30d).toLocaleString('pt-BR')} req/30d`;
  }

  /** `12/10` a partir de uma data ISO. Vazio quando não há data. */
  rotuloData(d) {
    if (!d.expiration_date) return '';
    const iso = String(d.expiration_date).slice(0, 10);
    return ` — vence ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  }

  bloco(titulo, total, linhas, detalhe) {
    if (!total) return null;

    const nomes = linhas.map((d) => `• ${d.domain_name}${detalhe(d)}`);
    const resto = total > linhas.length ? [`• …e mais ${total - linhas.length}`] : [];

    return [`*${titulo}: ${total}*`, ...nomes, ...resto].join('\n');
  }

  /**
   * Monta o texto. Devolve `null` quando NÃO há nada crítico.
   *
   * Nulo em vez de "0 domínios críticos": o grupo recebe tudo exceto sucessos,
   * e "está tudo bem" é um sucesso. Avisar duas vezes por dia que não há nada
   * treina as pessoas a ignorar o canal, que é o oposto do que ele serve.
   */
  async montar() {
    const limite = new Date();
    limite.setDate(limite.getDate() + DIAS_PARA_EXPIRAR);
    const agoraISO = new Date().toISOString();
    const limiteISO = limite.toISOString();

    const expirando = (q) =>
      q.eq('status', 'active').gte('expiration_date', agoraISO).lte('expiration_date', limiteISO);

    const [nSusp, nExp, nVence] = await Promise.all([
      this.contar((q) => q.eq('status', 'suspended')),
      this.contar((q) => q.eq('status', 'expired')),
      this.contar(expirando)
    ]);

    if (!nSusp && !nExp && !nVence) return null;

    const [lSusp, lExp, lVence] = await Promise.all([
      nSusp ? this.listar((q) => q.eq('status', 'suspended')) : [],
      nExp ? this.listar((q) => q.eq('status', 'expired')) : [],
      nVence ? this.listar(expirando) : []
    ]);

    const blocos = [
      this.bloco('🔴 Suspensos', nSusp, lSusp, (d) => this.rotuloTrafego(d)),
      this.bloco('⛔ Expirados', nExp, lExp, (d) => this.rotuloTrafego(d)),
      this.bloco(`🟡 Expiram em ${DIAS_PARA_EXPIRAR} dias`, nVence, lVence, (d) => this.rotuloData(d))
    ].filter(Boolean);

    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    return [
      '*🚨 Domínios críticos*',
      '',
      blocos.join('\n\n'),
      '',
      `_Apurado em ${quando} (Brasília)_`
    ].join('\n');
  }

  /**
   * Monta e envia. Chamado pelo cron.
   *
   * Vai pelo DISTRIBUIDOR, não direto no Telegram: assim o Discord recebe o
   * mesmo relatório assim que o webhook dele for consertado, sem precisar de
   * outra alteração aqui.
   */
  async enviar() {
    try {
      const texto = await this.montar();

      if (!texto) {
        console.log('✅ [CRITICOS] Nenhum domínio crítico - nada a enviar');
        return { success: true, vazio: true };
      }

      const resultados = await require('./index').espelhar(texto, { critico: true });

      resultados.forEach((r) => {
        console.log(
          `${r.success ? '✅' : '❌'} [CRITICOS] ${r.canal}: ${r.success ? 'enviado' : r.error}`
        );
      });

      return { success: true, resultados };
    } catch (error) {
      console.error('❌ [CRITICOS] Falha ao montar ou enviar:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new RelatorioCriticos();
