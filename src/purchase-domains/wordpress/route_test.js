/**
 * ROTA DE TESTE - WHM + WORDPRESS + PASSBOLT
 * Fluxo: 1. Criar conta WHM → 2. Instalar WordPress (com senha do Passbolt) → 3. Instalar Plugins
 */

const express = require('express');
const axios = require('axios');
const openpgp = require('openpgp');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const config = require('../../config/env');
const FormData = require('form-data');

const router = express.Router();

// ========== FUNÇÕES PASSBOLT ==========

async function authenticatePassbolt() {
  console.log('\n🔐 [PASSBOLT] AUTENTICANDO...');
  
  const baseUrl = (config.PASSBOLT_BASE_URL || '').replace(/\/$/, '');
  const userId = config.PASSBOLT_USER_ID;
  const passphrase = config.PASSBOLT_PASSPHRASE;
  const privateKeyArmored = (config.PASSBOLT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  
  if (!baseUrl || !userId || !passphrase || !privateKeyArmored) {
    console.error('❌ Configuração incompleta:');
    console.error('   BASE_URL:', baseUrl ? 'OK' : 'FALTANDO');
    console.error('   USER_ID:', userId ? 'OK' : 'FALTANDO');
    console.error('   PASSPHRASE:', passphrase ? 'OK' : 'FALTANDO');
    console.error('   PRIVATE_KEY:', privateKeyArmored ? 'OK' : 'FALTANDO');
    throw new Error('Configuração do Passbolt incompleta');
  }
  
  console.log('   URL:', baseUrl);
  console.log('   User ID:', userId);
  
  console.log('1️⃣ Buscando chave do servidor...');
  const verifyRes = await axios.get(`${baseUrl}/auth/verify.json`, { timeout: 30000 });
  const serverKey = await openpgp.readKey({ armoredKey: verifyRes.data.body.keydata });
  console.log('   ✅ OK');
  
  console.log('2️⃣ Descriptografando chave privada...');
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  const userKey = await openpgp.decryptKey({ privateKey, passphrase });
  console.log('   ✅ OK');
  
  console.log('3️⃣ Criando challenge...');
  const verifyToken = uuidv4();
  const challengeData = {
    version: "1.0.0",
    domain: baseUrl,
    verify_token: verifyToken,
    verify_token_expiry: String(Math.floor(Date.now() / 1000) + 120)
  };
  
  const encryptedChallenge = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: JSON.stringify(challengeData) }),
    encryptionKeys: serverKey,
    signingKeys: userKey
  });
  console.log('   ✅ OK');
  
  console.log('4️⃣ Enviando login...');
  const loginRes = await axios.post(
    `${baseUrl}/auth/jwt/login.json`,
    { user_id: userId, challenge: encryptedChallenge },
    { timeout: 30000 }
  );
  console.log('   ✅ OK');
  
  console.log('5️⃣ Validando resposta...');
  const decryptedMsg = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: loginRes.data.body.challenge }),
    decryptionKeys: userKey
  });
  
  const decryptedData = JSON.parse(decryptedMsg.data);
  if (decryptedData.verify_token !== verifyToken) {
    throw new Error('Token inválido');
  }
  console.log('   ✅ Token JWT obtido');
  
  return {
    token: decryptedData.access_token,
    cookies: loginRes.headers['set-cookie'],
    userKey: userKey,
    baseUrl: baseUrl
  };
}

async function getPasswordFromPassbolt() {
  console.log('\n🔐 [PASSBOLT] BUSCANDO SENHA DO WORDPRESS...');
  
  const resourceId = config.PASSBOLT_RESOURCE_ID;
  const authData = await authenticatePassbolt();
  
  const headers = {
    'Authorization': `Bearer ${authData.token}`,
    'Content-Type': 'application/json'
  };
  if (authData.cookies) {
    headers['Cookie'] = authData.cookies.join('; ');
  }
  
  console.log('🔍 Buscando secret...');
  const secretRes = await axios.get(
    `${authData.baseUrl}/secrets/resource/${resourceId}.json`,
    { headers, timeout: 30000 }
  );
  console.log('   ✅ Secret obtido');
  
  console.log('🔓 Descriptografando...');
  const decryptedMsg = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: secretRes.data.body.data }),
    decryptionKeys: authData.userKey
  });
  
  let password;
  try {
    const secretData = JSON.parse(decryptedMsg.data);
    password = secretData.password;
  } catch {
    password = decryptedMsg.data;
  }
  
  console.log(`   ✅ Senha obtida (${password.length} caracteres)`);
  return password;
}

// ========== ETAPA 1: CRIAR CONTA WHM ==========

async function createWHMAccount(domain) {
  console.log('\n' + '='.repeat(70));
  console.log('📦 [ETAPA 1] CRIANDO CONTA NO WHM');
  console.log('='.repeat(70));
  console.log('   Domain:', domain);
  console.log('   Username:', config.WHM_ACCOUNT_USERNAME);
  
  const params = new URLSearchParams({
    api_token_style: '1',
    domain: domain,
    username: config.WHM_ACCOUNT_USERNAME,
    password: config.WHM_ACCOUNT_PASSWORD,
    plan: config.WHM_ACCOUNT_PACKAGE,
    savepkg: '0',
    featurelist: 'default',
    quota: '0',
    maxftp: '0',
    maxsql: '0',
    maxpop: '0',
    maxlst: '0',
    maxsub: '0',
    maxpark: '0',
    maxaddon: '0',
    bwlimit: '0',
    hasshell: '0',
    cgi: '1',
    cpmod: 'jupiter',
    ip: 'n',
    dkim: '1',
    spf: '1'
  });
  
  console.log('📤 Enviando para WHM...');
  
  const response = await axios.get(
    `${config.WHM_URL}/json-api/createacct?${params.toString()}`,
    {
      headers: {
        'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
      },
      timeout: 120000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    }
  );
  
  console.log('📥 Resposta WHM:', JSON.stringify(response.data, null, 2));
  
  const result = response.data?.metadata?.result || response.data?.result;
  const statusmsg = response.data?.result?.[0]?.statusmsg || '';
  
  if (result === 1 || result === '1' || statusmsg.toLowerCase().includes('successfully')) {
    console.log('✅ [ETAPA 1] CONTA WHM CRIADA COM SUCESSO!');
    return { success: true };
  }
  
  console.log('❌ [ETAPA 1] FALHA AO CRIAR CONTA WHM');
  return { success: false, error: statusmsg };
}

// ========== ETAPA 2: INSTALAR WORDPRESS ==========

async function installWordPress(domain) {
  console.log('\n' + '='.repeat(70));
  console.log('🌐 [ETAPA 2] INSTALANDO WORDPRESS');
  console.log('='.repeat(70));
  console.log('   Domain:', domain);
  console.log('   Username:', config.WORDPRESS_DEFAULT_USER);
  
  const wpPassword = await getPasswordFromPassbolt();
  
  console.log('📤 Instalando WordPress via Softaculous...');
  
  try {
    console.log('🔑 Criando sessão no cPanel...');
    const sessionResponse = await axios.get(
      `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${config.WHM_ACCOUNT_USERNAME}&service=cpaneld`,
      {
        headers: {
          'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
        },
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      }
    );
    
    const sessionData = sessionResponse.data?.data;
    const cpSecurityToken = sessionData?.cp_security_token;
    
    if (!cpSecurityToken) {
      throw new Error('Não foi possível criar sessão no cPanel');
    }
    
    console.log('✅ Sessão criada, token:', cpSecurityToken);
    
    const raw = domain.split('.')[0];
    let siteName = raw.charAt(0).toUpperCase() + raw.slice(1);
    
    try {
      const openaiResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Extraia as 2 primeiras palavras de um domínio concatenado. Responda APENAS com as 2 palavras separadas por espaço onde cada palavra começa com letra maiúscula, sem pontuação. Me entregue apenas o solicitado, sem comentários ou explicações.'
            },
            {
              role: 'user',
              content: raw
            }
          ],
          max_tokens: 20,
          temperature: 0
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      siteName = openaiResponse.data.choices[0].message.content.trim();
    } catch (err) {
      console.log('⚠️ OpenAI falhou, usando nome original:', err.message);
    }
    
    console.log('📝 Nome do site:', siteName);
    
    const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
    const softUrl = `${baseUrl}${cpSecurityToken}/frontend/jupiter/softaculous/index.live.php?act=software&soft=26&api=json`;
    
    const postData = {
      softsubmit: '1',
      softproto: '3',
      softdomain: domain,
      softdirectory: '',
      site_name: siteName,
      site_desc: siteName,
      admin_username: config.WORDPRESS_DEFAULT_USER,
      admin_pass: wpPassword,
      admin_email: config.WORDPRESS_ADMIN_EMAIL || 'domain@gexcorp.com.br',
      language: 'pt_BR',
      noemail: '1'
    };
    
    console.log('📤 URL:', softUrl);
    console.log('📤 POST Data:', JSON.stringify({ ...postData, admin_pass: '***' }, null, 2));
    
    const installResponse = await axios.post(
      softUrl,
      new URLSearchParams(postData).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `cpsession=${sessionData.session}`
        },
        timeout: 300000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        maxRedirects: 5
      }
    );
    
    const responseData = installResponse.data;
    console.log('📥 Resposta:', JSON.stringify(responseData, null, 2).substring(0, 2000));
    
    if (responseData.done || responseData.done === 1 || responseData.done === '1') {
      console.log('✅ [ETAPA 2] WORDPRESS INSTALADO COM SUCESSO!');
      return { 
        success: true, 
        url: responseData.__settings?.softurl || `https://${domain}`,
        admin_url: responseData.__settings?.softurl ? `${responseData.__settings.softurl}/wp-admin` : `https://${domain}/wp-admin`
      };
    }
    
    if (responseData.error) {
      const errorMsg = Array.isArray(responseData.error) ? responseData.error.join(', ') : JSON.stringify(responseData.error);
      console.log('❌ Erro:', errorMsg);
      return { success: false, error: errorMsg };
    }
    
    const responseText = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
    if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
      console.log('❌ Resposta HTML inesperada');
      return { success: false, error: 'API retornou HTML em vez de JSON' };
    }
    
    console.log('❌ [ETAPA 2] FALHA AO INSTALAR WORDPRESS');
    return { success: false, error: responseText.substring(0, 500) };
    
  } catch (error) {
    console.error('❌ [ETAPA 2] ERRO:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      const errData = error.response.data;
      console.error('   Data:', typeof errData === 'string' ? errData.substring(0, 500) : JSON.stringify(errData, null, 2));
    }
    return { success: false, error: error.message };
  }
}

// ========== AUTENTICAÇÃO WORDPRESS VIA COOKIE ==========

/**
 * Autentica no WordPress via wp-login.php e retorna cookies + nonce
 * 
 * COMO FUNCIONA:
 * 1. POST para wp-login.php com credenciais
 * 2. WordPress retorna cookies de sessão (wordpress_logged_in_*, wordpress_sec_*)
 * 3. Acessamos wp-admin para extrair o nonce (token CSRF)
 * 4. Usamos cookies + nonce para chamar REST API
 * 
 * POSSÍVEIS FALHAS:
 * - Senha incorreta → status 200 mas sem redirect (verificamos pelo Location header)
 * - Proteção brute-force → status 403 ou captcha
 * - REST API desabilitada → /wp-json/ retorna 404
 */
async function authenticateWordPress(domain, username, password) {
  console.log('\n🔐 [WORDPRESS] Autenticando via Cookie...');
  
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const wpUrl = `https://${domain}`;
  
  // PASSO 1: Fazer login no WordPress
  console.log('   1️⃣ Fazendo login em wp-login.php...');
  
  const loginData = new URLSearchParams({
    log: username,
    pwd: password,
    'wp-submit': 'Log In',
    redirect_to: `${wpUrl}/wp-admin/`,
    testcookie: '1'
  });
  
  let loginResponse;
  try {
    loginResponse = await axios.post(
      `${wpUrl}/wp-login.php`,
      loginData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': 'wordpress_test_cookie=WP%20Cookie%20check',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        httpsAgent,
        timeout: 30000,
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302
      }
    );
  } catch (error) {
    // Axios trata 302 como erro por padrão quando maxRedirects: 0
    if (error.response && error.response.status === 302) {
      loginResponse = error.response;
    } else {
      throw new Error(`Falha no login: ${error.message}`);
    }
  }
  
  // Verificar se login foi bem-sucedido (deve retornar 302 redirect)
  const setCookies = loginResponse.headers['set-cookie'] || [];
  const hasAuthCookie = setCookies.some(c => 
    c.includes('wordpress_logged_in') || c.includes('wordpress_sec')
  );
  
  if (!hasAuthCookie) {
    // Verificar se retornou página de erro
    const responseData = loginResponse.data || '';
    if (responseData.includes('ERROR') || responseData.includes('error')) {
      throw new Error('Credenciais inválidas ou usuário bloqueado');
    }
    throw new Error('Login falhou - cookies de autenticação não recebidos');
  }
  
  // Formatar cookies para uso em requests
  const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');
  console.log('   ✅ Login OK - cookies obtidos');
  
  // PASSO 2: Acessar wp-admin para obter nonce
  console.log('   2️⃣ Obtendo nonce do wp-admin...');
  
  const adminResponse = await axios.get(`${wpUrl}/wp-admin/plugins.php`, {
    headers: {
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    httpsAgent,
    timeout: 30000,
    maxRedirects: 5
  });
  
  const adminHtml = adminResponse.data;
  
  // Extrair nonce - pode estar em diferentes lugares
  let nonce = null;
  
  // Método 1: wpApiSettings.nonce (mais comum)
  const wpApiMatch = adminHtml.match(/wpApiSettings\s*=\s*\{[^}]*"nonce"\s*:\s*"([^"]+)"/);
  if (wpApiMatch) {
    nonce = wpApiMatch[1];
  }
  
  // Método 2: _wpnonce em forms
  if (!nonce) {
    const wpNonceMatch = adminHtml.match(/name="_wpnonce"\s+value="([^"]+)"/);
    if (wpNonceMatch) {
      nonce = wpNonceMatch[1];
    }
  }
  
  // Método 3: wp_rest nonce
  if (!nonce) {
    const restNonceMatch = adminHtml.match(/"wp_rest"\s*:\s*"([^"]+)"/);
    if (restNonceMatch) {
      nonce = restNonceMatch[1];
    }
  }
  
  // Método 4: data-wp-nonce attribute
  if (!nonce) {
    const dataNonceMatch = adminHtml.match(/data-wp-nonce="([^"]+)"/);
    if (dataNonceMatch) {
      nonce = dataNonceMatch[1];
    }
  }
  
  if (!nonce) {
    console.log('   ⚠️ Nonce não encontrado no HTML, tentando sem nonce...');
  } else {
    console.log('   ✅ Nonce obtido');
  }
  
  // PASSO 3: Verificar se REST API está acessível
  console.log('   3️⃣ Verificando REST API...');
  
  try {
    const restCheck = await axios.get(`${wpUrl}/wp-json/wp/v2/plugins`, {
      headers: {
        'Cookie': cookieString,
        'X-WP-Nonce': nonce || '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      httpsAgent,
      timeout: 30000,
      validateStatus: (status) => status < 500
    });
    
    if (restCheck.status === 401) {
      throw new Error('REST API retornou 401 - autenticação não aceita');
    }
    
    if (restCheck.status === 404) {
      throw new Error('REST API de plugins não encontrada (404)');
    }
    
    if (restCheck.status === 403) {
      throw new Error('Sem permissão para acessar plugins (403)');
    }
    
    console.log('   ✅ REST API acessível');
    
  } catch (error) {
    throw new Error(`REST API inacessível: ${error.message}`);
  }
  
  return {
    cookies: cookieString,
    nonce: nonce,
    wpUrl: wpUrl
  };
}

// ========== ETAPA 3: INSTALAR PLUGINS ==========

async function installPlugins(domain) {
  console.log('\n' + '='.repeat(70));
  console.log('🔌 [ETAPA 3] INSTALANDO PLUGINS');
  console.log('='.repeat(70));
  
  const results = [];
  
  try {
    // Lista de plugins
    console.log('📋 Carregando lista de plugins...');
    const githubBaseUrl = 'https://raw.githubusercontent.com/matheuslima-glitch/wordpress-plugins/main';
    
    const pluginNames = [
      'duplicate-post',
      'elementor',
      'elementor-pro',
      'google-site-kit',
      'insert-headers-and-footers',
      'litespeed-cache',
      'rename-wp-admin-login',
      'wordfence',
      'wordpress-seo',
      'wordpress-seo-premium'
    ];
    
    const plugins = pluginNames.map(name => ({
      name: name,
      downloadUrl: `${githubBaseUrl}/${name}.zip`
    }));
    
    console.log(`✅ ${plugins.length} plugins configurados`);
    
    // Instalar via cPanel File Manager
    return await installPluginsViaFileManager(domain, plugins);
    
  } catch (error) {
    console.error('❌ [ETAPA 3] ERRO:', error.message);
    return { success: false, error: error.message };
  }
}

// Instalar plugins via File Manager do cPanel
async function installPluginsViaFileManager(domain, plugins) {
  console.log('\n📁 Instalando plugins via cPanel File Manager...');
  
  const results = [];
  
  try {
    // Criar sessão no cPanel
    console.log('🔑 Criando sessão no cPanel...');
    const sessionResponse = await axios.get(
      `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${config.WHM_ACCOUNT_USERNAME}&service=cpaneld`,
      {
        headers: {
          'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
        },
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      }
    );
    
    const sessionData = sessionResponse.data?.data;
    const cpSecurityToken = sessionData?.cp_security_token;
    
    if (!cpSecurityToken) {
      throw new Error('Não foi possível criar sessão no cPanel');
    }
    
    console.log('✅ Sessão cPanel criada');
    
    const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
    const pluginsPath = `/home/${config.WHM_ACCOUNT_USERNAME}/public_html/wp-content/plugins`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `cpsession=${sessionData.session}`
    };
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    
    // Lista de plugins instalados com sucesso (para ativação posterior)
    const installedPlugins = [];
    
    for (const plugin of plugins) {
      console.log(`\n📦 Instalando ${plugin.name}...`);
      
      try {
        const zipPath = `${pluginsPath}/${plugin.name}.zip`;
        
        // PASSO 1: Deletar ZIP antigo e pasta do plugin se existirem
        console.log(`   🗑️ Limpando arquivos antigos...`);
        const trashUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/trash`;
        
        try {
          await axios.post(trashUrl, new URLSearchParams({ path: zipPath }).toString(), {
            headers, timeout: 15000, httpsAgent
          });
        } catch (e) { /* ignora se não existe */ }
        
        // Deletar pasta do plugin se existir (para reinstalação limpa)
        try {
          await axios.post(trashUrl, new URLSearchParams({ path: `${pluginsPath}/${plugin.name}` }).toString(), {
            headers, timeout: 15000, httpsAgent
          });
        } catch (e) { /* ignora se não existe */ }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // PASSO 2: Baixar o ZIP do GitHub
        console.log(`   ⬇️ Baixando do GitHub...`);
        const zipResponse = await axios.get(plugin.downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 300000,
          headers: { 'User-Agent': 'DomainHub-Backend' }
        });
        
        const sizeMB = (zipResponse.data.length / 1024 / 1024).toFixed(2);
        console.log(`   📦 Tamanho: ${sizeMB} MB`);
        
        // PASSO 3: Upload do ZIP para cPanel
        console.log(`   📤 Enviando para servidor...`);
        const uploadUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`;
        
        const form = new FormData();
        form.append('dir', pluginsPath);
        form.append('overwrite', '1');
        form.append('file-0', Buffer.from(zipResponse.data), {
          filename: `${plugin.name}.zip`,
          contentType: 'application/zip'
        });
        
        const uploadResponse = await axios.post(uploadUrl, form, {
          headers: {
            ...form.getHeaders(),
            'Cookie': `cpsession=${sessionData.session}`
          },
          timeout: 300000,
          httpsAgent
        });
        
        const uploadData = uploadResponse.data?.data;
        if (!uploadData || uploadData.succeeded !== 1) {
          const reason = uploadData?.uploads?.[0]?.reason || JSON.stringify(uploadResponse.data?.errors);
          throw new Error(`Upload falhou: ${reason}`);
        }
        console.log(`   ✅ Upload OK`);
        
        // PASSO 4: Extrair ZIP usando API do cPanel
        console.log(`   📂 Extraindo arquivos...`);
        
        let extractSuccess = false;
        
        // Método 1: Tentar via cPanel API2 Fileman fileop
        try {
          const shellUrl = `${baseUrl}${cpSecurityToken}/json-api/cpanel`;
          const shellParams = new URLSearchParams({
            'cpanel_jsonapi_user': config.WHM_ACCOUNT_USERNAME,
            'cpanel_jsonapi_apiversion': '2',
            'cpanel_jsonapi_module': 'Fileman',
            'cpanel_jsonapi_func': 'fileop',
            'op': 'extract',
            'sourcefiles': zipPath,
            'destfiles': pluginsPath,
            'overwrite': '1'
          });
          
          const shellResponse = await axios.post(shellUrl, shellParams.toString(), {
            headers, timeout: 120000, httpsAgent
          });
          
          if (shellResponse.data?.cpanelresult?.data?.[0]?.result === 1) {
            extractSuccess = true;
            console.log(`   ✅ Extração via Fileman OK`);
          }
        } catch (e) {
          console.log(`   ⚠️ Método Fileman falhou: ${e.message}`);
        }
        
        // Método 2: Tentar via WHM API
        if (!extractSuccess) {
          try {
            console.log(`   🔄 Tentando extração via WHM...`);
            const whmExtractUrl = `${config.WHM_URL}/json-api/cpanel`;
            const whmParams = new URLSearchParams({
              'cpanel_jsonapi_user': config.WHM_ACCOUNT_USERNAME,
              'cpanel_jsonapi_apiversion': '2',
              'cpanel_jsonapi_module': 'Fileman',
              'cpanel_jsonapi_func': 'fileop',
              'op': 'extract',
              'sourcefiles': zipPath,
              'destfiles': pluginsPath
            });
            
            const whmResponse = await axios.post(whmExtractUrl, whmParams.toString(), {
              headers: {
                'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              timeout: 120000,
              httpsAgent
            });
            
            if (whmResponse.data?.cpanelresult?.data?.[0]?.result === 1 ||
                whmResponse.data?.cpanelresult?.event?.result === 1) {
              extractSuccess = true;
              console.log(`   ✅ Extração via WHM OK`);
            }
          } catch (e) {
            console.log(`   ⚠️ Método WHM falhou: ${e.message}`);
          }
        }
        
        if (!extractSuccess) {
          throw new Error('Todos os métodos de extração falharam');
        }
        
        // PASSO 5: Deletar ZIP após extração
        console.log(`   🗑️ Removendo arquivo ZIP...`);
        try {
          await axios.post(trashUrl, new URLSearchParams({ path: zipPath }).toString(), {
            headers, timeout: 15000, httpsAgent
          });
        } catch (e) { /* ignora */ }
        
        console.log(`   ✅ ${plugin.name} INSTALADO COM SUCESSO!`);
        results.push({ plugin: plugin.name, success: true });
        installedPlugins.push(plugin.name);
        
      } catch (err) {
        console.log(`   ❌ FALHA ${plugin.name}: ${err.message}`);
        results.push({ plugin: plugin.name, success: false, error: err.message });
      }
      
      // Pausa entre plugins
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    
    console.log('\n' + '='.repeat(50));
    console.log(`📊 RESULTADO INSTALAÇÃO: ${successCount}/${plugins.length} plugins`);
    if (failedCount > 0) {
      console.log(`⚠️ ${failedCount} plugins falharam`);
    }
    console.log('='.repeat(50));
    
    // ETAPA 4: Ativar plugins via REST API do WordPress
    if (installedPlugins.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🔧 [ETAPA 4] ATIVANDO E CONFIGURANDO PLUGINS');
      console.log('='.repeat(70));
      
      const activationResults = await activatePluginsViaREST(domain, installedPlugins);
      
      return { 
        success: successCount > 0, 
        total: plugins.length,
        installed: successCount,
        failed: failedCount,
        results,
        activation: activationResults
      };
    }
    
    return { 
      success: successCount > 0, 
      total: plugins.length,
      installed: successCount,
      failed: failedCount,
      results 
    };
    
  } catch (error) {
    console.error('❌ Erro crítico no File Manager:', error.message);
    return { success: false, error: error.message, results };
  }
}

// ========== ATIVAR PLUGINS VIA REST API ==========

/**
 * Ativa plugins via WordPress REST API usando Cookie Authentication
 * 
 * FLUXO:
 * 1. Autenticar via wp-login.php → obter cookies
 * 2. Acessar wp-admin → obter nonce
 * 3. GET /wp-json/wp/v2/plugins → listar plugins instalados
 * 4. POST /wp-json/wp/v2/plugins/{plugin} → ativar cada plugin
 * 5. POST /wp-json/wp/v2/plugins/{plugin} → ativar auto-update
 * 
 * POSSÍVEIS FALHAS:
 * - Login falha: credenciais erradas, usuário bloqueado
 * - Nonce inválido: sessão expirada
 * - Plugin não encontrado: slug diferente do esperado
 * - Sem permissão: usuário não é admin
 */
async function activatePluginsViaREST(domain, pluginNames) {
  console.log('\n🔌 Ativando plugins via WordPress REST API...');
  
  const results = {
    activated: [],
    autoUpdateEnabled: [],
    updated: [],
    errors: []
  };
  
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  
  try {
    // Obter senha do WordPress
    const wpPassword = await getPasswordFromPassbolt();
    const wpUser = config.WORDPRESS_DEFAULT_USER;
    
    // Autenticar no WordPress
    const auth = await authenticateWordPress(domain, wpUser, wpPassword);
    
    const headers = {
      'Cookie': auth.cookies,
      'X-WP-Nonce': auth.nonce || '',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    
    // PASSO 1: Listar todos os plugins instalados
    console.log('\n   📋 Listando plugins instalados...');
    
    const listResponse = await axios.get(`${auth.wpUrl}/wp-json/wp/v2/plugins`, {
      headers,
      httpsAgent,
      timeout: 30000
    });
    
    const installedPlugins = listResponse.data || [];
    console.log(`   ✅ ${installedPlugins.length} plugins encontrados`);
    
    // Criar mapa de plugins por nome
    const pluginMap = {};
    installedPlugins.forEach(p => {
      // O plugin file é algo como "elementor/elementor.php"
      const pluginFolder = p.plugin.split('/')[0];
      pluginMap[pluginFolder] = p;
    });
    
    // PASSO 2: Ativar cada plugin
    console.log('\n   🔌 Ativando plugins...');
    
    for (const pluginName of pluginNames) {
      const plugin = pluginMap[pluginName];
      
      if (!plugin) {
        console.log(`   ⚠️ ${pluginName}: não encontrado na lista`);
        results.errors.push({ plugin: pluginName, action: 'find', error: 'Plugin não encontrado' });
        continue;
      }
      
      const pluginSlug = plugin.plugin;
      const encodedSlug = encodeURIComponent(pluginSlug);
      
      // Verificar se já está ativo
      if (plugin.status === 'active') {
        console.log(`   ℹ️ ${pluginName}: já está ativo`);
        results.activated.push(pluginName);
        continue;
      }
      
      // Ativar plugin
      try {
        const activateResponse = await axios.post(
          `${auth.wpUrl}/wp-json/wp/v2/plugins/${encodedSlug}`,
          { status: 'active' },
          { headers, httpsAgent, timeout: 60000 }
        );
        
        if (activateResponse.data?.status === 'active') {
          console.log(`   ✅ ${pluginName}: ativado`);
          results.activated.push(pluginName);
        } else {
          console.log(`   ⚠️ ${pluginName}: resposta inesperada`);
          results.errors.push({ plugin: pluginName, action: 'activate', error: 'Status não confirmado' });
        }
      } catch (activateErr) {
        const errMsg = activateErr.response?.data?.message || activateErr.message;
        console.log(`   ❌ ${pluginName}: ${errMsg}`);
        results.errors.push({ plugin: pluginName, action: 'activate', error: errMsg });
      }
      
      // Pequena pausa entre ativações
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // PASSO 3: Forçar verificação de atualizações
    console.log('\n   📥 Forçando verificação de atualizações...');
    
    try {
      // Chamar o cron do WordPress para verificar atualizações
      await axios.get(`${auth.wpUrl}/wp-cron.php?doing_wp_cron`, {
        httpsAgent,
        timeout: 30000
      });
      
      // Também tentar via admin-ajax
      await axios.post(
        `${auth.wpUrl}/wp-admin/admin-ajax.php`,
        new URLSearchParams({
          action: 'update-plugin',
          _ajax_nonce: auth.nonce || ''
        }).toString(),
        {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          httpsAgent,
          timeout: 30000,
          validateStatus: () => true // Aceitar qualquer status
        }
      );
      
      console.log('   ✅ Verificação de atualizações disparada');
      results.updated.push('update_check_triggered');
    } catch (updateErr) {
      console.log(`   ⚠️ Erro ao verificar atualizações: ${updateErr.message}`);
    }
    
    // PASSO 4: Ativar auto-update para cada plugin
    console.log('\n   🔄 Ativando auto-update...');
    
    // Recarregar lista de plugins para pegar status atualizado
    const updatedListResponse = await axios.get(`${auth.wpUrl}/wp-json/wp/v2/plugins`, {
      headers,
      httpsAgent,
      timeout: 30000
    });
    
    const updatedPlugins = updatedListResponse.data || [];
    
    for (const pluginName of pluginNames) {
      const plugin = updatedPlugins.find(p => p.plugin.startsWith(pluginName + '/'));
      
      if (!plugin) continue;
      
      const pluginSlug = plugin.plugin;
      const encodedSlug = encodeURIComponent(pluginSlug);
      
      try {
        // WordPress 5.5+ suporta auto_update via REST API
        const autoUpdateResponse = await axios.post(
          `${auth.wpUrl}/wp-json/wp/v2/plugins/${encodedSlug}`,
          { auto_update: true },
          { headers, httpsAgent, timeout: 30000 }
        );
        
        if (autoUpdateResponse.data) {
          console.log(`   ✅ ${pluginName}: auto-update ativado`);
          results.autoUpdateEnabled.push(pluginName);
        }
      } catch (autoErr) {
        // Auto-update pode não ser suportado em algumas configurações
        console.log(`   ⚠️ ${pluginName}: auto-update não disponível`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 RESULTADO ATIVAÇÃO:');
    console.log(`   ✅ Ativados: ${results.activated.length}`);
    console.log(`   🔄 Auto-update: ${results.autoUpdateEnabled.length}`);
    console.log(`   ❌ Erros: ${results.errors.length}`);
    console.log('='.repeat(50));
    
    return results;
    
  } catch (error) {
    console.error('❌ Erro na ativação:', error.message);
    results.errors.push({ plugin: 'all', action: 'general', error: error.message });
    return results;
  }
}

// ========== FUNÇÃO PRINCIPAL ==========

async function setupDomain(domain) {
  const result = {
    domain: domain,
    etapa1_whm: null,
    etapa2_wordpress: null,
    etapa3_plugins: null,
    success: false
  };
  
  result.etapa1_whm = await createWHMAccount(domain);
  
  if (!result.etapa1_whm.success) {
    console.log('\n❌ PROCESSO INTERROMPIDO - Falha na Etapa 1');
    return result;
  }
  
  console.log('\n⏳ Aguardando 10 segundos para propagação da conta...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  result.etapa2_wordpress = await installWordPress(domain);
  
  if (!result.etapa2_wordpress.success) {
    console.log('\n❌ PROCESSO INTERROMPIDO - Falha na Etapa 2');
    return result;
  }
  
  console.log('\n⏳ Aguardando 5 segundos para WordPress inicializar...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  result.etapa3_plugins = await installPlugins(domain);
  
  result.success = result.etapa1_whm.success && result.etapa2_wordpress.success;
  
  console.log('\n' + '='.repeat(70));
  console.log(result.success ? '🎉 PROCESSO COMPLETO COM SUCESSO!' : '⚠️ PROCESSO FINALIZADO COM ERROS');
  console.log('='.repeat(70));
  
  return result;
}

// ========== ROTAS DE TESTE ==========

router.post('/whm-test', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ 
      error: 'Domínio não informado',
      uso: 'POST /api/test/whm-test com body: { "domain": "exemplo.com" }'
    });
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('🧪 [TESTE] INICIANDO SETUP COMPLETO');
  console.log('   Domínio:', domain);
  console.log('='.repeat(70));
  
  try {
    const result = await setupDomain(domain);
    res.json(result);
  } catch (error) {
    console.error('❌ ERRO FATAL:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/whm-only', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domínio não informado' });
  }
  
  try {
    const result = await createWHMAccount(domain);
    res.json({ domain, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/wp-only', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domínio não informado' });
  }
  
  try {
    const result = await installWordPress(domain);
    res.json({ domain, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/plugins-only', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domínio não informado' });
  }
  
  try {
    const result = await installPlugins(domain);
    res.json({ domain, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/passbolt-test', async (req, res) => {
  try {
    const password = await getPasswordFromPassbolt();
    res.json({ success: true, passwordLength: password.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;