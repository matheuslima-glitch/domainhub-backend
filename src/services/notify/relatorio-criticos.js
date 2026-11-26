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
// TODOS OS DOMÍNIOS, NA PRÓPRIA MENSAGEM
//
// Até 26/11/2026 cada bloco mostrava 8 nomes e terminava em "…e mais N". O
// time reclamou: quem recebe o alerta precisa ver a lista inteira ali, sem
// abrir o painel. Agora todos os domínios entram.
//
// O limite de tamanho continua existindo — Discord aceita 2.000 caracteres
// por mensagem (já contando o @everyone) e Telegram, 4.096 — e os dois CORTAM
// o que passa. Então, quando a lista não cabe, ela segue em mais mensagens
// ("parte 1/3", "parte 2/3"...), nunca cortando um domínio ao meio. A divisão
// é feita NO TAMANHO DE CADA CANAL (ver espelharEmPartes, em index.js): o
// Telegram, canal principal, recebe metade das mensagens que o Discord. Só a
// primeira parte menciona o grupo no Discord: as outras são continuação, e
// três @everyone seguidos treinam as pessoas a silenciar o canal.
//
// CONTAGEM EXATA E LISTA COMPLETA — o teto de 1.000:
// O PostgREST corta resposta em 1.000 linhas SEM AVISAR, e este projeto já foi
// mordido por isso quatro vezes. As contagens vêm de `count: 'exact', head:
// true`, que responde o total real; as listas vêm em páginas de 1.000 até
// acabar. Assim nenhum dos dois para em 1.000 calado.
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

// Janela de "vai expirar". Mesma do relatório por pessoa, para os dois não
// discordarem sobre o que é urgente.
const DIAS_PARA_EXPIRAR = 15;

// Tamanho padrão de cada parte em `montar()`, que serve à rota de diagnóstico
// e às provas. No envio, quem manda é o limite de cada canal (index.js).
const TAMANHO_PARTE = 1800;

// Página do PostgREST. Ele nunca devolve mais que isto por chamada.
const PAGINA = 1000;

const COLUNAS = 'domain_name, status, expiration_date, requests_30d, traffic_source';

const CABECALHO = '*🚨 Domínios críticos*';

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
   * TODOS os domínios do grupo, de 1.000 em 1.000.
   *
   * `ordem` é a lista de [coluna, opções] na ordem de prioridade. Suspensos e
   * expirados vêm por `requests_30d` — tráfego VIVO dos últimos 30 dias, e
   * quem não é medido vai para o fim (`nullsFirst: false`): desconhecido não
   * deve ocupar o topo de uma lista de urgência. Os que vão expirar vêm por
   * DATA, do mais próximo para o mais distante: é a ordem em que alguém
   * precisa agir.
   */
  async listar(montar, ordem) {
    const todos = [];
    for (let de = 0; ; de += PAGINA) {
      let consulta = montar(this.client.from('domains').select(COLUNAS));
      for (const [coluna, opcoes] of ordem) consulta = consulta.order(coluna, opcoes);
      const { data, error } = await consulta.range(de, de + PAGINA - 1);
      if (error) throw new Error(`Supabase (lista): ${error.message}`);
      todos.push(...(data || []));
      if (!data || data.length < PAGINA) break;
    }
    return todos;
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

  /** O bloco como lista de linhas: título com o total e TODOS os domínios. */
  bloco(titulo, total, linhas, detalhe) {
    if (!total) return null;
    return {
      titulo: `*${titulo}: ${total}*`,
      continuacao: `*${titulo} (continuação)*`,
      nomes: linhas.map((d) => `• ${d.domain_name}${detalhe(d)}`)
    };
  }

  /**
   * Divide o relatório em partes de até `limite` caracteres, sem nunca cortar
   * uma linha. Quando um bloco atravessa a divisa, a parte nova repete o título
   * dele como "(continuação)", para quem lê saber de que lista é aquele nome.
   * Com mais de uma parte, o cabeçalho de cada uma ganha "(parte i/n)".
   *
   * Pura: não toca banco nem rede. É o que as provas exercitam.
   */
  dividirEmPartes(blocos, rodape, limite = TAMANHO_PARTE) {
    const partes = [];
    let atual = [];

    const tamanho = (linhas) => linhas.join('\n').length;
    // O cabeçalho final pode ganhar " (parte 10/10)": reserva o espaço.
    const cabe = (linhas, nova) => tamanho([...linhas, nova]) + 16 <= limite;
    const abrir = () => { atual = [CABECALHO, '']; };
    const fechar = () => {
      while (atual.length && atual[atual.length - 1] === '') atual.pop();
      partes.push(atual);
    };

    abrir();
    blocos.forEach((b, i) => {
      if (i > 0) {
        if (cabe(atual, '') && cabe([...atual, ''], b.titulo)) atual.push('');
      }
      // O título só fica nesta parte se couber junto com o primeiro domínio:
      // título solto no fim de uma mensagem não diz nada.
      if (!cabe([...atual, b.titulo], b.nomes[0] || '')) { fechar(); abrir(); }
      atual.push(b.titulo);
      for (const nome of b.nomes) {
        if (!cabe(atual, nome)) {
          fechar();
          abrir();
          atual.push(b.continuacao);
        }
        atual.push(nome);
      }
    });

    if (!cabe(atual, '') || !cabe([...atual, ''], rodape)) { fechar(); abrir(); }
    atual.push('', rodape);
    fechar();

    const n = partes.length;
    return partes.map((linhas, i) => {
      if (n > 1) linhas[0] = `*🚨 Domínios críticos (parte ${i + 1}/${n})*`;
      return linhas.join('\n');
    });
  }

  /**
   * Consulta o banco e devolve os blocos e o rodapé, ou `null` quando NÃO há
   * nada crítico.
   *
   * Nulo em vez de "0 domínios críticos": o grupo recebe tudo exceto sucessos,
   * e "está tudo bem" é um sucesso. Avisar duas vezes por dia que não há nada
   * treina as pessoas a ignorar o canal, que é o oposto do que ele serve.
   */
  async apurar() {
    const limite = new Date();
    limite.setDate(limite.getDate() + DIAS_PARA_EXPIRAR);
    const agoraISO = new Date().toISOString();
    const limiteISO = limite.toISOString();

    const expirando = (q) =>
      q.eq('status', 'active').gte('expiration_date', agoraISO).lte('expiration_date', limiteISO);

    const porTrafego = [['requests_30d', { ascending: false, nullsFirst: false }], ['domain_name', { ascending: true }]];
    const porData = [['expiration_date', { ascending: true }], ['domain_name', { ascending: true }]];

    const [nSusp, nExp, nVence] = await Promise.all([
      this.contar((q) => q.eq('status', 'suspended')),
      this.contar((q) => q.eq('status', 'expired')),
      this.contar(expirando)
    ]);

    if (!nSusp && !nExp && !nVence) return null;

    const [lSusp, lExp, lVence] = await Promise.all([
      nSusp ? this.listar((q) => q.eq('status', 'suspended'), porTrafego) : [],
      nExp ? this.listar((q) => q.eq('status', 'expired'), porTrafego) : [],
      nVence ? this.listar(expirando, porData) : []
    ]);

    const blocos = [
      this.bloco('🔴 Suspensos', nSusp, lSusp, (d) => this.rotuloTrafego(d)),
      this.bloco('⛔ Expirados', nExp, lExp, (d) => this.rotuloTrafego(d)),
      this.bloco(`🟡 Expiram em ${DIAS_PARA_EXPIRAR} dias`, nVence, lVence, (d) => this.rotuloData(d))
    ].filter(Boolean);

    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return { blocos, rodape: `_Apurado em ${quando} (Brasília)_` };
  }

  /** As mensagens prontas, num tamanho de parte. `null` se nada é crítico. */
  async montar(limite = TAMANHO_PARTE) {
    const dados = await this.apurar();
    return dados ? this.dividirEmPartes(dados.blocos, dados.rodape, limite) : null;
  }

  /**
   * Apura e envia. Chamado pelo cron e pela rota de diagnóstico.
   *
   * Vai pelo DISTRIBUIDOR (`espelharEmPartes`), que divide o texto no tamanho
   * de cada canal e manda as partes em ordem; só a primeira menciona o grupo.
   */
  async enviar() {
    try {
      const dados = await this.apurar();

      if (!dados) {
        console.log('✅ [CRITICOS] Nenhum domínio crítico - nada a enviar');
        return { success: true, vazio: true };
      }

      const resultados = await require('./index').espelharEmPartes(
        (limite) => this.dividirEmPartes(dados.blocos, dados.rodape, limite),
        { critico: true }
      );
      resultados.forEach((c) => {
        console.log(
          `${c.success ? '✅' : '❌'} [CRITICOS] ${c.canal}${c.partes ? ` (parte ${c.parte}/${c.partes})` : ''}: ${c.success ? 'enviado' : c.error}`
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
module.exports.TAMANHO_PARTE = TAMANHO_PARTE;
