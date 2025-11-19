const axios = require('axios');
const config = require('../../config/env');

class NamecheapNameserversService {
  constructor() {
    this.baseURL = 'https://api.namecheap.com/xml.response';
  }

  async getClientIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: 5000
      });
      return response.data.ip;
    } catch (error) {
      // Fallback: Usar variável de ambiente NAMECHEAP_CLIENT_IP
      if (config.NAMECHEAP_CLIENT_IP) {
        console.warn('⚠️ Falha ao obter IP via API, usando NAMECHEAP_CLIENT_IP');
        return config.NAMECHEAP_CLIENT_IP;
      }
      
      throw new Error('Falha ao obter IP do cliente e NAMECHEAP_CLIENT_IP não configurada');
    }
  }

  /**
   * Atualiza os nameservers de um domínio na Namecheap
   * @param {string} domainName - Nome do domínio (ex: exemplo.com)
   * @param {string[]} nameservers - Array de nameservers (mínimo 2, máximo 12)
   * @returns {Promise<Object>} - Resultado da operação
   */
  async setNameservers(domainName, nameservers) {
    try {
      console.log(`🔄 Iniciando atualização de nameservers para ${domainName}`);
      console.log(`   Nameservers fornecidos: ${nameservers.length}`);
      
      // ═══════════════════════════════════════════════════════════════
      // VALIDAÇÕES
      // ═══════════════════════════════════════════════════════════════
      
      // Validar número de nameservers
      if (!nameservers || nameservers.length < 2) {
        throw new Error('É necessário fornecer no mínimo 2 nameservers');
      }
      
      if (nameservers.length > 12) {
        throw new Error('Máximo de 12 nameservers permitidos');
      }
      
      // Validar formato dos nameservers
      const nsRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
      for (const ns of nameservers) {
        if (!ns || ns.trim() === '') {
          throw new Error('Nameserver vazio detectado');
        }
        if (!nsRegex.test(ns.trim())) {
          throw new Error(`Nameserver inválido: ${ns}`);
        }
      }
      
      // Limpar nameservers
      const cleanNameservers = nameservers.map(ns => ns.trim().toLowerCase());
      
      console.log(`✅ Validações concluídas`);
      console.log(`   Nameservers limpos:`, cleanNameservers);
      
      // ═══════════════════════════════════════════════════════════════
      // SEPARAR DOMÍNIO EM SLD E TLD
      // ═══════════════════════════════════════════════════════════════
      
      // Exemplo: exemplo.com.br -> SLD: exemplo, TLD: com.br
      // Exemplo: exemplo.com -> SLD: exemplo, TLD: com
      
      const parts = domainName.split('.');
      let SLD, TLD;
      
      // TLDs compostos conhecidos (adicione mais se necessário)
      const compositeTLDs = ['com.br', 'net.br', 'org.br', 'co.uk', 'com.au'];
      
      // Verificar se é um TLD composto
      const possibleTLD = parts.slice(-2).join('.');
      if (compositeTLDs.includes(possibleTLD)) {
        TLD = possibleTLD;
        SLD = parts.slice(0, -2).join('.');
      } else {
        TLD = parts[parts.length - 1];
        SLD = parts.slice(0, -1).join('.');
      }
      
      console.log(`📋 Domínio separado:`);
      console.log(`   SLD: ${SLD}`);
      console.log(`   TLD: ${TLD}`);
      
      // ═══════════════════════════════════════════════════════════════
      // OBTER IP DO CLIENTE
      // ═══════════════════════════════════════════════════════════════
      
      const clientIP = await this.getClientIP();
      console.log(`🌐 IP do cliente: ${clientIP}`);
      
      // ═══════════════════════════════════════════════════════════════
      // CONSTRUIR PARÂMETROS DA API
      // ═══════════════════════════════════════════════════════════════
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.setCustom',
        ClientIp: clientIP,
        SLD: SLD,
        TLD: TLD
      };
      
      // Adicionar nameservers aos parâmetros (Nameserver1, Nameserver2, ...)
      cleanNameservers.forEach((ns, index) => {
        params[`Nameservers`] = params[`Nameservers`] 
          ? `${params[`Nameservers`]},${ns}` 
          : ns;
      });
      
      console.log(`📤 Parâmetros da API preparados`);
      console.log(`   Command: ${params.Command}`);
      console.log(`   Domínio: ${SLD}.${TLD}`);
      console.log(`   Nameservers: ${params.Nameservers}`);
      
      // ═══════════════════════════════════════════════════════════════
      // FAZER REQUISIÇÃO À API DA NAMECHEAP
      // ═══════════════════════════════════════════════════════════════
      
      console.log(`🚀 Enviando requisição para Namecheap...`);
      
      const response = await axios.get(this.baseURL, { 
        params,
        timeout: 30000 // 30 segundos de timeout
      });
      
      const xmlData = response.data;
      
      console.log(`📥 Resposta recebida da Namecheap`);
      
      // ═══════════════════════════════════════════════════════════════
      // PARSE DA RESPOSTA XML
      // ═══════════════════════════════════════════════════════════════
      
      // Verificar se houve erro
      if (xmlData.includes('Status="ERROR"')) {
        console.error(`❌ Erro retornado pela Namecheap`);
        
        // Extrair mensagem de erro
        let errorMessage = 'Erro desconhecido ao atualizar nameservers';
        const errorMatch = xmlData.match(/<Error[^>]*>([\s\S]+?)<\/Error>/);
        if (errorMatch) {
          errorMessage = errorMatch[1].trim().replace(/<[^>]+>/g, '');
        }
        
        console.error(`   Mensagem: ${errorMessage}`);
        
        throw new Error(errorMessage);
      }
      
      // Verificar se foi bem-sucedido
      if (xmlData.includes('Status="OK"')) {
        console.log(`✅ Nameservers atualizados com sucesso na Namecheap!`);
        
        // Extrair informações da resposta
        const isSuccessMatch = xmlData.match(/<DomainDNSSetCustomResult[^>]*Domain="([^"]+)"[^>]*Updated="([^"]+)"/);
        
        if (isSuccessMatch) {
          const domain = isSuccessMatch[1];
          const updated = isSuccessMatch[2];
          
          console.log(`   Domínio: ${domain}`);
          console.log(`   Atualizado: ${updated}`);
          
          return {
            success: true,
            domain: domain,
            updated: updated === 'true',
            nameservers: cleanNameservers,
            message: 'Nameservers atualizados com sucesso na Namecheap'
          };
        }
        
        return {
          success: true,
          domain: domainName,
          nameservers: cleanNameservers,
          message: 'Nameservers atualizados com sucesso na Namecheap'
        };
      }
      
      // Se chegou aqui, resposta inesperada
      console.warn(`⚠️ Resposta inesperada da Namecheap`);
      console.warn(`   XML completo:`, xmlData.substring(0, 500));
      
      throw new Error('Resposta inesperada da API Namecheap');
      
    } catch (error) {
      console.error(`❌ Erro ao atualizar nameservers para ${domainName}:`, error.message);
      
      // Se for erro de axios, incluir mais detalhes
      if (error.response) {
        console.error(`   Status HTTP: ${error.response.status}`);
        console.error(`   Dados:`, error.response.data?.substring(0, 500));
      }
      
      throw error;
    }
  }

  /**
   * Obtém os nameservers atuais de um domínio
   * @param {string} domainName - Nome do domínio
   * @returns {Promise<Object>} - Informações dos nameservers
   */
  async getNameservers(domainName) {
    try {
      console.log(`🔍 Consultando nameservers atuais de ${domainName}`);
      
      const parts = domainName.split('.');
      let SLD, TLD;
      
      const compositeTLDs = ['com.br', 'net.br', 'org.br', 'co.uk', 'com.au'];
      const possibleTLD = parts.slice(-2).join('.');
      
      if (compositeTLDs.includes(possibleTLD)) {
        TLD = possibleTLD;
        SLD = parts.slice(0, -2).join('.');
      } else {
        TLD = parts[parts.length - 1];
        SLD = parts.slice(0, -1).join('.');
      }
      
      const clientIP = await this.getClientIP();
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.getList',
        ClientIp: clientIP,
        SLD: SLD,
        TLD: TLD
      };
      
      const response = await axios.get(this.baseURL, { params });
      const xmlData = response.data;
      
      if (xmlData.includes('Status="ERROR"')) {
        let errorMessage = 'Erro ao consultar nameservers';
        const errorMatch = xmlData.match(/<Error[^>]*>([\s\S]+?)<\/Error>/);
        if (errorMatch) {
          errorMessage = errorMatch[1].trim().replace(/<[^>]+>/g, '');
        }
        throw new Error(errorMessage);
      }
      
      // Extrair nameservers da resposta
      const nameservers = [];
      const nsPattern = /<Nameserver>([^<]+)<\/Nameserver>/g;
      let match;
      
      while ((match = nsPattern.exec(xmlData)) !== null) {
        if (match[1] && match[1].trim()) {
          nameservers.push(match[1].trim());
        }
      }
      
      console.log(`✅ Nameservers atuais: ${nameservers.join(', ')}`);
      
      return {
        success: true,
        domain: domainName,
        nameservers: nameservers
      };
      
    } catch (error) {
      console.error(`❌ Erro ao consultar nameservers de ${domainName}:`, error.message);
      throw error;
    }
  }

  /**
   * Configura DNS predefinido da Namecheap (BasicDNS ou WebHostingDNS)
   * @param {string} domainName - Nome do domínio
   * @param {string} dnsType - Tipo de DNS: 'BasicDNS' ou 'WebHostingDNS'
   * @returns {Promise<Object>} - Resultado da operação
   */
  async setDefaultDNS(domainName, dnsType) {
    try {
      console.log(`🔄 Configurando ${dnsType} para ${domainName}`);
      
      // ═══════════════════════════════════════════════════════════════
      // VALIDAÇÕES
      // ═══════════════════════════════════════════════════════════════
      
      if (!dnsType || !['BasicDNS', 'WebHostingDNS'].includes(dnsType)) {
        throw new Error('Tipo de DNS inválido. Use "BasicDNS" ou "WebHostingDNS"');
      }
      
      // ═══════════════════════════════════════════════════════════════
      // SEPARAR DOMÍNIO EM SLD E TLD
      // ═══════════════════════════════════════════════════════════════
      
      const parts = domainName.split('.');
      let SLD, TLD;
      
      const compositeTLDs = ['com.br', 'net.br', 'org.br', 'co.uk', 'com.au'];
      const possibleTLD = parts.slice(-2).join('.');
      
      if (compositeTLDs.includes(possibleTLD)) {
        TLD = possibleTLD;
        SLD = parts.slice(0, -2).join('.');
      } else {
        TLD = parts[parts.length - 1];
        SLD = parts.slice(0, -1).join('.');
      }
      
      console.log(`📋 Domínio separado:`);
      console.log(`   SLD: ${SLD}`);
      console.log(`   TLD: ${TLD}`);
      
      // ═══════════════════════════════════════════════════════════════
      // OBTER IP DO CLIENTE
      // ═══════════════════════════════════════════════════════════════
      
      const clientIP = await this.getClientIP();
      console.log(`🌐 IP do cliente: ${clientIP}`);
      
      // ═══════════════════════════════════════════════════════════════
      // CONSTRUIR PARÂMETROS DA API
      // ═══════════════════════════════════════════════════════════════
      
      const params = {
        ApiUser: config.NAMECHEAP_API_USER,
        ApiKey: config.NAMECHEAP_API_KEY,
        UserName: config.NAMECHEAP_API_USER,
        Command: 'namecheap.domains.dns.setDefault',
        ClientIp: clientIP,
        SLD: SLD,
        TLD: TLD
      };
      
      console.log(`📤 Parâmetros da API preparados`);
      console.log(`   Command: ${params.Command}`);
      console.log(`   Domínio: ${SLD}.${TLD}`);
      console.log(`   Tipo DNS: ${dnsType}`);
      
      // ═══════════════════════════════════════════════════════════════
      // FAZER REQUISIÇÃO À API DA NAMECHEAP
      // ═══════════════════════════════════════════════════════════════
      
      console.log(`🚀 Enviando requisição para Namecheap...`);
      
      const response = await axios.get(this.baseURL, { 
        params,
        timeout: 30000
      });
      
      const xmlData = response.data;
      
      console.log(`📥 Resposta recebida da Namecheap`);
      
      // ═══════════════════════════════════════════════════════════════
      // PARSE DA RESPOSTA XML
      // ═══════════════════════════════════════════════════════════════
      
      if (xmlData.includes('Status="ERROR"')) {
        console.error(`❌ Erro retornado pela Namecheap`);
        
        let errorMessage = 'Erro desconhecido ao configurar DNS';
        const errorMatch = xmlData.match(/<Error[^>]*>([\s\S]+?)<\/Error>/);
        if (errorMatch) {
          errorMessage = errorMatch[1].trim().replace(/<[^>]+>/g, '');
        }
        
        console.error(`   Mensagem: ${errorMessage}`);
        throw new Error(errorMessage);
      }
      
      if (xmlData.includes('Status="OK"')) {
        console.log(`✅ ${dnsType} configurado com sucesso na Namecheap!`);
        
        // Extrair informações da resposta
        const isSuccessMatch = xmlData.match(/<DomainDNSSetDefaultResult[^>]*Domain="([^"]+)"[^>]*Updated="([^"]+)"/);
        
        if (isSuccessMatch) {
          const domain = isSuccessMatch[1];
          const updated = isSuccessMatch[2];
          
          console.log(`   Domínio: ${domain}`);
          console.log(`   Atualizado: ${updated}`);
          
          return {
            success: true,
            domain: domain,
            updated: updated === 'true',
            dnsType: dnsType,
            message: `${dnsType} configurado com sucesso na Namecheap`
          };
        }
        
        return {
          success: true,
          domain: domainName,
          dnsType: dnsType,
          message: `${dnsType} configurado com sucesso na Namecheap`
        };
      }
      
      console.warn(`⚠️ Resposta inesperada da Namecheap`);
      console.warn(`   XML completo:`, xmlData.substring(0, 500));
      
      throw new Error('Resposta inesperada da API Namecheap');
      
    } catch (error) {
      console.error(`❌ Erro ao configurar ${dnsType} para ${domainName}:`, error.message);
      
      if (error.response) {
        console.error(`   Status HTTP: ${error.response.status}`);
        console.error(`   Dados:`, error.response.data?.substring(0, 500));
      }
      
      throw error;
    }
  }
}

module.exports = new NamecheapNameserversService();