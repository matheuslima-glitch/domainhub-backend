// Serviço de consulta de saldo Namecheap com conversão USD/BRL em tempo real

const axios = require('axios');
// `config` saiu: as credenciais agora vem de `contas`, que sabe qual conta
// usar. Era o unico uso dele aqui.
const contas = require('./contas');

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

  /**
   * `conta` é o apelido (`principal`, `paulo`). Omitido, usa a principal —
   * que é o comportamento de sempre e o único possível enquanto a segunda
   * credencial não existir.
   */
  async makeRequest(command, params = {}, conta = contas.PRINCIPAL) {
    const clientIP = await this.getServerIP();

    const { _apelido, ...credencial } = contas.parametros(conta);

    const requestParams = {
      ...credencial,
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

  /** O saldo de UMA conta, em dólar. */
  async getBalanceDaConta(conta) {
    const xmlResponse = await this.makeRequest('namecheap.users.getBalances', {}, conta);
    const xmlString = typeof xmlResponse === 'string' ? xmlResponse : JSON.stringify(xmlResponse);
    return this.extractBalanceFromXML(xmlString);
  }

  /**
   * O saldo TOTAL, somando as contas configuradas.
   *
   * ── POR QUE SOMAR, E POR QUE DETALHAR ────────────────────────────────
   *
   * Quem olha o painel quer saber uma coisa: "dá para comprar?". A soma
   * responde isso. Mas a soma sozinha ESCONDE uma conta zerada atrás de um
   * total saudável — e aí a compra falharia sem o painel ter avisado.
   *
   * Por isso vai junto `por_conta`, com o saldo de cada uma. O painel
   * mostra o total grande e o detalhe embaixo.
   *
   * ── UMA CONTA QUE FALHA NÃO DERRUBA O SALDO ──────────────────────────
   *
   * Se a conta do Paulo recusar a chamada — IP fora da whitelist é o caso
   * provável —, o saldo dela vem `null` e o total soma só o que deu para
   * apurar. `erro` diz o que houve.
   *
   * Lançar seria pior: o painel perderia o saldo da principal também, por
   * causa de um problema que não é dela. Mas o `null` NÃO é zero: zero
   * diria "esta conta está sem dinheiro", que é outra informação.
   */
  async getBalance() {
    const lista = contas.listar();

    const apuradas = await Promise.all(
      lista.map(async (c) => {
        try {
          return { conta: c.apelido, usd: await this.getBalanceDaConta(c.apelido), erro: null };
        } catch (error) {
          console.error(`❌ [SALDO] Conta "${c.apelido}" falhou: ${error.message}`);
          return { conta: c.apelido, usd: null, erro: error.message };
        }
      })
    );

    const comSaldo = apuradas.filter((a) => a.usd !== null);

    // Todas falharam: aí é falha de verdade, e quem chama precisa saber.
    // Devolver zero aqui diria que as contas estão vazias.
    if (!comSaldo.length) {
      throw new Error(
        'Nenhuma conta respondeu o saldo: ' + apuradas.map((a) => `${a.conta} (${a.erro})`).join(' · ')
      );
    }

    const balanceUSD = comSaldo.reduce((soma, a) => soma + a.usd, 0);
    const { rate, source } = await this.getExchangeRate();
    const balanceBRL = balanceUSD * rate;

    return {
      balance_usd: balanceUSD,
      balance_brl: parseFloat(balanceBRL.toFixed(2)),
      exchange_rate: parseFloat(rate.toFixed(4)),
      exchange_source: source,
      last_synced_at: new Date().toISOString(),
      // Com uma conta só, é uma entrada — e o painel pode continuar
      // mostrando só o total, sem precisar saber que isto existe.
      por_conta: apuradas,
    };
  }
}

module.exports = new NamecheapBalanceService();
