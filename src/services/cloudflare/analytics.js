// =====================================================
// VIEWS DIÁRIAS VIA CLOUDFLARE
//
// A tabela `domain_analytics` guarda uma linha por domínio com 24 colunas de
// MÊS. Não existe dado diário em lugar nenhum do sistema, e por isso três
// perguntas do time nunca tiveram resposta: quantas views nos últimos 14 dias,
// quando foi a última view, e quantas views nesse último dia.
//
// O Cloudflare tem esse dado. O dataset `httpRequests1dGroups` devolve por dia,
// com cerca de um ano de retenção mesmo no plano gratuito (medido: 353 dias numa
// zona de 2021). Este serviço puxa a série diária e grava os três campos.
//
// MÉTRICA — leia antes de mexer:
// Usamos `requests`, e isso é deliberado. O que o DomainHub chama de "visitas"
// em toda a aplicação é `requests` do Cloudflare, não `pageViews`. Foi medido
// contra 25 domínios de faixas de tráfego diferentes: `requests` bate com
// `domain_analytics` em 25 de 25, com erro mediano de 0,7%; `pageViews` erra
// entre 47% e 100%.
//
// Ou seja: `Visitas/Mês` conta cada ARQUIVO servido (imagem, CSS, fonte), não
// carregamento de página. A mediana medida foi de 3,6 requisições por página,
// mas varia de 1,8 a mais de 4.000 conforme o site — não existe conversão.
//
// Manter `requests` aqui preserva a comparabilidade com a coluna que já existe:
// as três colunas novas falam a mesma língua do resto do export. Trocar para
// `pageViews` daria o número honesto de visualizações, mas colocaria na mesma
// linha dois números 40x diferentes sem explicação. Se algum dia o time decidir
// migrar, é trocar METRICA abaixo e renomear as colunas junto — nunca só uma
// das duas coisas.
// =====================================================

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

const API_REST = 'https://api.cloudflare.com/client/v4';
const API_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

const METRICA = 'requests';

// O Cloudflare aceita no máximo 10 zonas por consulta com escopo de zona.
const ZONAS_POR_CONSULTA = 10;

// A cota é de 300 consultas por janela de 5 minutos. Com ~1.000 zonas são ~100
// consultas; a pausa mantém folga larga mesmo se a base crescer.
const PAUSA_ENTRE_CONSULTAS = 400;

const DIAS = 14;
const REQUEST_TIMEOUT = 30000;
const TENTATIVAS = 3;
const PAUSA_ENTRE_TENTATIVAS = 3000;
const DOMINIOS_POR_GRAVACAO = 20;

class CloudflareAnalyticsService {
  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    this.configurado = !!(config.CLOUDFLARE_EMAIL && config.CLOUDFLARE_API_KEY);
  }

  get cabecalhos() {
    return {
      'X-Auth-Email': config.CLOUDFLARE_EMAIL,
      'X-Auth-Key': config.CLOUDFLARE_API_KEY,
      'Content-Type': 'application/json'
    };
  }

  pausa(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** aaaa-mm-dd em UTC, deslocado por `offset` dias. */
  dataISO(offset = 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Janela de apuração: 14 dias FECHADOS, terminando ontem.
   *
   * O dia corrente fica de fora de propósito. Ele está pela metade — no teste,
   * um domínio que fechava o dia com 12 milhões aparecia com 6 milhões às 15h.
   * Incluí-lo faria todo domínio parecer em queda, e a coluna "views do último
   * dia" mostraria sempre um número menor que a realidade.
   */
  janela() {
    return { de: this.dataISO(-DIAS), ate: this.dataISO(-1) };
  }

  /**
   * Lista as zonas da conta: nome em minúsculo -> zoneTag.
   *
   * Vem do Cloudflare, não do banco: `domains.zone_id` está preenchido em 8 de
   * 2.658 linhas, e os zone_id que existem em `domain_analytics` só cobrem quem
   * já tinha analytics. Perguntar à fonte cobre todas as zonas da conta.
   */
  async listarZonas() {
    const zonas = new Map();
    let pagina = 1;

    for (;;) {
      const { data } = await axios.get(`${API_REST}/zones`, {
        headers: this.cabecalhos,
        params: { per_page: 50, page: pagina },
        timeout: REQUEST_TIMEOUT
      });

      if (!data.success) {
        throw new Error(`Cloudflare recusou a listagem de zonas: ${JSON.stringify(data.errors)}`);
      }

      (data.result || []).forEach((z) => {
        if (z && z.name && z.id) zonas.set(String(z.name).trim().toLowerCase(), z.id);
      });

      const info = data.result_info || {};
      if (!info.total_pages || pagina >= info.total_pages) break;
      pagina += 1;
    }

    return zonas;
  }

  /**
   * Série diária de um lote de zonas.
   *
   * O `zoneTag` volta no próprio resultado, então não dependemos da ordem do
   * array para saber de quem é cada série — o que seria frágil.
   */
  async consultarLote(zoneTags, de, ate) {
    const consulta = {
      query: `{
        viewer {
          zones(filter: { zoneTag_in: ${JSON.stringify(zoneTags)} }) {
            zoneTag
            httpRequests1dGroups(
              limit: ${DIAS + 2}
              filter: { date_geq: "${de}", date_leq: "${ate}" }
              orderBy: [date_DESC]
            ) {
              dimensions { date }
              sum { ${METRICA} }
            }
          }
        }
      }`
    };

    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      try {
        const { data } = await axios.post(API_GRAPHQL, consulta, {
          headers: this.cabecalhos,
          timeout: REQUEST_TIMEOUT
        });

        if (data.errors && data.errors.length) {
          throw new Error(data.errors.map((e) => e.message).join(' | '));
        }

        return ((data.data || {}).viewer || {}).zones || [];
      } catch (erro) {
        const ultima = tentativa === TENTATIVAS;
        console.error(
          `⚠️ [CF-ANALYTICS] Lote falhou (${tentativa}/${TENTATIVAS}): ${erro.message}`
        );
        if (ultima) return null;
        await this.pausa(PAUSA_ENTRE_TENTATIVAS);
      }
    }

    return null;
  }

  /**
   * Calcula os três campos a partir da série diária.
   *
   * "Última view" é o dia mais recente com valor MAIOR QUE ZERO — não o dia mais
   * recente da série. Num domínio parado, a série continua vindo com zeros, e é
   * justamente a data em que o tráfego cessou que interessa para decidir
   * exclusão.
   */
  calcular(serie) {
    const dias = (serie || [])
      .map((d) => ({ data: d.dimensions.date, views: Number(d.sum[METRICA]) || 0 }))
      .sort((a, b) => (a.data < b.data ? 1 : -1));

    const total = dias.reduce((s, d) => s + d.views, 0);
    const ultimo = dias.find((d) => d.views > 0) || null;

    return {
      views_14d: total,
      last_view_date: ultimo ? ultimo.data : null,
      views_last_day: ultimo ? ultimo.views : 0
    };
  }

  async gravar(atualizacoes) {
    let gravados = 0;

    for (let i = 0; i < atualizacoes.length; i += DOMINIOS_POR_GRAVACAO) {
      const lote = atualizacoes.slice(i, i + DOMINIOS_POR_GRAVACAO);

      const resultados = await Promise.all(
        lote.map(({ id, campos }) =>
          this.client
            .from('domains')
            .update(campos)
            .eq('id', id)
            .then(({ error }) => {
              if (error) {
                console.error(`❌ [CF-ANALYTICS] Falha ao gravar ${id}: ${error.message}`);
                return false;
              }
              return true;
            })
        )
      );

      gravados += resultados.filter(Boolean).length;
    }

    return gravados;
  }

  /**
   * Sincroniza os três campos para todo domínio que tenha zona no Cloudflare.
   *
   * Quem não tem zona NÃO é tocado: os campos ficam NULL, e NULL aqui significa
   * "não medido", nunca "sem acesso". São 169 domínios ativos nessa condição —
   * quase todos AtomiCat, hospedados fora do Cloudflare. Gravar zero neles
   * repetiria o erro que a coluna `monthly_visits` já comete.
   */
  async syncDailyViews() {
    if (!this.configurado) {
      console.warn('⚠️ [CF-ANALYTICS] Cloudflare não configurado - views diárias desabilitadas');
      return { sucesso: false, erro: 'Cloudflare não configurado' };
    }

    const inicio = Date.now();
    const { de, ate } = this.janela();
    console.log(`📊 [CF-ANALYTICS] Views diárias de ${de} a ${ate} (${DIAS} dias fechados)`);

    try {
      const zonas = await this.listarZonas();
      console.log(`📊 [CF-ANALYTICS] ${zonas.size} zonas na conta Cloudflare`);

      const { data: dominios, error } = await this.client
        .from('domains')
        .select('id, domain_name');

      if (error) throw new Error(`Supabase: ${error.message}`);

      // domínio -> zona. Comparação em minúsculo: `domains` tem 68 nomes em
      // caixa mista e o Cloudflare devolve tudo minúsculo.
      const comZona = [];
      const semZona = [];

      (dominios || []).forEach((d) => {
        const zona = zonas.get(String(d.domain_name || '').trim().toLowerCase());
        if (zona) comZona.push({ id: d.id, nome: d.domain_name, zona });
        else semZona.push(d.domain_name);
      });

      console.log(
        `📊 [CF-ANALYTICS] ${comZona.length} domínios com zona · ${semZona.length} sem zona (ficam sem medição)`
      );

      const porZona = new Map();
      comZona.forEach((d) => {
        if (!porZona.has(d.zona)) porZona.set(d.zona, []);
        porZona.get(d.zona).push(d);
      });

      const tags = [...porZona.keys()];
      const atualizacoes = [];
      let lotesComFalha = 0;

      for (let i = 0; i < tags.length; i += ZONAS_POR_CONSULTA) {
        const lote = tags.slice(i, i + ZONAS_POR_CONSULTA);
        const zonasResposta = await this.consultarLote(lote, de, ate);

        if (zonasResposta === null) {
          lotesComFalha += 1;
        } else {
          zonasResposta.forEach((z) => {
            const campos = this.calcular(z.httpRequests1dGroups);
            (porZona.get(z.zoneTag) || []).forEach((d) => {
              atualizacoes.push({ id: d.id, campos });
            });
          });
        }

        const feitos = Math.min(i + ZONAS_POR_CONSULTA, tags.length);
        if (feitos % 200 === 0 || feitos === tags.length) {
          console.log(`📊 [CF-ANALYTICS] ${feitos}/${tags.length} zonas consultadas`);
        }

        await this.pausa(PAUSA_ENTRE_CONSULTAS);
      }

      const gravados = await this.gravar(atualizacoes);
      const segundos = Math.round((Date.now() - inicio) / 1000);

      const comAcesso = atualizacoes.filter((a) => a.campos.views_14d > 0).length;
      console.log(
        `✅ [CF-ANALYTICS] ${gravados} domínios atualizados em ${segundos}s ` +
          `(${comAcesso} com acesso nos ${DIAS} dias)` +
          (lotesComFalha ? ` · ${lotesComFalha} lote(s) falharam` : '')
      );

      return {
        sucesso: true,
        zonas: zonas.size,
        atualizados: gravados,
        semZona: semZona.length,
        lotesComFalha,
        segundos
      };
    } catch (erro) {
      console.error(`❌ [CF-ANALYTICS] Falha na sincronização: ${erro.message}`);
      return { sucesso: false, erro: erro.message };
    }
  }
}

module.exports = new CloudflareAnalyticsService();
