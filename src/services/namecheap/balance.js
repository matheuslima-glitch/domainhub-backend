// Serviço de consulta de saldo Namecheap com conversão USD/BRL em tempo real

const axios = require('axios');
const config = require('../../config/env');

class NamecheapBalanceService {
  constructor() {
    this.baseURL = 'https://api.namecheap.com/xml.response';
    this.serverIP = null;
    this.exchangeAPIs = [
      { url: 'https://api.wise.com/v1/rates?source=USD&target=BRL', parser: this.parseWise, name: 'Wise' },
      { url: 'https://api.exchangerate-api.com/v4/latest/USD', parser: this.parseExchangeRate, name: 'ExchangeRate' }
    ];
  }

  async getServerIP() {
    if (this.serverIP) return this.serverIP;

    try {
      const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
      this.serverIP = data.ip;
      return this.serverIP;
    } catch (error) {
      throw new Error('Falha ao obter IP do servidor');
    }
  }

  async makeRequest(command, params = {}) {
    const clientIP = await this.getServerIP();

    const requestParams = {
      ApiUser: config.NAMECHEAP_API_USER,
      ApiKey: config.NAMECHEAP_API_KEY,
      UserName: config.NAMECHEAP_API_USER,
      Command: command,
      ClientIp: clientIP,
      ...params
    };

    const { data } = await axios.get(this.baseURL, {
      params: requestParams,
      timeout: 30000
    });

    return data;
  }

  extractBalanceFromXML(xmlString) {
    const match = xmlString.match(/AccountBalance="([^"]+)"/);
    if (!match) throw new Error('Saldo não encontrado na resposta');
    return parseFloat(match[1]);
  }

  parseWise(data) {
    if (Array.isArray(data) && data.length > 0) {
      return data[0].rate || data[0];
    }
    if (typeof data === 'number') return data;
    if (data && data.rate) return data.rate;
    return null;
  }

  parseExchangeRate(data) {
    return data?.rates?.BRL || null;
  }

  async getExchangeRate() {
    for (const api of this.exchangeAPIs) {
      try {
        const { data } = await axios.get(api.url, {
          headers: { 'Accept': 'application/json' },
          timeout: 10000
        });

        const rate = api.parser(data);
        if (rate && rate > 0) {
          return { rate, source: api.name };
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error('Todas as APIs de cotação falharam');
  }

  async getBalance() {
    const xmlResponse = await this.makeRequest('namecheap.users.getBalances');
    const xmlString = typeof xmlResponse === 'string' ? xmlResponse : JSON.stringify(xmlResponse);
    
    const balanceUSD = this.extractBalanceFromXML(xmlString);
    const { rate, source } = await this.getExchangeRate();
    const balanceBRL = balanceUSD * rate;

    return {
      balance_usd: balanceUSD,
      balance_brl: parseFloat(balanceBRL.toFixed(2)),
      exchange_rate: parseFloat(rate.toFixed(4)),
      exchange_source: source,
      last_synced_at: new Date().toISOString()
    };
  }
}

module.exports = new NamecheapBalanceService();
