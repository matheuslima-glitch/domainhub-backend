// =====================================================
// SINCRONIZAÇÃO DE DOMÍNIOS EXTERNOS VIA RDAP
//
// A sincronização da Namecheap só enxerga o que está DENTRO da conta Namecheap.
// Domínios registrados em outros lugares (GoDaddy, Registro.br via HostGator)
// nunca eram visitados: a data ficava congelada no valor cadastrado e uma
// suspensão jamais era detectada.
//
// O RDAP é o protocolo público que substituiu o WHOIS. Funciona para
// praticamente qualquer TLD, sem chave de API e sem whitelist de IP — por isso
// atende todos os registradores externos com uma implementação só.
//
// LIMITE CONHECIDO: o RDAP não informa se o domínio é nosso (WHOIS é anonimizado
// desde o GDPR) nem o estado da renovação automática. O cadastro inicial do
// domínio continua manual; daqui pra frente data e status se mantêm sozinhos.
// =====================================================

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../../config/env');

const RDAP_BOOTSTRAP = 'https://rdap.org/domain/';
const REQUEST_TIMEOUT = 30000;
const DELAY_ENTRE_CONSULTAS = 1000;
const TENTATIVAS = 3;
const DELAY_ENTRE_TENTATIVAS = 3000;

class RdapDomainsService {
  constructor() {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Consulta um domínio no registro público.
   *
   * O rdap.org é um bootstrap: redireciona para o servidor RDAP do TLD. Esse
   * redirect é intermitente (já vimos timeout em .com.br), então tenta de novo
   * antes de desistir — falha transitória não pode deixar domínio sem verificação.
   *
   * IMPORTANTE: quando devolve erro, quem chama NÃO deve gravar nada. É melhor
   * manter o dado anterior do que sobrescrever com um palpite.
   *
   * @returns {Promise<{found:boolean, expirationDate:string|null, rawStatus:string[], error:string|null}>}
   */
  async lookup(domainName) {
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      try {
        const response = await axios.get(`${RDAP_BOOTSTRAP}${encodeURIComponent(domainName)}`, {
          timeout: REQUEST_TIMEOUT,
          maxRedirects: 5,
          headers: { Accept: 'application/rdap+json' },
          // 404 é resposta legítima: significa domínio não registrado
          validateStatus: (s) => s === 200 || s === 404
        });

        if (response.status === 404) {
          return { found: false, expirationDate: null, rawStatus: [], error: null };
        }

        const data = response.data || {};
        const events = Array.isArray(data.events) ? data.events : [];
        const expiration = events.find((e) => e.eventAction === 'expiration');

        return {
          found: true,
          expirationDate: expiration?.eventDate || null,
          rawStatus: (Array.isArray(data.status) ? data.status : []).map((s) => String(s).toLowerCase()),
          error: null
        };
      } catch (error) {
        ultimoErro = error.message;
        if (tentativa < TENTATIVAS) {
          console.warn(`   ⏳ [RDAP] ${domainName}: tentativa ${tentativa}/${TENTATIVAS} falhou (${error.message}), repetindo...`);
          await this.delay(DELAY_ENTRE_TENTATIVAS);
        }
      }
    }

    return { found: false, expirationDate: null, rawStatus: [], error: ultimoErro };
  }

  /**
   * Traduz o status do RDAP para o enum domain_status do banco.
   *
   * A ordem importa: domínio em resgate carrega TAMBÉM "server hold", então
   * redemption precisa ser avaliado antes de hold, senão viraria "suspended".
   */
  mapStatus(rawStatus, expirationDate) {
    const tem = (termo) => rawStatus.some((s) => s.includes(termo));

    if (tem('redemption') || tem('pending delete')) {
      return {
        status: 'expired',
        alerta:
          'Domínio em período de resgate (redemption) no registro. Recuperável apenas mediante taxa, e por tempo limitado.'
      };
    }

    if (tem('hold')) {
      return {
        status: 'suspended',
        alerta: 'Domínio suspenso ou bloqueado no registro — não está resolvendo.'
      };
    }

    if (expirationDate && new Date(expirationDate) < new Date()) {
      return { status: 'expired', alerta: null };
    }

    return { status: 'active', alerta: null };
  }

  /**
   * Domínios que a sincronização da Namecheap não cobre.
   *
   * Linhas com registrar nulo são DELIBERADAMENTE ignoradas: são registros
   * antigos de origem desconhecida, e assumir que são externos faria o RDAP
   * sobrescrever dados que a Namecheap gerencia.
   */
  async listExternalDomains() {
    const { data, error } = await this.client
      .from('domains')
      .select('id, user_id, domain_name, status, expiration_date, registrar, manually_deactivated')
      .not('registrar', 'is', null)
      .not('registrar', 'ilike', 'namecheap')
      .order('domain_name');

    if (error) throw error;

    return (data || []).filter((d) => d.manually_deactivated !== true && d.status !== 'deactivated');
  }

  /**
   * Percorre os domínios externos, atualiza data e status, e dispara os mesmos
   * alertas de WhatsApp usados pelo fluxo da Namecheap quando o status muda.
   */
  async syncExternalDomains() {
    const resultados = { verificados: 0, atualizados: 0, semMudanca: 0, naoRegistrados: 0, falhas: 0, erros: [] };

    let domains;
    try {
      domains = await this.listExternalDomains();
    } catch (error) {
      console.error(`❌ [RDAP] Não foi possível listar domínios externos: ${error.message}`);
      resultados.falhas++;
      return resultados;
    }

    if (domains.length === 0) {
      console.log('ℹ️ [RDAP] Nenhum domínio externo cadastrado');
      return resultados;
    }

    console.log(`\n🌐 [RDAP] Verificando ${domains.length} domínio(s) externo(s)`);
    console.log(`   ${domains.map((d) => `${d.domain_name} (${d.registrar})`).join(', ')}\n`);

    for (const row of domains) {
      resultados.verificados++;

      const consulta = await this.lookup(row.domain_name);

      if (consulta.error) {
        console.warn(`⚠️ [RDAP] Falha ao consultar ${row.domain_name}: ${consulta.error}`);
        resultados.falhas++;
        resultados.erros.push({ domain: row.domain_name, error: consulta.error });
        await this.delay(DELAY_ENTRE_CONSULTAS);
        continue;
      }

      let novoStatus;
      let novoAlerta;
      let novaExpiracao = row.expiration_date;

      if (!consulta.found) {
        // Domínio saiu do registro: foi liberado e pode ser registrado por terceiros
        novoStatus = 'expired';
        novoAlerta = 'Domínio não está mais registrado — foi liberado no registro público e pode ser adquirido por terceiros.';
        resultados.naoRegistrados++;
        console.error(`🚨 [RDAP] ${row.domain_name} NÃO ESTÁ MAIS REGISTRADO`);
      } else {
        const mapeado = this.mapStatus(consulta.rawStatus, consulta.expirationDate);
        novoStatus = mapeado.status;
        novoAlerta = mapeado.alerta;
        if (consulta.expirationDate) novaExpiracao = consulta.expirationDate;
      }

      const statusMudou = row.status !== novoStatus;
      const dataMudou =
        !!novaExpiracao &&
        (!row.expiration_date ||
          new Date(novaExpiracao).toISOString().slice(0, 10) !==
            new Date(row.expiration_date).toISOString().slice(0, 10));

      const agora = new Date().toISOString();

      const { error: updateError } = await this.client
        .from('domains')
        .update({
          status: novoStatus,
          has_alert: novoAlerta,
          expiration_date: novaExpiracao,
          last_stats_update: agora,
          updated_at: agora
        })
        .eq('id', row.id);

      if (updateError) {
        console.error(`❌ [RDAP] Erro ao salvar ${row.domain_name}: ${updateError.message}`);
        resultados.falhas++;
        resultados.erros.push({ domain: row.domain_name, error: updateError.message });
        await this.delay(DELAY_ENTRE_CONSULTAS);
        continue;
      }

      if (statusMudou || dataMudou) {
        resultados.atualizados++;
        console.log(
          `✅ [RDAP] ${row.domain_name}: status ${row.status} → ${novoStatus}` +
            (dataMudou ? ` | expiração → ${String(novaExpiracao).slice(0, 10)}` : '')
        );
      } else {
        resultados.semMudanca++;
        console.log(`   [RDAP] ${row.domain_name}: sem alteração (${novoStatus})`);
      }

      // Alerta imediato de WhatsApp — mesmo comportamento do fluxo Namecheap
      if (statusMudou) {
        try {
          const notificationService = require('../whatsapp/notifications');

          if (novoStatus === 'suspended') {
            console.log(`🚨 [RDAP] Domínio externo ficou suspenso: ${row.domain_name}`);
            await notificationService.sendSuspendedDomainAlert(row.user_id, row.domain_name);
          } else if (novoStatus === 'expired') {
            console.log(`🚨 [RDAP] Domínio externo expirou: ${row.domain_name}`);
            await notificationService.sendExpiredDomainAlert(row.user_id, row.domain_name);
          }
        } catch (notifyError) {
          // Falha no aviso não pode invalidar o dado que já foi gravado
          console.error(`⚠️ [RDAP] Falha ao notificar ${row.domain_name}: ${notifyError.message}`);
        }
      }

      await this.delay(DELAY_ENTRE_CONSULTAS);
    }

    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║  [RDAP] SINCRONIZAÇÃO DE EXTERNOS CONCLUÍDA    ║`);
    console.log(`╠════════════════════════════════════════════════╣`);
    console.log(`║ Verificados: ${String(resultados.verificados).padEnd(33)}║`);
    console.log(`║ Atualizados: ${String(resultados.atualizados).padEnd(33)}║`);
    console.log(`║ Sem mudança: ${String(resultados.semMudanca).padEnd(33)}║`);
    console.log(`║ Não registrados: ${String(resultados.naoRegistrados).padEnd(29)}║`);
    console.log(`║ Falhas: ${String(resultados.falhas).padEnd(38)}║`);
    console.log(`╚════════════════════════════════════════════════╝\n`);

    return resultados;
  }
}

module.exports = new RdapDomainsService();
