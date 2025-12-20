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

// ========== ETAPA 3: INSTALAR PLUGINS ==========

async function installPlugins(domain) {
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
        
        if (!extractSuccess) {
          try {
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
    
    // ETAPA 4: Ativar plugins via MU-Plugin
    if (installedPlugins.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🔧 [ETAPA 4] ATIVANDO E CONFIGURANDO PLUGINS');
      console.log('='.repeat(70));
      
      const activationResults = await activatePluginsViaMuPlugin(
        domain, 
        installedPlugins, 
        sessionData, 
        cpSecurityToken
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

// ========== ATIVAR PLUGINS VIA MU-PLUGIN ==========

/**
 * Ativa plugins via MU-Plugin (Must-Use Plugin)
 * 
 * COMO FUNCIONA:
 * 1. Cria pasta mu-plugins se não existir
 * 2. Upload de arquivo PHP que será executado automaticamente
 * 3. Faz requisição HTTP ao site (dispara execução do mu-plugin)
 * 4. O mu-plugin ativa plugins, força update, ativa auto-update
 * 5. O mu-plugin se AUTO-DELETA imediatamente após conclusão
 * 
 * POR QUE FUNCIONA:
 * - MU-plugins são carregados ANTES de qualquer outro código
 * - Não passam por wp-login.php (sem captcha)
 * - São executados em QUALQUER requisição ao WordPress
 */
async function activatePluginsViaMuPlugin(domain, pluginNames, sessionData, cpSecurityToken) {
  console.log('\n🔌 Ativando plugins via MU-Plugin...');
  
  const results = {
    activated: [],
    autoUpdateEnabled: [],
    updated: [],
    errors: []
  };
  
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
  const muPluginsPath = `/home/${config.WHM_ACCOUNT_USERNAME}/public_html/wp-content/mu-plugins`;
  
  // Gerar chave secreta única
  const secretKey = uuidv4().replace(/-/g, '');
  const muPluginFileName = `activate-plugins-${secretKey.substring(0, 8)}.php`;
  const muPluginFilePath = `${muPluginsPath}/${muPluginFileName}`;
  
  try {
    // PASSO 1: Criar pasta mu-plugins se não existir
    console.log('   1️⃣ Criando pasta mu-plugins...');
    
    const mkdirUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/mkdir`;
    try {
      await axios.post(mkdirUrl, new URLSearchParams({
        path: muPluginsPath,
        permissions: '0755'
      }).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `cpsession=${sessionData.session}`
        },
        timeout: 15000,
        httpsAgent
      });
      console.log('   ✅ Pasta mu-plugins criada/verificada');
    } catch (e) {
      // Pasta pode já existir, ignorar erro
      console.log('   ℹ️ Pasta mu-plugins já existe');
    }
    
    // PASSO 2: Criar o código PHP do MU-Plugin
    console.log('   2️⃣ Gerando MU-Plugin...');
    
    const pluginsArrayPhp = JSON.stringify(pluginNames);
    
    const muPluginCode = `<?php
/**
 * MU-Plugin temporário para ativação de plugins
 * Chave: ${secretKey}
 * ESTE ARQUIVO SE AUTO-DELETA APÓS EXECUÇÃO
 */

// Só executar se a chave secreta estiver presente na URL
if (!isset(\$_GET['activate_key']) || \$_GET['activate_key'] !== '${secretKey}') {
    return; // Não fazer nada se a chave não bater
}

// Evitar execução múltipla
if (defined('DOMAINHUB_ACTIVATING_PLUGINS')) {
    return;
}
define('DOMAINHUB_ACTIVATING_PLUGINS', true);

// Garantir que temos as funções necessárias
require_once(ABSPATH . 'wp-admin/includes/plugin.php');
require_once(ABSPATH . 'wp-admin/includes/file.php');
require_once(ABSPATH . 'wp-admin/includes/update.php');

// Desabilitar output buffering e enviar headers
while (ob_get_level()) {
    ob_end_clean();
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');

\$results = [
    'success' => true,
    'activated' => [],
    'already_active' => [],
    'auto_update_enabled' => [],
    'update_check' => false,
    'errors' => [],
    'self_deleted' => false
];

// Lista de plugins para ativar
\$plugins_to_activate = ${pluginsArrayPhp};

// Obter todos os plugins instalados
\$all_plugins = get_plugins();

// ========== PASSO 1: ATIVAR PLUGINS ==========
foreach (\$plugins_to_activate as \$plugin_name) {
    \$found = false;
    
    foreach (\$all_plugins as \$plugin_file => \$plugin_data) {
        // Verificar se o plugin corresponde ao nome
        \$plugin_folder = explode('/', \$plugin_file)[0];
        
        if (\$plugin_folder === \$plugin_name || 
            strpos(\$plugin_file, \$plugin_name . '/') === 0 ||
            strpos(\$plugin_file, \$plugin_name . '.php') !== false) {
            
            \$found = true;
            
            if (is_plugin_active(\$plugin_file)) {
                \$results['already_active'][] = \$plugin_name;
            } else {
                \$activation_result = activate_plugin(\$plugin_file);
                
                if (is_wp_error(\$activation_result)) {
                    \$results['errors'][] = [
                        'plugin' => \$plugin_name,
                        'action' => 'activate',
                        'error' => \$activation_result->get_error_message()
                    ];
                } else {
                    \$results['activated'][] = \$plugin_name;
                }
            }
            break;
        }
    }
    
    if (!\$found) {
        \$results['errors'][] = [
            'plugin' => \$plugin_name,
            'action' => 'find',
            'error' => 'Plugin não encontrado no diretório'
        ];
    }
}

// ========== PASSO 2: FORÇAR VERIFICAÇÃO DE ATUALIZAÇÕES ==========
try {
    // Limpar cache de plugins
    wp_clean_plugins_cache(true);
    
    // Deletar transient de updates para forçar nova verificação
    delete_site_transient('update_plugins');
    
    // Forçar verificação de atualizações
    wp_update_plugins();
    
    \$results['update_check'] = true;
} catch (Exception \$e) {
    \$results['errors'][] = [
        'plugin' => 'system',
        'action' => 'update_check',
        'error' => \$e->getMessage()
    ];
}

// ========== PASSO 3: ATIVAR AUTO-UPDATE PARA TODOS OS PLUGINS ==========
\$auto_updates = (array) get_site_option('auto_update_plugins', []);
\$plugins_updated = false;

// Recarregar lista de plugins (pode ter mudado após ativação)
\$all_plugins = get_plugins();

foreach (\$all_plugins as \$plugin_file => \$plugin_data) {
    \$plugin_folder = explode('/', \$plugin_file)[0];
    
    // Verificar se é um dos plugins que instalamos
    foreach (\$plugins_to_activate as \$plugin_name) {
        if (\$plugin_folder === \$plugin_name || 
            strpos(\$plugin_file, \$plugin_name . '/') === 0) {
            
            if (!in_array(\$plugin_file, \$auto_updates)) {
                \$auto_updates[] = \$plugin_file;
                \$results['auto_update_enabled'][] = \$plugin_name;
                \$plugins_updated = true;
            }
            break;
        }
    }
}

if (\$plugins_updated) {
    update_site_option('auto_update_plugins', \$auto_updates);
}

// ========== PASSO 4: AUTO-DELETAR ESTE ARQUIVO ==========
\$this_file = __FILE__;

// Tentar deletar imediatamente
if (file_exists(\$this_file)) {
    \$deleted = @unlink(\$this_file);
    \$results['self_deleted'] = \$deleted;
    
    if (!\$deleted) {
        // Se não conseguiu deletar, tentar com chmod primeiro
        @chmod(\$this_file, 0777);
        \$deleted = @unlink(\$this_file);
        \$results['self_deleted'] = \$deleted;
    }
}

// Verificar se realmente foi deletado
if (file_exists(\$this_file)) {
    \$results['self_deleted'] = false;
    \$results['errors'][] = [
        'plugin' => 'system',
        'action' => 'self_delete',
        'error' => 'Não foi possível auto-deletar o arquivo'
    ];
}

// Calcular sucesso total
\$results['success'] = count(\$results['errors']) === 0 || 
    (count(\$results['activated']) > 0 || count(\$results['already_active']) > 0);

// Retornar JSON e encerrar
echo json_encode(\$results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
exit;
`;

    // PASSO 3: Upload do MU-Plugin via cPanel
    console.log('   3️⃣ Fazendo upload do MU-Plugin...');
    
    const uploadUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`;
    
    const form = new FormData();
    form.append('dir', muPluginsPath);
    form.append('overwrite', '1');
    form.append('file-0', Buffer.from(muPluginCode, 'utf8'), {
      filename: muPluginFileName,
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
      throw new Error(`Upload do MU-Plugin falhou: ${reason}`);
    }
    
    console.log('   ✅ MU-Plugin enviado');
    
    // PASSO 4: Aguardar arquivo estar disponível
    console.log('   4️⃣ Aguardando arquivo estar disponível...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // PASSO 5: Executar o MU-Plugin via requisição HTTP
    console.log('   5️⃣ Executando MU-Plugin...');
    
    const activationUrl = `https://${domain}/?activate_key=${secretKey}`;
    
    let phpResponse;
    try {
      phpResponse = await axios.get(activationUrl, {
        timeout: 120000,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        validateStatus: () => true // Aceitar qualquer status
      });
    } catch (reqError) {
      throw new Error(`Falha ao executar MU-Plugin: ${reqError.message}`);
    }
    
    // PASSO 6: Processar resposta
    console.log('   6️⃣ Processando resposta...');
    
    let phpResults;
    try {
      if (typeof phpResponse.data === 'string') {
        // Tentar encontrar JSON na resposta (pode ter HTML misturado)
        const jsonMatch = phpResponse.data.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          phpResults = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('JSON não encontrado na resposta');
        }
      } else {
        phpResults = phpResponse.data;
      }
    } catch (parseError) {
      console.log('   ⚠️ Resposta não é JSON válido');
      console.log('   📄 Resposta recebida:', String(phpResponse.data).substring(0, 500));
      
      // Tentar deletar o arquivo manualmente se ainda existir
      await tryDeleteMuPlugin(baseUrl, cpSecurityToken, sessionData, muPluginFilePath, httpsAgent);
      
      throw new Error(`Resposta inválida do MU-Plugin: ${parseError.message}`);
    }
    
    // Processar resultados
    results.activated = [...(phpResults.activated || []), ...(phpResults.already_active || [])];
    results.autoUpdateEnabled = phpResults.auto_update_enabled || [];
    results.updated = phpResults.update_check ? ['update_check_completed'] : [];
    results.errors = phpResults.errors || [];
    
    // Log dos resultados
    console.log(`\n   ✅ Ativados: ${phpResults.activated?.length || 0}`);
    if (phpResults.already_active?.length > 0) {
      console.log(`   ℹ️ Já estavam ativos: ${phpResults.already_active.length}`);
    }
    console.log(`   ✅ Auto-update ativado: ${phpResults.auto_update_enabled?.length || 0}`);
    console.log(`   ✅ Verificação de updates: ${phpResults.update_check ? 'OK' : 'Falhou'}`);
    console.log(`   🗑️ Auto-deletado: ${phpResults.self_deleted ? 'SIM' : 'NÃO'}`);
    
    // Se não auto-deletou, tentar deletar manualmente
    if (!phpResults.self_deleted) {
      console.log('   ⚠️ Tentando deletar manualmente...');
      await tryDeleteMuPlugin(baseUrl, cpSecurityToken, sessionData, muPluginFilePath, httpsAgent);
    }
    
    // Log de erros se houver
    if (phpResults.errors?.length > 0) {
      console.log('\n   ⚠️ Erros encontrados:');
      phpResults.errors.forEach(err => {
        console.log(`      - ${err.plugin}: ${err.error}`);
      });
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 RESULTADO ATIVAÇÃO:');
    console.log(`   ✅ Ativados: ${results.activated.length}`);
    console.log(`   🔄 Auto-update: ${results.autoUpdateEnabled.length}`);
    console.log(`   ❌ Erros: ${results.errors.length}`);
    console.log('='.repeat(50));
    
    return results;
    
  } catch (error) {
    console.error(`   ❌ Erro: ${error.message}`);
    
    // Tentar deletar o arquivo em caso de erro
    try {
      await tryDeleteMuPlugin(baseUrl, cpSecurityToken, sessionData, muPluginFilePath, httpsAgent);
    } catch (e) { /* ignora */ }
    
    results.errors.push({ plugin: 'system', action: 'general', error: error.message });
    return results;
  }
}

// Função auxiliar para deletar MU-Plugin manualmente
async function tryDeleteMuPlugin(baseUrl, cpSecurityToken, sessionData, filePath, httpsAgent) {
  try {
    const trashUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/trash`;
    await axios.post(trashUrl, new URLSearchParams({ path: filePath }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `cpsession=${sessionData.session}`
      },
      timeout: 15000,
      httpsAgent
    });
    console.log('   🗑️ MU-Plugin deletado manualmente');
    return true;
  } catch (e) {
    console.log(`   ⚠️ Falha ao deletar manualmente: ${e.message}`);
    return false;
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

// ========== ROTAS ==========

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

router.post('/activate-only', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ error: 'Domínio não informado' });
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('🔧 [TESTE] ATIVAÇÃO DE PLUGINS');
  console.log('   Domínio:', domain);
  console.log('='.repeat(70));
  
  try {
    // Criar sessão no cPanel para a ativação
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
    
    const result = await activatePluginsViaMuPlugin(domain, pluginNames, sessionData, cpSecurityToken);
    res.json({ domain, ...result });
  } catch (error) {
    console.error('❌ ERRO:', error.message);
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