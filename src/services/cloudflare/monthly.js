// =====================================================
// SÉRIE MENSAL — visitantes únicos e requisições, mês a mês
//
// POR QUE ESTE SERVIÇO NASCEU
//
// O DomainHub nunca teve coleta mensal. `domains.monthly_visits` e a tabela
// `domain_analytics` (uma linha por domínio, 24 colunas de mês) são dado
// CONGELADO: vieram de uma importação em 15/08/2026 e nenhum serviço escreve
// neles. Não havia, portanto, "métrica mensal para trocar" — havia uma coleta
// para criar.
//
// Este serviço grava em `domain_monthly_stats`, tabela nova, no formato longo
// (uma linha por domínio E mês). Ele NÃO toca em `domain_analytics` nem em
// `monthly_visits`, que seguem como estavam.
//
// AS DUAS MÉTRICAS, LADO A LADO
//
// Cada linha guarda `uniques` e `requests` do mesmo mês, de propósito. São
// respostas a perguntas diferentes — quanta gente esteve no site, e quanto o
// site foi acionado — e a razão entre elas varia de 2,2x a 1.125x conforme o
// domínio. Guardar as duas juntas deixa o painel comparar sem cruzar tabelas.
//
// UNIQUES NÃO SE SOMAM — vale aqui como vale na janela de 14 dias
//
// O mês inteiro vem de UMA consulta, sem a dimensão de data. Fechar dia a dia e
// somar contaria de novo cada visitante que voltou, o que num mês é ainda pior
// que em duas semanas. É a ausência de `dimensions` que faz a Cloudflare
// deduplicar no período pedido.
//
// ATÉ ONDE O HISTÓRICO ALCANÇA (medido em 10/09/2026, amostra de 150 zonas)
//
//   08/2026  88% das zonas com dado      01/2026  40%
//   07/2026  83%                         12/2025  23%
//   06/2026  75%                         11/2025  10%
//   05/2026  67%                         10/2025   8%
//   04/2026  54%                         -----------------------------------
//   03/2026  47%                         09/2025 e antes: FORA DA RETENÇÃO
//   02/2026  40%                         (a Cloudflare recusa: 52 semanas)
//
// A queda para trás não é falha de coleta: são domínios que ainda não existiam.
// Mês sem dado não vira linha — ausência de linha é "não medido", e nunca
// aparece como zero em lugar nenhum.
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

// Reaproveita listagem de zonas, cabeçalhos, pausa e a política de tentativas
// do coletor diário. São exatamente as mesmas regras contra a mesma API.
const analytics = require('./analytics');

const ZONAS_POR_CONSULTA = 10;

// Fechamento de um mês só: ~103 consultas, folgado dentro da cota de 300 por
// 5 minutos — a mesma pausa do coletor diário serve.
const PAUSA_CRON = 400;

// Backfill: 11 meses × ~104 lotes = ~1.144 consultas. Aí a cota aperta de
// verdade, então descemos para ~1 consulta por segundo.
const PAUSA_BACKFILL = 1100;

// Quanto custa DE FATO um lote no ritmo do backfill: a pausa acima mais o
// tempo de ida e volta da consulta. Medido em 11/09/2026 — um mês com 1.032
// zonas levou 286s em 104 lotes. Serve só para a estimativa que o script
// imprime; errar aqui não quebra nada, só desinforma quem está esperando.
const SEGUNDOS_POR_LOTE = 2.8;

const MESES_BACKFILL_PADRAO = 11;
const LINHAS_POR_UPSERT = 500;
const DOMINIOS_POR_GRAVACAO = 20;

class CloudflareMonthlyService {
  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    this.configurado = !!(config.CLOUDFLARE_EMAIL && config.CLOUDFLARE_API_KEY);
  }

  /**
   * Um mês fechado, `voltar` meses atrás. voltar=1 é o mês passado.
   *
   * Tudo em UTC, como o resto do coletor. O mês CORRENTE nunca entra: estaria
   * pela metade e faria todo domínio parecer em queda.
   */
  periodo(voltar) {
    const hoje = new Date();
    const primeiro = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - voltar, 1));
    const ultimo = new Date(Date.UTC(primeiro.getUTCFullYear(), primeiro.getUTCMonth() + 1, 0));

    const ano = primeiro.getUTCFullYear();
    const mes = primeiro.getUTCMonth() + 1;

    return {
      ano,
      mes,
      de: primeiro.toISOString().slice(0, 10),
      ate: ultimo.toISOString().slice(0, 10),
      rotulo: `${String(mes).padStart(2, '0')}/${ano}`
    };
  }

  /**
   * zoneTag -> domínios daquela zona.
   *
   * Mesma regra do coletor diário: as zonas vêm da Cloudflare (o `zone_id` de
   * `domains` está preenchido em 8 de 2.658 linhas) e o casamento é por nome em
   * minúsculo, porque `domains` tem 68 nomes em caixa mista.
   *
   * A lista é de domínios, não de zonas: quando o mesmo nome está cadastrado
   * duas vezes, as duas linhas recebem o mesmo número.
   */
  async mapearDominiosPorZona() {
    const zonas = await analytics.listarZonas();

    // Paginado: `.select()` direto pararia em 1.000 das 2.697 linhas, sem
    // reclamar. Ver listarDominios() em analytics.js.
    const dominios = await analytics.listarDominios();

    const porZona = new Map();
    let semZona = 0;

    (dominios || []).forEach((d) => {
      const tag = zonas.get(String(d.domain_name || '').trim().toLowerCase());
      if (!tag) {
        semZona += 1;
        return;
      }
      if (!porZona.has(tag)) porZona.set(tag, []);
      porZona.get(tag).push({ id: d.id, nome: d.domain_name });
    });

    return { porZona, semZona, totalZonas: zonas.size, totalDominios: dominios.length };
  }

  /**
   * O mês inteiro de um lote de zonas, num grupo só por zona.
   *
   * Sem `dimensions`: é isso que faz a dedução valer o mês todo. Ver o cabeçalho.
   */
  async consultarMes(zoneTags, de, ate) {
    const zonas = await analytics.executar(`{
      viewer {
        zones(filter: { zoneTag_in: ${JSON.stringify(zoneTags)} }) {
          zoneTag
          httpRequests1dGroups(
            limit: 1
            filter: { date_geq: "${de}", date_leq: "${ate}" }
          ) {
            sum { requests pageViews }
            uniq { uniques }
          }
        }
      }
    }`, `Mês ${de.slice(0, 7)}`);

    if (zonas === null) return null;

    const porTag = new Map();

    zonas.forEach((z) => {
      const grupo = (z.httpRequests1dGroups || [])[0];
      if (!grupo) return;

      porTag.set(z.zoneTag, {
        uniques: Number(grupo.uniq.uniques) || 0,
        requests: Number(grupo.sum.requests) || 0,
        pageViews: Number(grupo.sum.pageViews) || 0
      });
    });

    return porTag;
  }

  /** Grava a série mensal em lotes. */
  async gravarSerie(linhas) {
    let gravadas = 0;

    for (let i = 0; i < linhas.length; i += LINHAS_POR_UPSERT) {
      const lote = linhas.slice(i, i + LINHAS_POR_UPSERT);

      const { error } = await this.client
        .from('domain_monthly_stats')
        .upsert(lote, { onConflict: 'domain_id,ano,mes' });

      if (error) {
        console.error(`❌ [CF-MENSAL] Falha ao gravar lote: ${error.message}`);
        continue;
      }

      gravadas += lote.length;
    }

    return gravadas;
  }

  /**
   * Espelha o mês mais recente em `domains`, para o painel ler sem join.
   *
   * `monthly_uniques_ref` diz a que mês o número se refere. É a correção do
   * problema que `monthly_visits` tem hoje: lá o mês precisa ser DEDUZIDO
   * comparando o valor com as 24 colunas de `domain_analytics`, e erra em 0,3%
   * das linhas.
   */
  async espelharEmDomains(atualizacoes) {
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
                console.error(`❌ [CF-MENSAL] Falha ao espelhar ${id}: ${error.message}`);
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
   * Fecha UM mês para todos os domínios com zona.
   *
   * @param {number}  voltar            quantos meses atrás (1 = mês passado)
   * @param {boolean} opcoes.espelhar    também grava em `domains` (só para o mês mais recente)
   * @param {number}  opcoes.pausa       intervalo entre consultas
   * @param {Map}     opcoes.porZona     mapa já montado, para o backfill não refazer a cada mês
   */
  async fecharMes(voltar = 1, opcoes = {}) {
    if (!this.configurado) {
      return { sucesso: false, erro: 'Cloudflare não configurado' };
    }

    if (!config.COLETA_UNIQUES) {
      console.warn('⏸️ [CF-MENSAL] COLETA_UNIQUES=false - fechamento mensal ignorado');
      return { sucesso: false, erro: 'COLETA_UNIQUES desligado' };
    }

    const { espelhar = voltar === 1, pausa = PAUSA_CRON } = opcoes;
    const { ano, mes, de, ate, rotulo } = this.periodo(voltar);
    const inicio = Date.now();

    console.log(`📆 [CF-MENSAL] Fechando ${rotulo} (${de} a ${ate})`);

    const { porZona, semZona, totalZonas, totalDominios } =
      opcoes.porZona ? opcoes.porZona : await this.mapearDominiosPorZona();

    if (!opcoes.porZona) {
      console.log(
        `📆 [CF-MENSAL] ${totalDominios} domínios · ${totalZonas} zonas · ` +
          `${semZona} sem zona (ficam sem medição)`
      );
    }

    const tags = [...porZona.keys()];
    const linhas = [];
    const espelhos = [];
    let lotesComFalha = 0;
    let semDado = 0;
    let foraDeRetencao = false;

    for (let i = 0; i < tags.length; i += ZONAS_POR_CONSULTA) {
      const lote = tags.slice(i, i + ZONAS_POR_CONSULTA);
      const medido = await this.consultarMes(lote, de, ate);

      if (medido === null) {
        lotesComFalha += 1;
      } else {
        lote.forEach((tag) => {
          const m = medido.get(tag);

          // Zona sem nada no mês não vira linha. Ausência de linha é
          // "não medido"; gravar 0 diria "não teve visitante", que é outra
          // coisa — e quase sempre falsa, porque o domínio nem existia.
          if (!m || (m.uniques === 0 && m.requests === 0)) {
            semDado += 1;
            return;
          }

          (porZona.get(tag) || []).forEach((d) => {
            linhas.push({
              domain_id: d.id,
              ano,
              mes,
              uniques: m.uniques,
              requests: m.requests,
              page_views: m.pageViews
            });

            if (espelhar) {
              espelhos.push({
                id: d.id,
                campos: { monthly_uniques: m.uniques, monthly_uniques_ref: de }
              });
            }
          });
        });
      }

      const feitos = Math.min(i + ZONAS_POR_CONSULTA, tags.length);
      if (feitos % 300 === 0 || feitos === tags.length) {
        console.log(`📆 [CF-MENSAL] ${rotulo}: ${feitos}/${tags.length} zonas`);
      }

      await analytics.pausa(pausa);
    }

    // Lote inteiro falhando costuma ser retenção, não instabilidade. Vale
    // dizer isso em voz alta: em 09/2025 e antes a Cloudflare recusa sempre, e
    // insistir não adianta.
    if (lotesComFalha === Math.ceil(tags.length / ZONAS_POR_CONSULTA)) {
      foraDeRetencao = true;
      console.warn(`⚠️ [CF-MENSAL] ${rotulo}: nenhum lote respondeu — provavelmente fora da retenção`);
    }

    const gravadas = await this.gravarSerie(linhas);
    const espelhados = espelhar ? await this.espelharEmDomains(espelhos) : 0;
    const segundos = Math.round((Date.now() - inicio) / 1000);

    const totalUniques = linhas.reduce((s, l) => s + l.uniques, 0);

    console.log(
      `✅ [CF-MENSAL] ${rotulo}: ${gravadas} linhas em ${segundos}s · ` +
        `${totalUniques.toLocaleString('pt-BR')} únicos · ${semDado} zonas sem dado` +
        (espelhar ? ` · ${espelhados} espelhados em domains` : '') +
        (lotesComFalha ? ` · ${lotesComFalha} lote(s) falharam` : '')
    );

    return {
      sucesso: !foraDeRetencao,
      rotulo,
      ano,
      mes,
      linhas: gravadas,
      espelhados,
      semDado,
      lotesComFalha,
      foraDeRetencao,
      segundos
    };
  }

  /**
   * Preenche o histórico, do mês passado para trás.
   *
   * Para sozinho ao bater na retenção — não adianta pedir 09/2025.
   *
   * O mapa de zonas é montado UMA vez e reaproveitado em todos os meses: são
   * ~21 páginas de listagem que não precisam ser repetidas 11 vezes.
   */
  async backfill(meses = MESES_BACKFILL_PADRAO) {
    if (!this.configurado) {
      return { sucesso: false, erro: 'Cloudflare não configurado' };
    }

    const inicio = Date.now();

    console.log('═══════════════════════════════════════════════════');
    console.log(`📆 [CF-MENSAL] BACKFILL de ${meses} meses`);
    console.log('═══════════════════════════════════════════════════');

    const mapa = await this.mapearDominiosPorZona();
    console.log(
      `📆 [CF-MENSAL] ${mapa.totalDominios} domínios · ${mapa.totalZonas} zonas · ` +
        `${mapa.semZona} sem zona`
    );

    // A estimativa só sai AQUI, depois de saber quantas zonas existem de fato.
    // Antes ela era impressa antes da contagem, chutando 103 lotes, e somava
    // apenas as pausas: prometia 20 minutos onde a rodada leva quase uma hora.
    // Medido em 11/09/2026: um mês com 1.032 zonas levou 286s, ou ~2,8s por
    // lote — a pausa de 1,1s mais o tempo de ida e volta da consulta.
    const lotes = Math.ceil(mapa.porZona.size / ZONAS_POR_CONSULTA);
    const minutosEstimados = Math.round((lotes * meses * SEGUNDOS_POR_LOTE) / 60);
    console.log(`📆 [CF-MENSAL] ~${lotes * meses} consultas, ~${minutosEstimados} minutos`);

    const resultados = [];

    for (let voltar = 1; voltar <= meses; voltar++) {
      const r = await this.fecharMes(voltar, {
        espelhar: voltar === 1,
        pausa: PAUSA_BACKFILL,
        porZona: mapa
      });

      resultados.push(r);

      if (r.foraDeRetencao) {
        console.log(`📆 [CF-MENSAL] Retenção alcançada em ${r.rotulo}. Parando.`);
        break;
      }
    }

    const minutos = Math.round((Date.now() - inicio) / 60000);
    const totalLinhas = resultados.reduce((s, r) => s + (r.linhas || 0), 0);

    console.log('═══════════════════════════════════════════════════');
    console.log(`✅ [CF-MENSAL] Backfill terminado em ${minutos} min · ${totalLinhas} linhas`);
    resultados.forEach((r) => {
      console.log(`   ${r.rotulo}: ${String(r.linhas || 0).padStart(5)} linhas${r.foraDeRetencao ? '  (fora da retenção)' : ''}`);
    });
    console.log('═══════════════════════════════════════════════════');

    return { sucesso: true, meses: resultados, totalLinhas, minutos };
  }
}

module.exports = new CloudflareMonthlyService();
