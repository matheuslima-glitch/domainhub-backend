const axios = require('axios');
const config = require('../../config/env');

class NamecheapDomainsService {
  constructor() {
    this.baseURL = 'https://api.namecheap.com/xml.response';
  }

  // ============================================
  // HELPER: OBTER IP DO CLIENTE
  // ============================================
  async getClientIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json');
      return response.data.ip;
    } catch (error) {
      console.warn('⚠️ Erro ao obter IP, usando fallback');
      return '127.0.0.1';
    }
  }

  // ============================================
  // HELPER: DELAY ENTRE REQUISIÇÕES
  // ============================================
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================
  // LISTAR DOMÍNIOS COM PAGINAÇÃO
  // ============================================
  async listDomains(page = 1, pageSize = 20) {
    console.log(`📋 Buscando domínios - Página ${page} (${pageSize} por página)...`);
    
    const clientIP = await this.getClientIP();
    
    const params = {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: 'namecheap.domains.getList',
      ClientIp: clientIP,
      PageSize: pageSize,
      Page: page,
      SortBy: 'NAME'
    };

    const response = await axios.get(this.baseURL, { 
      params,
      timeout: 30000
    });
    
    const xmlData = response.data;
    
    // Verificar se há erro
    if (xmlData.includes('Status="ERROR"')) {
      const errorMatch = xmlData.match(/<Error[^>]*>(.*?)<\/Error>/);
      const errorMessage = errorMatch ? errorMatch[1] : 'Erro desconhecido';
      
      if (errorMessage.toLowerCase().includes('too many requests') || 
          errorMessage.toLowerCase().includes('rate limit')) {
        throw new Error('RATE_LIMIT');
      }
      
      throw new Error(errorMessage);
    }
    
    // Extrair informações de paginação
    const totalDomainsMatch = xmlData.match(/TotalItems="(\d+)"/);
    const totalDomains = totalDomainsMatch ? parseInt(totalDomainsMatch[1]) : 0;
    
    const currentPageMatch = xmlData.match(/CurrentPage="(\d+)"/);
    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : page;
    
    const pageSizeMatch = xmlData.match(/PageSize="(\d+)"/);
    const actualPageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : pageSize;
    
    const totalPages = Math.ceil(totalDomains / actualPageSize);
    
    console.log(`📊 Total: ${totalDomains} domínios | Página ${currentPage}/${totalPages}`);
    
    // Extrair domínios
    const domains = [];
    const domainPattern = /<Domain\s+ID="(\d+)"\s+Name="([^"]+)".*?Created="([^"]+)".*?Expires="([^"]+)".*?IsExpired="([^"]+)".*?IsLocked="([^"]+)".*?AutoRenew="([^"]+)"/g;
    
    let match;
    while ((match = domainPattern.exec(xmlData)) !== null) {
      const [, id, name, created, expires, isExpired, isLocked, autoRenew] = match;
      
      // Determinar status baseado nos campos
      let status = 'active';
      if (isExpired === 'true') {
        status = 'expired';
      } else if (isLocked === 'true') {
        status = 'suspended';
      }
      
      domains.push({
        domain_name: name,
        expiration_date: expires,
        status: status
      });
    }

    return {
      domains: domains,
      pagination: {
        currentPage,
        totalPages,
        totalItems: totalDomains,
        hasMore: currentPage < totalPages
      }
    };
  }

  // ============================================
  // OBTER INFORMAÇÕES DETALHADAS DE UM DOMÍNIO
  // ============================================
  async getDomainInfo(domainName) {
    const clientIP = await this.getClientIP();
    
    const params = {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: 'namecheap.domains.getInfo',
      ClientIp: clientIP,
      DomainName: domainName
    };

    try {
      const response = await axios.get(this.baseURL, { params, timeout: 30000 });
      const xmlData = response.data;
      
      // ============================================
      // VERIFICAR ERROS PRIMEIRO (IGUAL AO N8N)
      // ============================================
      if (xmlData.includes('Status="ERROR"')) {
        console.log(`⚠️ Erro detectado para ${domainName}`);
        
        const statusMatch = xmlData.match(/Status="([^"]+)"/);
        const errorNumberMatch = xmlData.match(/Error Number="([^"]+)"/);
        
        // Extrair mensagem de erro
        let errorMessage = null;
        const errorMessageMatch = xmlData.match(/<Error[^>]*>([\s\S]+?)<\/Error>/);
        if (errorMessageMatch) {
          errorMessage = errorMessageMatch[1].trim();
        }
        
        if (!errorMessage) {
          const altMatch = xmlData.match(/<Error[^>]*>([^<]+)<\/Error>/);
          if (altMatch) {
            errorMessage = altMatch[1].trim();
          }
        }
        
        // Limpar tags XML da mensagem
        if (errorMessage) {
          errorMessage = errorMessage.replace(/<[^>]+>/g, '').trim();
        }
        
        const status = statusMatch ? statusMatch[1] : null;
        const errorNumber = errorNumberMatch ? errorNumberMatch[1] : null;
        
        console.log(`📋 Erro extraído: "${errorMessage}"`);
        
        // Determinar tipo de erro
        let errorType = 'unknown';
        const msg = (errorMessage || '').toLowerCase();
        
        if (msg.includes('too many requests') || msg.includes('rate limit')) {
          errorType = 'rate_limit';
          console.log(`⏱️ Rate limit detectado para ${domainName}`);
          throw new Error('RATE_LIMIT');
        } else if (msg.includes('locked') || msg.includes('suspended')) {
          errorType = 'domain_suspended';
        } else if (msg.includes('expired')) {
          errorType = 'domain_expired';
        }
        
        // Determinar status baseado no erro
        let statusType = 'active';
        
        if (msg.includes('suspended') || msg.includes('locked')) {
          statusType = 'suspended';
          console.log(`📊 Status: suspended (domínio bloqueado)`);
        } else if (msg.includes('expired')) {
          statusType = 'expired';
          console.log(`📊 Status: expired (baseado no erro)`);
        } else if (msg.includes('pending')) {
          statusType = 'pending';
        }
        
        // Extrair link de unsuspension se existir
        let unsuspensionLink = null;
        const linkMatch = errorMessage ? errorMessage.match(/https:\/\/[^\s]+/) : null;
        if (linkMatch) {
          unsuspensionLink = linkMatch[0];
        }
        
        // Traduzir alerta se necessário
        const translatedError = await this.translateAlert(errorMessage, domainName);
        
        return {
          domain_name: domainName,
          has_error: true,
          error_type: errorType,
          error_message: errorMessage,
          error_number: errorNumber,
          has_alert: translatedError,
          status: statusType,
          alert_details: {
            error_number: errorNumber,
            unsuspension_link: unsuspensionLink
          },
          last_stats_update: new Date().toISOString()
        };
      }

      // ============================================
      // SUCESSO: EXTRAIR DADOS DO DOMÍNIO
      // ============================================
      console.log(`✅ Processando domínio: ${domainName}`);
      
      // Extrair nome do domínio
      const domainNameMatch = xmlData.match(/DomainName="([^"]+)"/);
      const domain_name = domainNameMatch ? domainNameMatch[1] : domainName;
      
      // Extrair data de expiração
      const expiredDateMatch = xmlData.match(/<ExpiredDate>([^<]+)<\/ExpiredDate>/);
      const expiration_date = expiredDateMatch ? expiredDateMatch[1] : null;
      
      // Extrair data de criação
      const createdMatch = xmlData.match(/<CreatedDate>([^<]+)<\/CreatedDate>/);
      const purchase_date = createdMatch ? createdMatch[1] : null;
      
      // ============================================
      // 🚨 CORREÇÃO CRÍTICA: EXTRAIR STATUS CORRETAMENTE
      // Usando o regex CORRETO do N8N
      // ============================================
      const statusMatch = xmlData.match(/DomainGetInfoResult Status="([^"]+)"/);
      let status = 'active'; // Status padrão
      
      if (statusMatch) {
        const statusValue = statusMatch[1];
        console.log(`📊 Status REAL do domínio ${domainName}: "${statusValue}"`);
        
        // Mapear EXATAMENTE como no N8N (case-sensitive)
        switch(statusValue) {
          case 'Expired':
            status = 'expired';
            console.log(`⚠️ DOMÍNIO EXPIRADO DETECTADO: ${domainName}`);
            break;
          case 'Locked':
          case 'ServerHold':
          case 'ClientHold':
          case 'Suspended':
            status = 'suspended';
            console.log(`🔒 DOMÍNIO SUSPENSO/BLOQUEADO: ${domainName}`);
            break;
          case 'Ok':
          case 'OK':
          case 'Active':
            status = 'active';
            console.log(`✅ DOMÍNIO ATIVO: ${domainName}`);
            break;
          case 'Pending':
            status = 'pending';
            console.log(`⏳ DOMÍNIO PENDENTE: ${domainName}`);
            break;
          default:
            // Log do status desconhecido
            console.warn(`❓ Status desconhecido: "${statusValue}" para ${domainName}`);
            
            // Verificação adicional por data de expiração
            if (expiration_date) {
              const expDate = new Date(expiration_date);
              const today = new Date();
              if (expDate < today) {
                status = 'expired';
                console.log(`⚠️ DOMÍNIO EXPIRADO (por data): ${domainName}`);
              } else {
                status = 'active';
              }
            } else {
              status = 'active';
            }
        }
      } else {
        console.warn(`⚠️ Não foi possível extrair status para ${domainName}, verificando por data...`);
        
        // Verificar se está expirado pela data
        if (expiration_date) {
          const expDate = new Date(expiration_date);
          const today = new Date();
          if (expDate < today) {
            status = 'expired';
            console.log(`⚠️ DOMÍNIO EXPIRADO (por data): ${domainName}`);
          }
        }
      }

      // ============================================
      // EXTRAIR NAMESERVERS (MÚLTIPLOS PADRÕES)
      // ============================================
      const nameservers = [];
      
      // Padrão 1: <Nameserver>ns1.example.com</Nameserver>
      const nsPattern1 = /<Nameserver>([^<]+)<\/Nameserver>/g;
      let nsMatch;
      while ((nsMatch = nsPattern1.exec(xmlData)) !== null) {
        if (nsMatch[1] && nsMatch[1].trim()) {
          const ns = nsMatch[1].trim();
          if (!nameservers.includes(ns)) {
            nameservers.push(ns);
          }
        }
      }
      
      // Padrão 2: Nameserver="ns1.example.com"
      const nsPattern2 = /Nameserver="([^"]+)"/g;
      while ((nsMatch = nsPattern2.exec(xmlData)) !== null) {
        if (nsMatch[1] && nsMatch[1].trim()) {
          const ns = nsMatch[1].trim();
          if (!nameservers.includes(ns)) {
            nameservers.push(ns);
          }
        }
      }
      
      // Verificar AutoRenew
      const autoRenewMatch = xmlData.match(/<UseAutoRenew>([^<]+)<\/UseAutoRenew>/);
      const auto_renew = autoRenewMatch ? autoRenewMatch[1] === 'true' : false;
      
      // Verificar WhoisGuard
      const whoisGuardMatch = xmlData.match(/Whoisguard Enabled="([^"]+)"/);
      const whois_guard = whoisGuardMatch ? 
        (whoisGuardMatch[1] === 'true' || whoisGuardMatch[1] === 'Enabled') : false;
      
      // Log de resultado
      console.log(`📋 Domínio: ${domain_name}`);
      console.log(`   Status: ${status}`);
      console.log(`   Expira: ${expiration_date}`);
      console.log(`   Nameservers: ${nameservers.length > 0 ? nameservers.join(', ') : 'NENHUM'}`);
      
      return {
        domain_name: domain_name,
        expiration_date: expiration_date,
        purchase_date: purchase_date,
        status: status,
        registrar: 'Namecheap',
        integration_source: 'namecheap',
        last_stats_update: new Date().toISOString(),
        nameservers: nameservers.length > 0 ? nameservers : null,
        dns_configured: nameservers.length > 0,
        auto_renew: auto_renew,
        whois_guard: whois_guard,
        has_error: false
      };
      
    } catch (error) {
      // Propagar erro de rate limit
      if (error.message === 'RATE_LIMIT') {
        throw error;
      }
      
      console.error(`❌ Erro ao obter info de ${domainName}:`, error.message);
      throw error;
    }
  }

  // ============================================
  // TRADUZIR ALERTAS (OPCIONAL)
  // ============================================
  async translateAlert(errorMessage, domainName) {
    if (!config.OPENAI_API_KEY) {
      console.log('⚠️ OpenAI não configurado, retornando mensagem original');
      return errorMessage;
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'Você é um tradutor técnico de mensagens de erro de domínios. Traduza para português brasileiro de forma clara e concisa.'
            },
            {
              role: 'user',
              content: `Traduza este erro de domínio para português: "${errorMessage}". Domínio: ${domainName}`
            }
          ],
          max_tokens: 150,
          temperature: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      const translatedMessage = response.data.choices[0].message.content.trim();
      console.log(`🌐 Alerta traduzido: ${translatedMessage}`);
      return translatedMessage;
      
    } catch (error) {
      console.error('❌ Erro ao traduzir alerta:', error.message);
      return errorMessage;
    }
  }
}

module.exports = new NamecheapDomainsService();
