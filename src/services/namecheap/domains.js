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
        
        return {
          domain_name: domainName,
          has_error: true,
          error_type: errorMessage.toLowerCase().includes('rate limit') ? 'rate_limit' : 'other_error',
          error_message: errorMessage
        };
      }

      const domainInfo = apiResponse.CommandResponse.DomainGetInfoResult;
      const dnsDetails = domainInfo.DnsDetails;
      
      let nameservers = [];
      if (dnsDetails && dnsDetails.Nameserver) {
        const ns = dnsDetails.Nameserver;
        nameservers = Array.isArray(ns) ? ns : [ns];
      }

      return {
        domain_name: domainInfo.$.DomainName,
        expiration_date: domainInfo.DomainDetails.ExpiredDate,
        purchase_date: domainInfo.DomainDetails.CreatedDate,
        status: domainInfo.$.Status.toLowerCase(),
        registrar: 'Namecheap',
        integration_source: 'namecheap',
        nameservers: nameservers.length > 0 ? nameservers : null,
        dns_configured: nameservers.length > 0,
        auto_renew: domainInfo.Modificationrights?.All === 'true',
        last_stats_update: new Date().toISOString()
      };
    } catch (error) {
      return {
        domain_name: domainName,
        has_error: true,
        error_type: 'request_failed',
        error_message: error.message
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
