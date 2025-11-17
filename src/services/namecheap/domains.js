const axios = require('axios');
const config = require('../../config/env');

class NamecheapDomainsService {
  constructor() {
    this.baseURL = 'https://api.namecheap.com/xml.response';
    this.rateLimit = {
      perMinute: 300,
      perHour: 5000,
      perDay: 30000
    };
  }

  async getClientIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json');
      return response.data.ip;
    } catch (error) {
      throw new Error('Falha ao obter IP do cliente');
    }
  }

  async translateAlert(alertText, domainName) {
    if (!alertText) {
      console.log(`⚠️ Sem texto para traduzir: ${domainName}`);
      return alertText;
    }
    
    if (!config.OPENAI_API_KEY) {
      console.log(`⚠️ OPENAI_API_KEY não configurada`);
      return alertText;
    }
    
    console.log(`🔄 Iniciando tradução para ${domainName}: "${alertText.substring(0, 50)}..."`);
    
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Você é um tradutor profissional especializado em mensagens técnicas de domínios.'
            },
            {
              role: 'user',
              content: `Traduza esse texto para o PORTUGUÊS NATIVO: "${alertText}"\n\n- Quero apenas o TEXTO TRADUZIDO CORRETAMENTE, sem comentários\n- Remova o número do erro se vier na mensagem\n- Corrija erros de gramática e acentuação\n- Substitua SEMPRE a frase "entre em contato em/com" por "por favor clique no botão abaixo."\n- NUNCA remova informações de contato como e-mails e urls do texto`
            }
          ],
          temperature: 0.3,
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const translated = response.data.choices[0].message.content.trim();
      console.log(`🌐 Alerta traduzido para ${domainName}: ${translated}`);
      return translated;
    } catch (error) {
      console.error(`❌ ERRO DETALHADO ao traduzir ${domainName}:`);
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Mensagem: ${error.response?.data?.error?.message || error.message}`);
      console.error(`   Dados completos:`, JSON.stringify(error.response?.data, null, 2));
      return alertText;
    }
  }

  async listDomains(page = 1, pageSize = 100) {
    const clientIP = await this.getClientIP();
    
    const params = {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: 'namecheap.domains.getList',
      ClientIp: clientIP,
      PageSize: pageSize,
      Page: page
    };

    const response = await axios.get(this.baseURL, { params });
    const xmlData = response.data;

    if (xmlData.includes('Status="ERROR"')) {
      const errorMatch = xmlData.match(/<Error[^>]*>([^<]+)<\/Error>/);
      const errorMessage = errorMatch ? errorMatch[1] : 'Erro desconhecido na API Namecheap';
      throw new Error(errorMessage);
    }

    const totalItemsMatch = xmlData.match(/<TotalItems>(\d+)<\/TotalItems>/);
    const pageSizeMatch = xmlData.match(/<PageSize>(\d+)<\/PageSize>/);
    const currentPageMatch = xmlData.match(/<CurrentPage>(\d+)<\/CurrentPage>/);

    const totalDomains = totalItemsMatch ? parseInt(totalItemsMatch[1]) : 0;
    const pageSizeValue = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 100;
    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]) : 1;
    const totalPages = Math.ceil(totalDomains / pageSizeValue);

    const domainRegex = /<Domain[^>]*Name="([^"]+)"[^>]*Expires="([^"]+)"[^>]*IsExpired="([^"]+)"[^>]*IsLocked="([^"]+)"/g;
    const domains = [];
    let match;

    while ((match = domainRegex.exec(xmlData)) !== null) {
      const [_, name, expires, isExpired, isLocked] = match;
      
      // LÓGICA CORRETA: Status baseado em IsExpired e IsLocked (igual ao N8N)
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
      const response = await axios.get(this.baseURL, { params });
      const xmlData = response.data;
      
      // ============================================
      // PARSE 2: VERIFICAR ERROS (IGUAL AO N8N)
      // ============================================
      if (xmlData.includes('Status="ERROR"')) {
        const statusMatch = xmlData.match(/Status="([^"]+)"/);
        const errorNumberMatch = xmlData.match(/Error Number="([^"]+)"/);
        
        // MELHORADO: Captura mensagens multi-linha e com caracteres especiais
        let errorMessage = null;
        const errorMessageMatch = xmlData.match(/<Error[^>]*>([\s\S]+?)<\/Error>/);
        if (errorMessageMatch) {
          errorMessage = errorMessageMatch[1].trim();
        }
        
        // Se não encontrou com o método acima, tenta alternativa
        if (!errorMessage) {
          const altMatch = xmlData.match(/<Error[^>]*>([^<]+)<\/Error>/);
          if (altMatch) {
            errorMessage = altMatch[1].trim();
          }
        }
        
        // Se ainda não encontrou, busca qualquer texto entre tags Error
        if (!errorMessage) {
          const looseMatch = xmlData.match(/<Error[\s\S]*?>[\s\S]*?([A-Za-z].+?)[\s\S]*?<\/Error>/);
          if (looseMatch) {
            errorMessage = looseMatch[1].trim();
          }
        }
        
        // Limpar possíveis tags XML residuais da mensagem
        if (errorMessage) {
          errorMessage = errorMessage.replace(/<[^>]+>/g, '').trim();
        }
        
        const status = statusMatch ? statusMatch[1] : null;
        const errorNumber = errorNumberMatch ? errorNumberMatch[1] : null;
        
        // ============================================
        // EXTRAIR DOMAIN_NAME - MÚLTIPLAS TENTATIVAS (IGUAL AO N8N)
        // ============================================
        let extractedDomainName = domainName; // Usar o que foi passado como fallback
        
        // Tentativa 1: Extrair da mensagem de erro (entre parênteses)
        // Exemplo: "Sorry, you will not be able to access the domain (mymemorylift.com)"
        if (errorMessage) {
          const domainMatch = errorMessage.match(/\(([^)]+\.[a-z]+)\)/i);
          if (domainMatch) {
            extractedDomainName = domainMatch[1];
          }
        }
        
        // Tentativa 2: Extrair do XML - DomainName attribute
        if (!extractedDomainName && xmlData) {
          const xmlDomainMatch = xmlData.match(/DomainName[>=\s"']+([a-z0-9.-]+\.[a-z]+)/i);
          if (xmlDomainMatch) {
            extractedDomainName = xmlDomainMatch[1];
          }
        }
        
        // Tentativa 3: Buscar pattern de domínio em todo o XML
        if (!extractedDomainName) {
          const generalDomainMatch = xmlData.match(/([a-z0-9-]+\.(online|com|net|org|io|co|br))/i);
          if (generalDomainMatch) {
            extractedDomainName = generalDomainMatch[1];
          }
        }
        
        console.log(`📋 Domínio extraído do erro: ${extractedDomainName}`);
        
        // Determinar tipo de erro
        let errorType = 'unknown';
        if (errorMessage) {
          const msg = errorMessage.toLowerCase();
          
          if (msg.includes('too many requests') || msg.includes('rate limit')) {
            errorType = 'rate_limit';
          } else if (msg.includes('locked') || msg.includes('suspended')) {
            errorType = 'domain_suspended';
          } else {
            errorType = 'other_error';
          }
        }
        
        // ============================================
        // PARSE 3: EXTRAIR ALERTAS (IGUAL AO N8N)
        // ============================================
        let statusType = 'active';
        const errorMsg = (errorMessage || '').toLowerCase();
        
        if (errorMsg.includes('suspended')) {
          statusType = 'suspended';
        } else if (errorMsg.includes('locked')) {
          statusType = 'suspended';
        } else if (errorMsg.includes('expired')) {
          statusType = 'expired';
        } else if (errorMsg.includes('pending')) {
          statusType = 'pending';
        }
        
        // Extrair link de unsuspension se existir
        let unsuspensionLink = null;
        const linkMatch = errorMessage ? errorMessage.match(/https:\/\/[^\s]+/) : null;
        if (linkMatch) {
          unsuspensionLink = linkMatch[0];
        }
        
        // Traduzir mensagem de alerta
        const translatedError = await this.translateAlert(errorMessage, extractedDomainName);
        
        return {
          domain_name: extractedDomainName,
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
      const domainNameMatch = xmlData.match(/DomainName="([^"]+)"/);
      const domain_name = domainNameMatch ? domainNameMatch[1] : domainName;
      
      const expiredDateMatch = xmlData.match(/<ExpiredDate>([^<]+)<\/ExpiredDate>/);
      const expiration_date = expiredDateMatch ? expiredDateMatch[1] : null;
      
      const createdMatch = xmlData.match(/<CreatedDate>([^<]+)<\/CreatedDate>/);
      const purchase_date = createdMatch ? createdMatch[1] : null;
      
      // IMPORTANTE: O status vem de IsExpired e IsLocked, NÃO do Status="Ok"
      // Extrair IsExpired e IsLocked do XML
      const isExpiredMatch = xmlData.match(/IsExpired="([^"]+)"/);
      const isLockedMatch = xmlData.match(/IsLocked="([^"]+)"/);
      
      const isExpired = isExpiredMatch ? isExpiredMatch[1] : 'false';
      const isLocked = isLockedMatch ? isLockedMatch[1] : 'false';
      
      // LÓGICA CORRETA: Igual ao listDomains e ao N8N
      let status = 'active';
      if (isExpired === 'true') {
        status = 'expired';
      } else if (isLocked === 'true') {
        status = 'suspended';
      }

      const nameservers = [];
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

      const autoRenewMatch = xmlData.match(/<UseAutoRenew>([^<]+)<\/UseAutoRenew>/);
      const auto_renew = autoRenewMatch ? autoRenewMatch[1] === 'true' : false;

      let has_alert = null;
      if (status === 'suspended') {
        const alertMessage = 'Domain is suspended or locked';
        has_alert = await this.translateAlert(alertMessage, domainName);
      }

      return {
        domain_name: domain_name,
        expiration_date: expiration_date,
        purchase_date: purchase_date,
        status: status,
        registrar: 'Namecheap',
        integration_source: 'namecheap',
        nameservers: nameservers.length > 0 ? nameservers : null,
        dns_configured: nameservers.length > 0,
        auto_renew: auto_renew,
        last_stats_update: new Date().toISOString(),
        has_alert: has_alert
      };
    } catch (error) {
      return {
        domain_name: domainName,
        has_error: true,
        error_type: 'request_failed',
        error_message: error.message,
        status: 'unknown',
        last_stats_update: new Date().toISOString()
      };
    }
  }

  async syncAllDomains() {
    const allDomains = [];
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.listDomains(currentPage);
      allDomains.push(...result.domains);
      hasMore = result.pagination.hasMore;
      currentPage++;
      
      if (hasMore) {
        await this.delay(200);
      }
    }

    return allDomains;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new NamecheapDomainsService();