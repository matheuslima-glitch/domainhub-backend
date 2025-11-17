const axios = require('axios');
const xml2js = require('xml2js');
const config = require('../../config/env');

class NamecheapDomainsService {
  constructor() {
    this.parser = new xml2js.Parser({ explicitArray: false });
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
    if (!alertText || !config.OPENAI_API_KEY) return alertText;
    
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
          max_tokens: 200
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
      console.error(`❌ Erro ao traduzir alerta de ${domainName}:`, error.message);
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
    const result = await this.parser.parseStringPromise(response.data);
    
    const apiResponse = result.ApiResponse;
    if (apiResponse.$.Status === 'ERROR') {
      throw new Error(apiResponse.Errors.Error);
    }

    const domainListResult = apiResponse.CommandResponse.DomainGetListResult;
    const domains = domainListResult.Domain || [];
    const domainArray = Array.isArray(domains) ? domains : [domains];

    const totalItems = parseInt(domainListResult.Paging.TotalItems);
    const currentPage = parseInt(domainListResult.Paging.CurrentPage);
    const totalPages = Math.ceil(totalItems / pageSize);

    return {
      domains: domainArray.map(d => ({
        domain_name: d.$.Name,
        expiration_date: d.$.Expires,
        status: d.$.IsExpired === 'true' ? 'expired' : (d.$.IsLocked === 'true' ? 'suspended' : 'active')
      })),
      pagination: {
        currentPage,
        totalPages,
        totalItems,
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
      const result = await this.parser.parseStringPromise(response.data);
      
      const apiResponse = result.ApiResponse;
      if (apiResponse.$.Status === 'ERROR') {
        const error = apiResponse.Errors.Error;
        const errorMessage = typeof error === 'string' ? error : error._;
        
        const translatedError = await this.translateAlert(errorMessage, domainName);
        
        return {
          domain_name: domainName,
          has_error: true,
          error_type: errorMessage.toLowerCase().includes('rate limit') ? 'rate_limit' : 'other_error',
          error_message: errorMessage,
          has_alert: translatedError,
          status: 'suspended',
          last_stats_update: new Date().toISOString()
        };
      }

      const domainInfo = apiResponse.CommandResponse.DomainGetInfoResult;
      const dnsDetails = domainInfo.DnsDetails;
      
      let nameservers = [];
      if (dnsDetails && dnsDetails.Nameserver) {
        const ns = dnsDetails.Nameserver;
        nameservers = Array.isArray(ns) ? ns : [ns];
      }

      const status = domainInfo.$.Status.toLowerCase();
      let hasAlert = null;

      if (status === 'suspended' || status === 'locked') {
        const alertMessage = domainInfo.DomainDetails?.StatusDescription || 
                            domainInfo.$.StatusDescription || 
                            'Domain is suspended or locked';
        hasAlert = await this.translateAlert(alertMessage, domainName);
      }

      return {
        domain_name: domainInfo.$.DomainName,
        expiration_date: domainInfo.DomainDetails.ExpiredDate,
        purchase_date: domainInfo.DomainDetails.CreatedDate,
        status: status,
        registrar: 'Namecheap',
        integration_source: 'namecheap',
        nameservers: nameservers.length > 0 ? nameservers : null,
        dns_configured: nameservers.length > 0,
        auto_renew: domainInfo.Modificationrights?.All === 'true',
        last_stats_update: new Date().toISOString(),
        has_alert: hasAlert
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