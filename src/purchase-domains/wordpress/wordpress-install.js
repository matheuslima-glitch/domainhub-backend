/**
 * INSTALAÇÃO AUTOMÁTICA WORDPRESS
 * Fluxo: 1. Criar conta WHM → 2. Instalar WordPress → 3. Instalar Plugins → 4. Ativar + Configurar
 */

const express = require('express');
const axios = require('axios');
const openpgp = require('openpgp');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const config = require('../../config/env');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// Inicializar Supabase para atualizações de progresso
const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_KEY
);

/**
 * ATUALIZAR PROGRESSO NO SUPABASE
 */
async function updateProgress(sessionId, step, status, message, domainName = null) {
  if (!sessionId) return;
  
  try {
    await supabase
      .from('domain_purchase_progress')
      .upsert({
        session_id: sessionId,
        step: step,
        status: status,
        message: message,
        domain_name: domainName,
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_id' });
    
    console.log(`📊 [WP-PROGRESS] ${step} - ${status} - ${message}`);
    
  } catch (error) {
    console.error('❌ [WP-PROGRESS] Erro:', error.message);
  }
}

// ========== GERAR USERNAME ÚNICO PARA WHM ==========

/**
 * Lista todas as contas existentes no WHM
 * @returns {Promise<string[]>} Array com usernames existentes
 */
async function listExistingWHMAccounts() {
  try {
    const response = await axios.get(
      `${config.WHM_URL}/json-api/listaccts?api.version=1`,
      {
        headers: {
          'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`
        },
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      }
    );
    
    const accounts = response.data?.data?.acct || [];
    return accounts.map(acc => acc.user?.toLowerCase());
  } catch (error) {
    console.error('⚠️ [WHM] Erro ao listar contas:', error.message);
    return [];
  }
}

/**
 * Gera um username único para WHM
 * Formato: gex + 3 números (000-999)
 * Verifica no servidor se já existe antes de retornar
 * @returns {Promise<string>} Username único
 */
async function generateWHMUsername() {
  console.log('🔐 [WHM] Gerando username único...');
  
  const existingUsernames = await listExistingWHMAccounts();
  console.log(`   📋 ${existingUsernames.length} contas existentes no servidor`);
  
  let attempts = 0;
  const maxAttempts = 100;
  
  while (attempts < maxAttempts) {
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const username = `gex${randomNum}`;
    
    if (!existingUsernames.includes(username.toLowerCase())) {
      console.log(`   ✅ Username único: ${username}`);
      return username;
    }
    
    attempts++;
  }
  
  // Fallback: usar timestamp se esgotar tentativas
  const timestamp = Date.now().toString().slice(-3);
  const fallback = `gex${timestamp}`;
  console.log(`   ⚠️ Fallback: ${fallback}`);
  return fallback;
}

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
  
  // Gerar username único
  const username = await generateWHMUsername();
  console.log('   Username:', username);
  
  const params = new URLSearchParams({
    api_token_style: '1',
    domain: domain,
    username: username,
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
  
const resultData = response.data?.result?.[0];
const status = resultData?.status ?? response.data?.metadata?.result;
const statusmsg = resultData?.statusmsg || '';

if (status === 1 || status === '1' || 
    statusmsg.toLowerCase().includes('successfully') || 
    statusmsg.toLowerCase().includes('account creation ok')) {
  console.log('✅ [ETAPA 1] CONTA WHM CRIADA COM SUCESSO!');
  return { success: true, username: username };
}

console.log('❌ [ETAPA 1] FALHA AO CRIAR CONTA WHM');
return { success: false, error: statusmsg || 'Erro desconhecido' };
}

// ========== ETAPA 2: INSTALAR WORDPRESS ==========

async function installWordPress(domain, username) {
  console.log('\n' + '='.repeat(70));
  console.log('🌐 [ETAPA 2] INSTALANDO WORDPRESS');
  console.log('='.repeat(70));
  console.log('   Domain:', domain);
  console.log('   Username:', username);
  console.log('   WP Admin:', config.WORDPRESS_DEFAULT_USER);
  
  const wpPassword = await getPasswordFromPassbolt();
  
  console.log('📤 Instalando WordPress via Softaculous...');
  
  try {
    console.log('🔑 Criando sessão no cPanel...');
    const sessionResponse = await axios.get(
      `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
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

// ========== ETAPA 3: INSTALAR PLUGINS ==========

async function installPlugins(domain, username) {
  console.log('\n' + '='.repeat(70));
  console.log('🔌 [ETAPA 3] INSTALANDO PLUGINS');
  console.log('='.repeat(70));
  
  try {
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
    
    return await installPluginsViaFileManager(domain, plugins, username);
    
  } catch (error) {
    console.error('❌ [ETAPA 3] ERRO:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== FUNÇÕES AUXILIARES DE ARQUIVO ==========

async function deletePluginZip(baseUrl, cpSecurityToken, sessionData, zipPath, httpsAgent, username) {
  const fileName = zipPath.split('/').pop();
  const dirPath = zipPath.substring(0, zipPath.lastIndexOf('/'));
  
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': `cpsession=${sessionData.session}`
  };
  
  // Método 1: UAPI Fileman/delete_files
  try {
    const deleteUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/delete_files`;
    const response = await axios.post(deleteUrl, new URLSearchParams({ 
      dir: dirPath,
      'files-0': fileName
    }).toString(), {
      headers, timeout: 15000, httpsAgent
    });
    
    if (response.data?.status === 1 || response.data?.data) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 2: API2 Fileman fileop unlink
  try {
    const api2Url = `${baseUrl}${cpSecurityToken}/json-api/cpanel`;
    const response = await axios.post(api2Url, new URLSearchParams({
      'cpanel_jsonapi_user': username,
      'cpanel_jsonapi_apiversion': '2',
      'cpanel_jsonapi_module': 'Fileman',
      'cpanel_jsonapi_func': 'fileop',
      'op': 'unlink',
      'sourcefiles': zipPath,
      'doubledecode': '0'
    }).toString(), {
      headers, timeout: 15000, httpsAgent
    });
    
    if (response.data?.cpanelresult?.data?.[0]?.result === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 3: WHM API fileop unlink
  try {
    const whmUrl = `${config.WHM_URL}/json-api/cpanel`;
    const response = await axios.post(whmUrl, new URLSearchParams({
      'cpanel_jsonapi_user': username,
      'cpanel_jsonapi_apiversion': '2',
      'cpanel_jsonapi_module': 'Fileman',
      'cpanel_jsonapi_func': 'fileop',
      'op': 'unlink',
      'sourcefiles': zipPath
    }).toString(), {
      headers: {
        'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000,
      httpsAgent
    });
    
    if (response.data?.cpanelresult?.data?.[0]?.result === 1 ||
        response.data?.cpanelresult?.event?.result === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 4: Fileman/trash
  try {
    const trashUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/trash`;
    const response = await axios.post(trashUrl, new URLSearchParams({ 
      path: zipPath 
    }).toString(), {
      headers, timeout: 15000, httpsAgent
    });
    
    if (response.data?.status === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  return false;
}

async function cleanupPluginZips(baseUrl, cpSecurityToken, sessionData, pluginsPath, httpsAgent, username) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': `cpsession=${sessionData.session}`
  };
  
  try {
    const listUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/list_files`;
    const listResponse = await axios.post(listUrl, new URLSearchParams({
      dir: pluginsPath,
      include_mime: '0',
      include_hash: '0',
      include_permissions: '0'
    }).toString(), {
      headers,
      timeout: 30000,
      httpsAgent
    });
    
    const files = listResponse.data?.data || [];
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const file of files) {
      if (file.file && file.file.endsWith('.zip')) {
        const zipPath = `${pluginsPath}/${file.file}`;
        console.log(`   🗑️ Removendo: ${file.file}`);
        
        const deleted = await deletePluginZip(baseUrl, cpSecurityToken, sessionData, zipPath, httpsAgent, username);
        if (deleted) {
          deletedCount++;
        } else {
          failedCount++;
          console.log(`   ⚠️ Não foi possível remover: ${file.file}`);
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`   ✅ ${deletedCount} arquivo(s) ZIP removido(s)`);
    }
    if (failedCount > 0) {
      console.log(`   ⚠️ ${failedCount} arquivo(s) ZIP não puderam ser removidos`);
    }
    if (deletedCount === 0 && failedCount === 0) {
      console.log(`   ℹ️ Nenhum arquivo ZIP encontrado`);
    }
    
  } catch (e) {
    console.log(`   ⚠️ Erro ao listar arquivos: ${e.message}`);
  }
}

async function deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, filePath, httpsAgent, username) {
  const fileName = filePath.split('/').pop();
  const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
  
  console.log(`   🗑️ Tentando deletar: ${fileName}`);
  
  // Método 1: UAPI Fileman/delete_files
  try {
    const deleteUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/delete_files`;
    const response = await axios.post(deleteUrl, new URLSearchParams({ 
      dir: dirPath,
      'files-0': fileName
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `cpsession=${sessionData.session}`
      },
      timeout: 15000,
      httpsAgent
    });
    
    if (response.data?.status === 1 || response.data?.data) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 2: API2 Fileman fileop delete
  try {
    const api2Url = `${baseUrl}${cpSecurityToken}/json-api/cpanel`;
    const response = await axios.post(api2Url, new URLSearchParams({
      'cpanel_jsonapi_user': username,
      'cpanel_jsonapi_apiversion': '2',
      'cpanel_jsonapi_module': 'Fileman',
      'cpanel_jsonapi_func': 'fileop',
      'op': 'unlink',
      'sourcefiles': filePath,
      'doubledecode': '0'
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `cpsession=${sessionData.session}`
      },
      timeout: 15000,
      httpsAgent
    });
    
    if (response.data?.cpanelresult?.data?.[0]?.result === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 3: WHM API direto
  try {
    const whmUrl = `${config.WHM_URL}/json-api/cpanel`;
    const response = await axios.post(whmUrl, new URLSearchParams({
      'cpanel_jsonapi_user': username,
      'cpanel_jsonapi_apiversion': '2',
      'cpanel_jsonapi_module': 'Fileman',
      'cpanel_jsonapi_func': 'fileop',
      'op': 'unlink',
      'sourcefiles': filePath
    }).toString(), {
      headers: {
        'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000,
      httpsAgent
    });
    
    if (response.data?.cpanelresult?.data?.[0]?.result === 1 ||
        response.data?.cpanelresult?.event?.result === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  // Método 4: Fileman/trash
  try {
    const trashUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/trash`;
    const response = await axios.post(trashUrl, new URLSearchParams({ 
      path: filePath 
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `cpsession=${sessionData.session}`
      },
      timeout: 15000,
      httpsAgent
    });
    
    if (response.data?.status === 1) {
      return true;
    }
  } catch (e) { /* continua */ }
  
  return false;
}

async function cleanupOldActivationFiles(baseUrl, cpSecurityToken, sessionData, httpsAgent, publicHtmlPath, muPluginsPath, username) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': `cpsession=${sessionData.session}`
  };
  
  // Limpar public_html
  try {
    const listUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/list_files`;
    const listResponse = await axios.post(listUrl, new URLSearchParams({
      dir: publicHtmlPath,
      include_mime: '0',
      include_hash: '0',
      include_permissions: '0'
    }).toString(), {
      headers,
      timeout: 15000,
      httpsAgent
    });
    
    const files = listResponse.data?.data || [];
    
    for (const file of files) {
      if (file.file && file.file.startsWith('dh-activate-') && file.file.endsWith('.php')) {
        console.log(`   🗑️ Removendo arquivo antigo: ${file.file}`);
        await deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, 
          `${publicHtmlPath}/${file.file}`, httpsAgent, username);
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Erro ao listar public_html: ${e.message}`);
  }
  
  // Limpar mu-plugins
  try {
    const listUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/list_files`;
    const listResponse = await axios.post(listUrl, new URLSearchParams({
      dir: muPluginsPath,
      include_mime: '0',
      include_hash: '0',
      include_permissions: '0'
    }).toString(), {
      headers,
      timeout: 15000,
      httpsAgent
    });
    
    const files = listResponse.data?.data || [];
    
    for (const file of files) {
      if (file.file && file.file.startsWith('activate-plugins-') && file.file.endsWith('.php')) {
        console.log(`   🗑️ Removendo mu-plugin antigo: ${file.file}`);
        await deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, 
          `${muPluginsPath}/${file.file}`, httpsAgent, username);
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Erro ao listar mu-plugins: ${e.message}`);
  }
}

// ========== INSTALAR PLUGINS VIA FILE MANAGER ==========

async function installPluginsViaFileManager(domain, plugins, username) {
  console.log('\n📁 Instalando plugins via cPanel File Manager...');
  console.log('   Username:', username);
  
  const results = [];
  
  try {
    console.log('🔑 Criando sessão no cPanel...');
    const sessionResponse = await axios.get(
      `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
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
    const pluginsPath = `/home/${username}/public_html/wp-content/plugins`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `cpsession=${sessionData.session}`
    };
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    
    const installedPlugins = [];
    
    for (const plugin of plugins) {
      console.log(`\n📦 Instalando ${plugin.name}...`);
      
      try {
        const zipPath = `${pluginsPath}/${plugin.name}.zip`;
        const trashUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/trash`;
        
        console.log(`   🗑️ Limpando arquivos antigos...`);
        try {
          await axios.post(trashUrl, new URLSearchParams({ path: zipPath }).toString(), {
            headers, timeout: 15000, httpsAgent
          });
        } catch (e) { /* ignora */ }
        
        try {
          await axios.post(trashUrl, new URLSearchParams({ path: `${pluginsPath}/${plugin.name}` }).toString(), {
            headers, timeout: 15000, httpsAgent
          });
        } catch (e) { /* ignora */ }
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log(`   ⬇️ Baixando do GitHub...`);
        const zipResponse = await axios.get(plugin.downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 300000,
          headers: { 'User-Agent': 'DomainHub-Backend' }
        });
        
        const sizeMB = (zipResponse.data.length / 1024 / 1024).toFixed(2);
        console.log(`   📦 Tamanho: ${sizeMB} MB`);
        
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
        
        console.log(`   📂 Extraindo arquivos...`);
        
        let extractSuccess = false;
        
        // Método 1: API2 Fileman
        try {
          const shellUrl = `${baseUrl}${cpSecurityToken}/json-api/cpanel`;
          const shellParams = new URLSearchParams({
            'cpanel_jsonapi_user': username,
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
        
        // Método 2: WHM API
        if (!extractSuccess) {
          try {
            const whmExtractUrl = `${config.WHM_URL}/json-api/cpanel`;
            const whmParams = new URLSearchParams({
              'cpanel_jsonapi_user': username,
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
        
        console.log(`   🗑️ Removendo arquivo ZIP...`);
        const zipDeleted = await deletePluginZip(baseUrl, cpSecurityToken, sessionData, zipPath, httpsAgent, username);
        if (zipDeleted) {
          console.log(`   ✅ ZIP removido`);
        } else {
          console.log(`   ⚠️ ZIP não foi removido (será limpo depois)`);
        }
        
        console.log(`   ✅ ${plugin.name} INSTALADO COM SUCESSO!`);
        results.push({ plugin: plugin.name, success: true });
        installedPlugins.push(plugin.name);
        
      } catch (err) {
        console.log(`   ❌ FALHA ${plugin.name}: ${err.message}`);
        results.push({ plugin: plugin.name, success: false, error: err.message });
      }
      
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
    
    // Limpeza final
    console.log('\n🧹 Limpando arquivos ZIP restantes...');
    await cleanupPluginZips(baseUrl, cpSecurityToken, sessionData, pluginsPath, httpsAgent, username);
    
    // Ativar plugins
    if (installedPlugins.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🔧 [ETAPA 4] ATIVANDO E CONFIGURANDO PLUGINS');
      console.log('='.repeat(70));
      
      const activationResults = await activatePluginsViaDirectPHP(
        domain, 
        installedPlugins, 
        sessionData, 
        cpSecurityToken,
        username
      );
      
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

// ========== ATIVAR PLUGINS VIA SCRIPT PHP DIRETO ==========

async function activatePluginsViaDirectPHP(domain, pluginNames, sessionData, cpSecurityToken, username) {
  console.log('\n🔌 Ativando plugins via Script PHP Direto...');
  console.log('   Username:', username);
  
  const results = {
    activated: [],
    autoUpdateEnabled: [],
    autoUpdateCount: 0,
    autoUpdateSaved: false,
    updated: [],
    errors: []
  };
  
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
  const publicHtmlPath = `/home/${username}/public_html`;
  const muPluginsPath = `/home/${username}/public_html/wp-content/mu-plugins`;
  
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 16);
  const phpFileName = `dh-activate-${uniqueId}.php`;
  const phpFilePath = `${publicHtmlPath}/${phpFileName}`;
  
  try {
    // Limpar arquivos antigos
    console.log('   0️⃣ Limpando arquivos antigos...');
    await cleanupOldActivationFiles(baseUrl, cpSecurityToken, sessionData, httpsAgent, publicHtmlPath, muPluginsPath, username);
    
    // Gerar código PHP
    console.log('   1️⃣ Gerando script PHP...');
    
    const pluginsArrayPhp = JSON.stringify(pluginNames);
    
    const phpCode = `<?php
/**
 * Script temporário para ativação de plugins WordPress
 * ID: ${uniqueId}
 * Gerado em: ${new Date().toISOString()}
 */

header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

define('DOING_AJAX', true);
define('WP_ADMIN', true);

error_reporting(E_ALL);
ini_set('display_errors', 0);

\$wp_load_path = __DIR__ . '/wp-load.php';

if (!file_exists(\$wp_load_path)) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'wp-load.php não encontrado']);
    exit;
}

try {
    require_once(\$wp_load_path);
} catch (Exception \$e) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Erro ao carregar WordPress: ' . \$e->getMessage()]);
    exit;
}

require_once(ABSPATH . 'wp-admin/includes/plugin.php');
require_once(ABSPATH . 'wp-admin/includes/file.php');
require_once(ABSPATH . 'wp-admin/includes/update.php');

while (ob_get_level()) {
    ob_end_clean();
}

header('Content-Type: application/json; charset=utf-8');

\$results = [
    'success' => true,
    'script_id' => '${uniqueId}',
    'activated' => [],
    'already_active' => [],
    'auto_update_enabled' => [],
    'auto_update_count' => 0,
    'auto_update_total_plugins' => 0,
    'auto_update_saved' => false,
    'update_check' => false,
    'errors' => [],
    'file_deleted' => false
];

\$plugins_to_activate = ${pluginsArrayPhp};
\$all_plugins = get_plugins();

// Mapeamento slug -> arquivo principal
\$plugin_map = [
    'duplicate-post' => 'duplicate-post/duplicate-post.php',
    'elementor' => 'elementor/elementor.php',
    'elementor-pro' => 'elementor-pro/elementor-pro.php',
    'google-site-kit' => 'google-site-kit/google-site-kit.php',
    'insert-headers-and-footers' => 'insert-headers-and-footers/ihaf.php',
    'litespeed-cache' => 'litespeed-cache/litespeed-cache.php',
    'rename-wp-admin-login' => 'developer-flavor-rename-wp-admin-login/developer-flavor-rename-wp-admin-login.php',
    'wordfence' => 'wordfence/wordfence.php',
    'wordpress-seo' => 'wordpress-seo/wp-seo.php',
    'wordpress-seo-premium' => 'wordpress-seo-premium/wp-seo-premium.php'
];

\$results['debug_plugins'] = array_keys(\$all_plugins);

// PASSO 1: Ativar plugins
foreach (\$plugins_to_activate as \$plugin_name) {
    \$found = false;
    \$target_file = null;
    
    // 1. Tentar mapeamento direto
    if (isset(\$plugin_map[\$plugin_name]) && isset(\$all_plugins[\$plugin_map[\$plugin_name]])) {
        \$target_file = \$plugin_map[\$plugin_name];
        \$found = true;
    }
    
    // 2. Busca flexível
    if (!\$found) {
        foreach (\$all_plugins as \$file => \$data) {
            \$folder = explode('/', \$file)[0];
            if (\$folder === \$plugin_name || strpos(\$file, \$plugin_name . '/') === 0) {
                \$target_file = \$file;
                \$found = true;
                break;
            }
        }
    }
    
    // 3. Ativar
    if (\$found && \$target_file) {
        if (is_plugin_active(\$target_file)) {
            \$results['already_active'][] = \$plugin_name;
        } else {
            \$result = activate_plugin(\$target_file, '', false, true);
            if (is_wp_error(\$result)) {
                \$results['errors'][] = [
                    'plugin' => \$plugin_name,
                    'file' => \$target_file,
                    'error' => \$result->get_error_message()
                ];
            } else {
                \$results['activated'][] = \$plugin_name;
            }
        }
    } else {
        \$results['errors'][] = [
            'plugin' => \$plugin_name,
            'error' => 'Plugin nao encontrado'
        ];
    }
}

// PASSO 2: Verificação de atualizações
try {
    wp_clean_plugins_cache(true);
    delete_site_transient('update_plugins');
    wp_update_plugins();
    \$results['update_check'] = true;
} catch (Exception \$e) {
    \$results['errors'][] = [
        'plugin' => 'system',
        'action' => 'update_check',
        'error' => \$e->getMessage()
    ];
}

// PASSO 3: Ativar auto-update
\$auto_updates = [];
\$all_plugins = get_plugins();

foreach (\$all_plugins as \$plugin_file => \$plugin_data) {
    \$auto_updates[] = \$plugin_file;
    \$plugin_folder = explode('/', \$plugin_file)[0];
    \$results['auto_update_enabled'][] = \$plugin_folder;
}

\$auto_updates = array_unique(\$auto_updates);

update_site_option('auto_update_plugins', \$auto_updates);
update_option('auto_update_plugins', \$auto_updates);

\$saved_auto_updates = get_option('auto_update_plugins', []);
if (empty(\$saved_auto_updates)) {
    \$saved_auto_updates = get_site_option('auto_update_plugins', []);
}
\$results['auto_update_count'] = count(\$saved_auto_updates);
\$results['auto_update_total_plugins'] = count(\$all_plugins);
\$results['auto_update_saved'] = (count(\$saved_auto_updates) === count(\$all_plugins));

// PASSO 4: Limpar ZIPs
\$plugins_dir = WP_CONTENT_DIR . '/plugins';
\$zip_files_deleted = [];

if (is_dir(\$plugins_dir)) {
    \$files = scandir(\$plugins_dir);
    foreach (\$files as \$file) {
        if (pathinfo(\$file, PATHINFO_EXTENSION) === 'zip') {
            \$zip_path = \$plugins_dir . '/' . \$file;
            if (@unlink(\$zip_path)) {
                \$zip_files_deleted[] = \$file;
            } else {
                @chmod(\$zip_path, 0777);
                @unlink(\$zip_path);
            }
        }
    }
}

\$results['zip_files_deleted'] = \$zip_files_deleted;
\$results['zip_cleanup_count'] = count(\$zip_files_deleted);

// PASSO 5: Auto-deletar
\$this_file = __FILE__;
\$delete_success = @unlink(\$this_file);

if (!\$delete_success && file_exists(\$this_file)) {
    @chmod(\$this_file, 0777);
    \$delete_success = @unlink(\$this_file);
}

\$results['file_deleted'] = !file_exists(\$this_file);
\$results['success'] = (count(\$results['activated']) > 0 || count(\$results['already_active']) > 0);

echo json_encode(\$results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
exit;
`;

    // Upload do script
    console.log('   2️⃣ Fazendo upload do script...');
    
    const uploadUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`;
    
    const form = new FormData();
    form.append('dir', publicHtmlPath);
    form.append('overwrite', '1');
    form.append('file-0', Buffer.from(phpCode, 'utf8'), {
      filename: phpFileName,
      contentType: 'application/x-php'
    });
    
    const uploadResponse = await axios.post(uploadUrl, form, {
      headers: {
        ...form.getHeaders(),
        'Cookie': `cpsession=${sessionData.session}`
      },
      timeout: 30000,
      httpsAgent
    });
    
    if (uploadResponse.data?.data?.succeeded !== 1) {
      const reason = uploadResponse.data?.data?.uploads?.[0]?.reason || 'Erro desconhecido';
      throw new Error(`Upload falhou: ${reason}`);
    }
    
    console.log(`   ✅ Script enviado: ${phpFileName}`);
    
    // Aguardar
    console.log('   3️⃣ Aguardando arquivo...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Executar
    console.log('   4️⃣ Executando script...');
    
    const scriptUrl = `https://${domain}/${phpFileName}`;
    console.log(`   📍 URL: ${scriptUrl}`);
    
    let phpResponse;
    try {
      phpResponse = await axios.get(scriptUrl, {
        timeout: 120000,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 DomainHub-Backend/1.0',
          'Accept': 'application/json'
        },
        validateStatus: () => true
      });
    } catch (reqError) {
      throw new Error(`Erro na requisição: ${reqError.message}`);
    }
    
    console.log(`   📊 Status HTTP: ${phpResponse.status}`);
    
    // Processar resposta
    console.log('   5️⃣ Processando resposta...');
    
    let phpResults;
    const responseData = phpResponse.data;
    
    try {
      if (typeof responseData === 'string') {
        let cleanData = responseData.trim();
        
        if (cleanData.startsWith('<!') || cleanData.startsWith('<html') || cleanData.startsWith('<br')) {
          const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            phpResults = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('Resposta contém HTML sem JSON');
          }
        } else {
          phpResults = JSON.parse(cleanData);
        }
      } else if (typeof responseData === 'object') {
        phpResults = responseData;
      } else {
        throw new Error(`Tipo de resposta inesperado: ${typeof responseData}`);
      }
    } catch (parseError) {
      console.log('   ⚠️ Erro ao parsear resposta');
      await deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, phpFilePath, httpsAgent, username);
      throw new Error(`Resposta inválida: ${parseError.message}`);
    }
    
    // Processar resultados
    results.activated = [...(phpResults.activated || []), ...(phpResults.already_active || [])];
    results.autoUpdateEnabled = phpResults.auto_update_enabled || [];
    results.autoUpdateCount = phpResults.auto_update_count || 0;
    results.autoUpdateSaved = phpResults.auto_update_saved || false;
    results.updated = phpResults.update_check ? ['update_check_ok'] : [];
    results.errors = phpResults.errors || [];
    
    // Log
    console.log(`\n   📊 RESULTADOS:`);
    console.log(`   ✅ Plugins ativados: ${phpResults.activated?.length || 0}`);
    console.log(`   ℹ️ Já estavam ativos: ${phpResults.already_active?.length || 0}`);
    console.log(`   📥 Verificação de updates: ${phpResults.update_check ? 'OK ✓' : 'Falhou ✗'}`);
    console.log(`   🔄 Auto-update habilitado: ${phpResults.auto_update_count || 0} plugins`);
    console.log(`   💾 Auto-update salvo: ${phpResults.auto_update_saved ? 'SIM ✓' : 'NÃO ✗'}`);
    console.log(`   🗑️ Script auto-deletado: ${phpResults.file_deleted ? 'SIM ✓' : 'NÃO ✗'}`);
    
    // Cleanup se não auto-deletou
    if (!phpResults.file_deleted) {
      console.log('\n   ⚠️ Arquivo não foi auto-deletado, removendo via cPanel...');
      const deleted = await deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, phpFilePath, httpsAgent, username);
      if (deleted) {
        console.log('   ✅ Arquivo removido via cPanel');
      } else {
        console.log('   ❌ FALHA ao remover arquivo via cPanel');
        results.errors.push({
          plugin: 'system',
          action: 'cleanup',
          error: `Arquivo ${phpFileName} não foi removido`
        });
      }
    }
    
    if (results.errors.length > 0) {
      console.log('\n   ⚠️ Erros:');
      results.errors.forEach(err => {
        console.log(`      - ${err.plugin}: ${err.error}`);
      });
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 RESUMO FINAL:');
    console.log(`   ✅ Plugins ativados: ${results.activated.length}`);
    console.log(`   🔄 Auto-update: ${results.autoUpdateCount} plugins configurados`);
    console.log(`   📥 Updates verificados: ${results.updated.length > 0 ? 'SIM' : 'NÃO'}`);
    console.log(`   ❌ Erros: ${results.errors.length}`);
    console.log('='.repeat(50));
    
    return results;
    
  } catch (error) {
    console.error(`   ❌ Erro: ${error.message}`);
    
    try {
      await deleteFileViaCpanel(baseUrl, cpSecurityToken, sessionData, phpFilePath, httpsAgent, username);
    } catch (e) { /* ignora */ }
    
    results.errors.push({ plugin: 'system', action: 'general', error: error.message });
    return results;
  }
}

// ========== FUNÇÃO PRINCIPAL - EXPORTADA ==========

async function setupWordPress(domain, sessionId = null) {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 [WORDPRESS] INICIANDO SETUP COMPLETO');
  console.log('   Domínio:', domain);
  console.log('   SessionId:', sessionId || 'N/A');
  console.log('='.repeat(70));
  
  const result = {
    domain: domain,
    etapa1_whm: null,
    etapa2_wordpress: null,
    etapa3_plugins: null,
    success: false,
    username: null
  };
  
  // ETAPA 1: Criar conta WHM
  await updateProgress(sessionId, 'wordpress_whm', 'in_progress', 
    `Criando conta no servidor para ${domain}...`, domain);
  
  result.etapa1_whm = await createWHMAccount(domain);
  
  if (!result.etapa1_whm.success) {
    console.log('\n❌ PROCESSO INTERROMPIDO - Falha na Etapa 1 (WHM)');
    await updateProgress(sessionId, 'wordpress_whm', 'error', 
      `Erro ao criar conta: ${result.etapa1_whm.error || 'Erro desconhecido'}`, domain);
    return result;
  }
  
  // Guardar o username gerado
  const username = result.etapa1_whm.username;
  result.username = username;
  
  await updateProgress(sessionId, 'wordpress_whm', 'completed', 
    `Conta ${username} criada com sucesso!`, domain);
  
  console.log('\n⏳ Aguardando 10 segundos para propagação da conta...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  // ETAPA 2: Instalar WordPress
  await updateProgress(sessionId, 'wordpress_install', 'in_progress', 
    `Instalando WordPress em ${domain}...`, domain);
  
  result.etapa2_wordpress = await installWordPress(domain, username);
  
  if (!result.etapa2_wordpress.success) {
    console.log('\n❌ PROCESSO INTERROMPIDO - Falha na Etapa 2 (WordPress)');
    await updateProgress(sessionId, 'wordpress_install', 'error', 
      `Erro ao instalar WordPress: ${result.etapa2_wordpress.error || 'Erro desconhecido'}`, domain);
    return result;
  }
  
  await updateProgress(sessionId, 'wordpress_install', 'completed', 
    `WordPress instalado com sucesso!`, domain);
  
  console.log('\n⏳ Aguardando 5 segundos para WordPress inicializar...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // ETAPA 3: Instalar plugins
  await updateProgress(sessionId, 'wordpress_plugins', 'in_progress', 
    `Instalando plugins em ${domain}...`, domain);
  
  result.etapa3_plugins = await installPlugins(domain, username);
  
  if (result.etapa3_plugins?.success) {
    await updateProgress(sessionId, 'wordpress_plugins', 'completed', 
      `${result.etapa3_plugins.installed || 0} plugins instalados!`, domain);
  } else {
    await updateProgress(sessionId, 'wordpress_plugins', 'error', 
      `Erro ao instalar plugins`, domain);
  }
  
  // ETAPA 4: Ativação e auto-update (já acontece dentro de installPlugins)
  if (result.etapa3_plugins?.activation) {
    await updateProgress(sessionId, 'wordpress_activate', 'in_progress', 
      `Ativando plugins e configurando atualizações...`, domain);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await updateProgress(sessionId, 'wordpress_activate', 'completed', 
      `Plugins ativados! Auto-update: ${result.etapa3_plugins.activation.autoUpdateCount || 0} plugins`, domain);
  }
  
  result.success = result.etapa1_whm.success && result.etapa2_wordpress.success;
  
  console.log('\n' + '='.repeat(70));
  console.log(result.success ? '🎉 [WORDPRESS] SETUP COMPLETO COM SUCESSO!' : '⚠️ [WORDPRESS] SETUP FINALIZADO COM ERROS');
  console.log('='.repeat(70));
  
  return result;
}

// ========== ROTA ÚNICA ==========

router.post('/setup', async (req, res) => {
  const { domain, sessionId } = req.body;
  
  if (!domain) {
    return res.status(400).json({ 
      error: 'Domínio não informado',
      uso: 'POST /api/wordpress/setup com body: { "domain": "exemplo.com", "sessionId": "opcional" }'
    });
  }
  
  try {
    const result = await setupWordPress(domain, sessionId);
    res.json(result);
  } catch (error) {
    console.error('❌ ERRO FATAL:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Exportar função e router
module.exports = router;
module.exports.setupWordPress = setupWordPress;