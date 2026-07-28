/**
 * SWAP DE DOMÍNIO — FASE 1: COMPRA DO DOMÍNIO NOVO
 * ----------------------------------------------------------------------------
 * Reaproveita TODO o fluxo de compra do WordPressDomainPurchase (verificação
 * Namecheap, compra, Cloudflare completo, nameservers, WhoisGuard, Supabase e
 * log de compra) e REMOVE apenas as etapas de servidor:
 *   - NÃO cria conta no WHM (createacct)
 *   - NÃO instala WordPress / plugins
 *
 * A troca em si (FASE 2) só acontece DEPOIS que o usuário escolher, no popup
 * seguinte, qual domínio do WHM será substituído.
 *   -> ver ./whm-swap.js, ./swap-runner.js e POST /api/swap-domains/execute
 *
 * Nenhum arquivo existente é modificado: a classe apenas ESTENDE a de compra
 * WordPress e sobrescreve dois métodos.
 */

const WordPressDomainPurchase = require('../wordpress');

// Step usado para "pausar" o fluxo e pedir o domínio antigo no frontend
const AWAITING_STEP = 'awaiting_old_domain';

class SwapDomainPurchase extends WordPressDomainPurchase {
  constructor() {
    super();
    this.purchasedDomain = null;
  }

  /**
   * INTERCEPTA O "completed" HERDADO
   * ----------------------------------------------------------------------------
   * purchaseDomain() (herdado) emite `completed` no final da compra. No swap a
   * compra é só METADE do processo, então convertemos esse evento em
   * `awaiting_old_domain`, que é o sinal para o frontend abrir o popup de
   * escolha do domínio que será substituído.
   */
  async updateProgress(sessionId, step, status, message, domainName = null) {
    if (domainName) this.purchasedDomain = domainName;

    if (step === 'completed' && status === 'completed') {
      const dom = domainName || this.purchasedDomain || '';
      return super.updateProgress(
        sessionId,
        AWAITING_STEP,
        'in_progress',
        `Domínio ${dom} comprado! Selecione o domínio que será substituído.`,
        dom
      );
    }

    return super.updateProgress(sessionId, step, status, message, domainName);
  }

  /**
   * PÓS-COMPRA DO SWAP
   * ----------------------------------------------------------------------------
   * Igual ao pós-compra do WordPress (Cloudflare → Nameservers → WhoisGuard →
   * Supabase → Log), MENOS a etapa de servidor (conta WHM + instalação do
   * WordPress), que no swap é substituída pela troca de domínio da conta que já
   * existe (fase 2).
   *
   * A notificação de WhatsApp também NÃO é enviada aqui: ela sai só no fim da
   * fase 2, quando o site já está respondendo no domínio novo.
   */
  async processPostPurchase(domain, userId, sessionId, trafficSource = null, plataforma = null, isManual = false, purchasePrice = null) {
    try {
      console.log(`🔁 [SWAP][FASE-1] Configurando domínio novo ${domain}`);
      if (trafficSource) console.log(`   Fonte de Tráfego: ${trafficSource}`);
      if (purchasePrice) console.log(`   💰 Preço de compra: $${purchasePrice}`);

      let cloudflareSetup = null;
      let isCancelled = false;

      if (await this.isSessionCancelled(sessionId)) isCancelled = true;

      // ═══ ETAPA 1: CLOUDFLARE (configuração completa, idêntica à compra normal)
      if (!isCancelled) {
        await this.updateProgress(sessionId, 'cloudflare', 'in_progress',
          `Configurando Cloudflare para ${domain}...`, domain);
        cloudflareSetup = await this.setupCloudflare(domain);

        if (cloudflareSetup) {
          if (await this.isSessionCancelled(sessionId)) isCancelled = true;

          if (!isCancelled) {
            // ═══ ETAPA 2: NAMESERVERS
            await this.updateProgress(sessionId, 'nameservers', 'in_progress',
              `Alterando nameservers de ${domain}...`, domain);
            await this.setNameservers(domain, cloudflareSetup.nameservers);
          }
        }
      }

      // ═══ ETAPA 3: WHOISGUARD
      if (!isCancelled) {
        await this.updateProgress(sessionId, 'whoisguard', 'in_progress',
          `Configurando WhoisGuard para ${domain}...`, domain);
        await this.delay(5000); // aguardar propagação do WhoisGuard na Namecheap
        const whoisResult = await this.configureWhoisGuard(domain);
        if (whoisResult) {
          await this.updateProgress(sessionId, 'whoisguard', 'completed',
            `WhoisGuard configurado: 1 ano + auto-renew`, domain);
        }
      }

      // ═══ ETAPA 4: SUPABASE (sempre — o domínio foi comprado, precisa estar no banco)
      await this.updateProgress(sessionId, 'supabase', 'in_progress',
        `Salvando informações de ${domain}...`, domain);

      const savedDomain = await this.saveDomainToSupabase(
        domain, userId, cloudflareSetup, trafficSource, plataforma, purchasePrice
      );

      if (savedDomain?.id) {
        await this.updateProgress(sessionId, 'supabase', 'completed',
          `Domínio ${domain} salvo no banco de dados!`, domain);

        // ═══ ETAPA 5: LOG DE COMPRA (1º dos 2 logs do domínio novo)
        await this.saveActivityLog(savedDomain.id, userId, trafficSource, isManual);
      } else {
        await this.updateProgress(sessionId, 'supabase', 'error',
          `Erro ao salvar ${domain} no banco de dados`, domain);
      }

      console.log(`✅ [SWAP][FASE-1] Domínio novo pronto: ${domain} (aguardando escolha do domínio antigo)`);

    } catch (error) {
      console.error(`❌ [SWAP][FASE-1] Erro:`, error.message);
      await this.updateProgress(sessionId, 'error', 'error',
        `Erro ao configurar ${domain}: ${error.message}`, domain);
    }
  }
}

module.exports = SwapDomainPurchase;
module.exports.AWAITING_STEP = AWAITING_STEP;
