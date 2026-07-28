/**
 * COMPRA COM SWAP DE DOMÍNIO
 * ----------------------------------------------------------------------------
 * Reaproveita TODO o fluxo de compra do WordPressDomainPurchase (verificação
 * Namecheap, compra, Cloudflare, nameservers, WhoisGuard, Supabase, log) e
 * apenas SUBSTITUI a etapa final: em vez de criar uma conta nova + instalar um
 * WordPress do zero, faz o SWAP do domínio de uma conta JÁ EXISTENTE no WHM
 * (modifyacct) + correção das URLs do WordPress + SSL.
 *
 * Não modifica nenhum arquivo existente — apenas estende a classe e sobrescreve
 * o método processPostPurchase. Como purchaseDomain() (herdado) chama
 * this.processPostPurchase(), a nossa versão é usada automaticamente.
 */

const WordPressDomainPurchase = require('../wordpress');
const { swapDomainOnWHM } = require('./whm-swap');

class SwapDomainPurchase extends WordPressDomainPurchase {
  /**
   * @param {string} oldDomain domínio antigo (conta existente que será reapontada)
   */
  constructor(oldDomain) {
    super();
    this.oldDomain = oldDomain ? String(oldDomain).trim().toLowerCase() : null;
  }

  /**
   * MESMO pós-compra do WordPress (Cloudflare → Nameservers → WhoisGuard →
   * Supabase → Log), porém a ETAPA final NÃO instala WordPress: ela faz o SWAP
   * do domínio no WHM.
   */
  async processPostPurchase(domain, userId, sessionId, trafficSource = null, plataforma = null, isManual = false, purchasePrice = null) {
    try {
      console.log(`🔁 [SWAP][POST] Configurando ${domain} (substituindo ${this.oldDomain})`);

      let cloudflareSetup = null;
      let isCancelled = false;

      if (await this.isSessionCancelled(sessionId)) isCancelled = true;

      // ETAPA 1: CLOUDFLARE
      if (!isCancelled) {
        await this.updateProgress(sessionId, 'cloudflare', 'in_progress', `Configurando Cloudflare para ${domain}...`, domain);
        cloudflareSetup = await this.setupCloudflare(domain);

        if (cloudflareSetup) {
          if (await this.isSessionCancelled(sessionId)) isCancelled = true;
          if (!isCancelled) {
            // ETAPA 2: NAMESERVERS
            await this.updateProgress(sessionId, 'nameservers', 'in_progress', `Alterando nameservers de ${domain}...`, domain);
            await this.setNameservers(domain, cloudflareSetup.nameservers);
          }
        }
      }

      // ETAPA 3: WHOISGUARD
      if (!isCancelled) {
        await this.updateProgress(sessionId, 'whoisguard', 'in_progress', `Configurando WhoisGuard para ${domain}...`, domain);
        await this.delay(5000); // aguardar propagação do WhoisGuard na Namecheap
        const whoisResult = await this.configureWhoisGuard(domain);
        if (whoisResult) {
          await this.updateProgress(sessionId, 'whoisguard', 'completed', `WhoisGuard configurado: 1 ano + auto-renew`, domain);
        }
      }

      // ETAPA 4: SUPABASE (sempre — o domínio foi comprado, precisa estar no banco)
      await this.updateProgress(sessionId, 'supabase', 'in_progress', `Salvando informações de ${domain}...`, domain);
      const savedDomain = await this.saveDomainToSupabase(domain, userId, cloudflareSetup, trafficSource, plataforma, purchasePrice);
      if (savedDomain?.id) {
        await this.updateProgress(sessionId, 'supabase', 'completed', `Domínio ${domain} salvo no banco de dados!`, domain);
        // ETAPA 5: LOG
        await this.saveActivityLog(savedDomain.id, userId, trafficSource, isManual);
      } else {
        await this.updateProgress(sessionId, 'supabase', 'error', `Erro ao salvar ${domain} no banco de dados`, domain);
      }

      // ETAPA 6 (NOVA): SWAP no WHM — substitui a instalação do WordPress
      if (!isCancelled && await this.isSessionCancelled(sessionId)) isCancelled = true;

      if (!isCancelled) {
        if (!this.oldDomain) {
          await this.updateProgress(sessionId, 'swap_whm', 'error', 'Domínio antigo não informado para o swap', domain);
        } else {
          try {
            await swapDomainOnWHM({
              oldDomain: this.oldDomain,
              newDomain: domain,
              sessionId,
              updateProgress: this.updateProgress.bind(this)
            });
          } catch (swapErr) {
            console.error('❌ [SWAP] Erro:', swapErr.message);
            await this.updateProgress(sessionId, 'swap_whm', 'error', `Erro no swap: ${swapErr.message}`, domain);
          }
        }
      }

      // ETAPA 7: WHATSAPP
      await this.sendWhatsAppNotification(domain, 'success');

      console.log(`✅ [SWAP][POST] Concluído para ${domain}`);
    } catch (error) {
      console.error(`❌ [SWAP][POST] Erro:`, error.message);
      await this.sendWhatsAppNotification(domain, 'error', error.message);
    }
  }
}

module.exports = SwapDomainPurchase;
