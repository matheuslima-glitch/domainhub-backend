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

  /**
   * Verifica se uma data está expirada comparando com a data atual
   * @param {string} dateString - Data no formato MM/DD/YYYY
   * @returns {boolean} - true se a data está expirada
   */
  isDateExpired(dateString) {
    try {
      if (!dateString) {
        console.warn(`⚠️ Data vazia recebida para verificação`);
        return false;
      }
      
      // Limpar espaços
      const cleanDate = dateString.trim();
      
      // Parse da data de expiração - IMPORTANTE: MM/DD/YYYY
      // Forçar interpretação americana (MM/DD/YYYY)
      const expirationDate = new Date(cleanDate);
      
      // Validar se a data é válida
      if (isNaN(expirationDate.getTime())) {
        console.warn(`⚠️ Data inválida para parse: ${cleanDate}`);
        return false;
      }
      
      // Data atual sem horas (apenas dia)
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      // Data de expiração sem horas (apenas dia)
      const expiryDay = new Date(expirationDate.getFullYear(), expirationDate.getMonth(), expirationDate.getDate());
      
      // Se a data de expiração é MENOR OU IGUAL que hoje, está expirada
      const isExpired = expiryDay <= today;
      
      console.log(`📅 Verificação de data: ${cleanDate}`);
      console.log(`   Data de expiração (sem hora): ${expiryDay.toISOString().split('T')[0]}`);
      console.log(`   Data atual (sem hora): ${today.toISOString().split('T')[0]}`);
      console.log(`   Está expirada: ${isExpired ? 'SIM ⚠️' : 'NÃO ✅'}`);
      
      return isExpired;
    } catch (error) {
      console.error(`❌ Erro ao verificar data de expiração: ${error.message}`);
      return false;
    }
  }

  /**
   * Determina o status do domínio usando múltiplas verificações robustas
   * @param {string} xmlData - XML completo da resposta
   * @param {string} domainName - Nome do domínio para logs
   * @returns {string} - Status: 'expired', 'suspended', ou 'active'
   */
  determineExpiredStatus(xmlData, domainName) {
    console.log(`🔍 ═══════════════════════════════════════════════════════════`);
    console.log(`🔍 ANÁLISE DE STATUS PARA: ${domainName}`);
    console.log(`🔍 ═══════════════════════════════════════════════════════════`);
    
    // Variável para rastrear qual método detectou expiração
    let detectionMethod = null;
    
    // ═══════════════════════════════════════════════════════════════
    // EXTRAÇÃO DE TODOS OS INDICADORES POSSÍVEIS
    // ═══════════════════════════════════════════════════════════════
    
    // Extrair IsExpired (pode vir em qualquer ordem no XML)
    const isExpiredMatch = xmlData.match(/IsExpired="([^"]+)"/);
    const isExpiredValue = isExpiredMatch ? isExpiredMatch[1].trim().toLowerCase() : null;
    
    // Extrair IsLocked (pode vir em qualquer ordem no XML)
    const isLockedMatch = xmlData.match(/IsLocked="([^"]+)"/);
    const isLockedValue = isLockedMatch ? isLockedMatch[1].trim().toLowerCase() : null;
    
    // Extrair IsActive
    const isActiveMatch = xmlData.match(/<IsActive>([^<]+)<\/IsActive>/);
    const isActiveValue = isActiveMatch ? isActiveMatch[1].trim().toLowerCase() : null;
    
    // Extrair ExpiredDate
    const expiredDateMatch = xmlData.match(/<ExpiredDate>([^<]+)<\/ExpiredDate>/);
    const expiredDateValue = expiredDateMatch ? expiredDateMatch[1].trim() : null;
    
    console.log(`📊 INDICADORES EXTRAÍDOS:`);
    console.log(`   IsExpired: ${isExpiredValue || 'NÃO ENCONTRADO'}`);
    console.log(`   IsLocked: ${isLockedValue || 'NÃO ENCONTRADO'}`);
    console.log(`   IsActive: ${isActiveValue || 'NÃO ENCONTRADO'}`);
    console.log(`   ExpiredDate: ${expiredDateValue || 'NÃO ENCONTRADO'}`);
    
    // ═══════════════════════════════════════════════════════════════
    // VERIFICAÇÃO 1: IsExpired="true" (mais confiável)
    // ═══════════════════════════════════════════════════════════════
    if (isExpiredValue === 'true') {
      console.log(`✅ VERIFICAÇÃO 1: IsExpired="true" detectado`);
      console.log(`📊 STATUS FINAL: expired`);
      console.log(`🔍 ═══════════════════════════════════════════════════════════\n`);
      return 'expired';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // VERIFICAÇÃO 2: IsLocked="true" (domínio suspenso)
    // ═══════════════════════════════════════════════════════════════
    if (isLockedValue === 'true') {
      console.log(`✅ VERIFICAÇÃO 2: IsLocked="true" detectado`);
      console.log(`📊 STATUS FINAL: suspended`);
      console.log(`🔍 ═══════════════════════════════════════════════════════════\n`);
      return 'suspended';
    }
    
    // ═══════════════════════════════════════════════════════════════
    // VERIFICAÇÃO 3: Data de expiração vencida (SEMPRE verificar)
    // ═══════════════════════════════════════════════════════════════
    if (expiredDateValue) {
      console.log(`🔍 VERIFICAÇÃO 3: Verificando data de expiração...`);
      const dateIsExpired = this.isDateExpired(expiredDateValue);
      
      if (dateIsExpired) {
        console.log(`✅ VERIFICAÇÃO 3: Data de expiração vencida!`);
        console.log(`📊 STATUS FINAL: expired (via data vencida)`);
        console.log(`🔍 ═══════════════════════════════════════════════════════════\n`);
        return 'expired';
      } else {
        console.log(`✅ VERIFICAÇÃO 3: Data ainda válida`);
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // VERIFICAÇÃO 4: IsActive="false" + data vencida
    // ═══════════════════════════════════════════════════════════════
    if (isActiveValue === 'false' && expiredDateValue) {
      console.log(`🔍 VERIFICAÇÃO 4: IsActive="false" detectado`);
      console.log(`   Verificando se combina com data vencida...`);
      
      const dateIsExpired = this.isDateExpired(expiredDateValue);
      
      if (dateIsExpired) {
        console.log(`✅ VERIFICAÇÃO 4: IsActive="false" + data vencida confirmada`);
        console.log(`📊 STATUS FINAL: expired`);
        console.log(`🔍 ═══════════════════════════════════════════════════════════\n`);
        return 'expired';
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // NENHUMA CONDIÇÃO DE EXPIRAÇÃO DETECTADA
    // ═══════════════════════════════════════════════════════════════
    console.log(`✅ Nenhum indicador de expiração ou suspensão encontrado`);
    console.log(`📊 STATUS FINAL: active`);
    console.log(`🔍 ═══════════════════════════════════════════════════════════\n`);
    return 'active';
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
      
      // Se não tiver variável de ambiente, lança erro
      throw new Error('Falha ao obter IP do cliente e NAMECHEAP_CLIENT_IP não configurada');
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
              content: `Traduza esse texto para o PORTUGUÊS NATIVO: "${alertText}"\n\n- Quero apenas o TEXTO TRADUZIDO CORRETAMENTE, sem comentários\n- Remova o número do erro se vier na mensagem\n- Corrija erros de gramática e acentuação\n- Substitua SEMPRE a frase "entre em contato em/com" por "por favor clique no botão abaixo."\n- NUNCA remova informações de contato como e-mails e urls do texto, além disso garanta que e-mail e urls estejam no formato correto e sem pontuação no final`
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

    // PARSE 1: EXTRAIR DOMÍNIOS DA LISTA
    const domainRegex = /<Domain[^>]*Name="([^"]+)"[^>]*Expires="([^"]+)"[^>]*IsExpired="([^"]+)"[^>]*IsLocked="([^"]+)"/g;
    const domains = [];
    let match;

    while ((match = domainRegex.exec(xmlData)) !== null) {
      const [_, name, expires, isExpired, isLocked] = match;
      
      // Limpar valores
      const cleanName = name.trim();
      const cleanExpires = expires.trim();
      const cleanIsExpired = isExpired.trim().toLowerCase();
      const cleanIsLocked = isLocked.trim().toLowerCase();
      
      // LÓGICA ROBUSTA: Verificar TODAS as condições
      let status = 'active';
      
      // Primeiro: verificar IsExpired
      if (cleanIsExpired === 'true') {
        status = 'expired';
      } 
      // Segundo: verificar IsLocked
      else if (cleanIsLocked === 'true') {
        status = 'suspended';
      }
      // Terceiro: verificar data mesmo que IsExpired="false"
      else if (this.isDateExpired(cleanExpires)) {
        status = 'expired';
        console.log(`⚠️ IMPORTANTE: ${cleanName} tem IsExpired="false" mas data vencida!`);
      }
      
      domains.push({
        domain_name: cleanName,
        expiration_date: cleanExpires,
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
        console.log(`⚠️ Erro detectado para ${domainName}`);
        
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
        
        console.log(`📋 Mensagem de erro extraída: "${errorMessage}"`);
        
        // ============================================
        // EXTRAIR DOMAIN_NAME - MÚLTIPLAS TENTATIVAS
        // ============================================
        let extractedDomainName = domainName; // Usar o que foi passado como fallback
        
        // Tentativa 1: Extrair da mensagem de erro (entre parênteses)
        if (errorMessage) {
          const domainInParentheses = errorMessage.match(/\(([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\)/);
          if (domainInParentheses) {
            extractedDomainName = domainInParentheses[1];
          }
        }
        
        // Tentativa 2: Extrair do XML (DomainName attribute)
        if (extractedDomainName === domainName) {
          const domainNameAttr = xmlData.match(/DomainName="([^"]+)"/);
          if (domainNameAttr) {
            extractedDomainName = domainNameAttr[1];
          }
        }
        
        console.log(`📋 Domínio extraído: ${extractedDomainName}`);
        
        // Determinar tipo de erro
        let errorType = 'unknown';
        if (errorMessage) {
          const msg = errorMessage.toLowerCase();
          
          if (msg.includes('too many requests') || msg.includes('rate limit')) {
            errorType = 'rate_limit';
            console.log(`🚫 Rate limit detectado para ${extractedDomainName}`);
          } else if (msg.includes('locked') || msg.includes('suspended')) {
            errorType = 'domain_suspended';
            console.log(`🔒 Domínio suspenso/bloqueado: ${extractedDomainName}`);
          } else {
            errorType = 'other_error';
            console.log(`⚠️ Outro tipo de erro para ${extractedDomainName}`);
          }
        }
        
        // ============================================
        // PARSE 3: EXTRAIR ALERTAS
        // ============================================
        let statusType = 'active';
        const errorMsg = (errorMessage || '').toLowerCase();
        
        if (errorMsg.includes('suspended')) {
          statusType = 'suspended';
          console.log(`📊 Status definido: suspended (baseado na mensagem de erro)`);
        } else if (errorMsg.includes('locked')) {
          statusType = 'suspended';
          console.log(`📊 Status definido: suspended (domínio locked)`);
        } else if (errorMsg.includes('expired')) {
          statusType = 'expired';
          console.log(`📊 Status definido: expired (baseado na mensagem de erro)`);
        } else if (errorMsg.includes('pending')) {
          statusType = 'pending';
          console.log(`📊 Status definido: pending (baseado na mensagem de erro)`);
        }
        
        // Extrair link de unsuspension se existir
        let unsuspensionLink = null;
        const linkMatch = errorMessage ? errorMessage.match(/https:\/\/[^\s]+/) : null;
        if (linkMatch) {
          unsuspensionLink = linkMatch[0];
          console.log(`🔗 Link de unsuspension encontrado: ${unsuspensionLink}`);
        }
        
        // ============================================
        // TIMESTAMP - Formato ISO com timezone Brasil
        // ============================================
        const now = new Date();
        const brasilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const timestampISO = brasilTime.toISOString().slice(0, 19) + '-03:00';
        
        // Traduzir mensagem de alerta
        console.log(`🌐 Iniciando tradução do alerta para ${extractedDomainName}...`);
        const translatedError = await this.translateAlert(errorMessage, extractedDomainName);
        
        console.log(`✅ Parse de erro completo para ${extractedDomainName}`);
        console.log(`   Status: ${statusType}`);
        console.log(`   Tipo de erro: ${errorType}`);
        console.log(`   Tem alerta: ${translatedError ? 'Sim' : 'Não'}`);
        
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
          last_stats_update: timestampISO
        };
      }

      // ============================================
      // SUCESSO: EXTRAIR DADOS DO DOMÍNIO ATIVO/EXPIRADO
      // ============================================
      console.log(`✅ Resposta bem-sucedida para ${domainName}, fazendo parse...`);
      
      const domainNameMatch = xmlData.match(/DomainName="([^"]+)"/);
      const domain_name = domainNameMatch ? domainNameMatch[1].trim() : domainName;
      
      const expiredDateMatch = xmlData.match(/<ExpiredDate>([^<]+)<\/ExpiredDate>/);
      const expiration_date = expiredDateMatch ? expiredDateMatch[1].trim() : null;
      
      const createdMatch = xmlData.match(/<CreatedDate>([^<]+)<\/CreatedDate>/);
      const purchase_date = createdMatch ? createdMatch[1].trim() : null;
      
      // ═══════════════════════════════════════════════════════════════
      // LÓGICA ROBUSTA: Usar método com múltiplas verificações
      // ═══════════════════════════════════════════════════════════════
      const status = this.determineExpiredStatus(xmlData, domain_name);

      // Extrair nameservers
      const nameservers = [];
      const nsPattern = /<Nameserver>([^<]+)<\/Nameserver>/g;
      let nsMatch;
      while ((nsMatch = nsPattern.exec(xmlData)) !== null) {
        if (nsMatch[1] && nsMatch[1].trim()) {
          const ns = nsMatch[1].trim();
          if (!nameservers.includes(ns)) {
            nameservers.push(ns);
          }
        }
      }
      console.log(`📋 Nameservers encontrados: ${nameservers.length}`);

      // Extrair auto renew
      const autoRenewMatch = xmlData.match(/<UseAutoRenew>([^<]+)<\/UseAutoRenew>/);
      const auto_renew = autoRenewMatch ? autoRenewMatch[1].trim().toLowerCase() === 'true' : false;

      // Timestamp Brasil
      const now = new Date();
      const brasilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const timestampISO = brasilTime.toISOString().slice(0, 19) + '-03:00';

      console.log(`✅ Parse completo para ${domain_name}`);
      console.log(`   Status: ${status}`);
      console.log(`   Expiração: ${expiration_date}`);
      console.log(`   Nameservers: ${nameservers.length > 0 ? 'Configurados' : 'Não configurados'}`);

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
        last_stats_update: timestampISO,
        has_alert: null
      };
    } catch (error) {
      console.error(`❌ Erro na requisição para ${domainName}:`, error.message);
      
      const now = new Date();
      const brasilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const timestampISO = brasilTime.toISOString().slice(0, 19) + '-03:00';
      
      return {
        domain_name: domainName,
        has_error: true,
        error_type: 'request_failed',
        error_message: error.message,
        status: 'unknown',
        last_stats_update: timestampISO
      };
    }
  }

  async syncAllDomains() {
    const allDomains = [];
    let currentPage = 1;
    let hasMore = true;

    console.log('🔄 Iniciando listagem de todos os domínios...');
    
    while (hasMore) {
      const result = await this.listDomains(currentPage);
      allDomains.push(...result.domains);
      
      console.log(`📋 Página ${currentPage}/${result.pagination.totalPages} - ${result.domains.length} domínios`);
      
      hasMore = result.pagination.hasMore;
      currentPage++;
      
      if (hasMore) {
        await this.delay(200);
      }
    }

    console.log(`✅ Total de ${allDomains.length} domínios listados`);
    return allDomains;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new NamecheapDomainsService();