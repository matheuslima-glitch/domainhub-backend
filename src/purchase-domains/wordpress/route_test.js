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
        
        // PASSO 4: Extrair ZIP usando Terminal/Shell do cPanel
        console.log(`   📂 Extraindo arquivos...`);
        
        // Método 1: Tentar via UAPI Terminal
        let extractSuccess = false;
        
        // Tentar extrair via comando shell no cPanel
        const terminalUrl = `${baseUrl}${cpSecurityToken}/execute/SSH/start_session`;
        
        try {
          // Usar a API de execução de comandos do cPanel (se disponível)
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
        
        // Método 2: Tentar via API2 extract
        if (!extractSuccess) {
          try {
            const api2Url = `${baseUrl}${cpSecurityToken}/json-api/cpanel`;
            const api2Params = new URLSearchParams({
              'cpanel_jsonapi_user': config.WHM_ACCOUNT_USERNAME,
              'cpanel_jsonapi_apiversion': '2',
              'cpanel_jsonapi_module': 'Fileman',
              'cpanel_jsonapi_func': 'extract',
              'file': zipPath,
              'dir': pluginsPath
            });
            
            const api2Response = await axios.post(api2Url, api2Params.toString(), {
              headers, timeout: 120000, httpsAgent
            });
            
            const api2Data = api2Response.data;
            if (api2Data?.cpanelresult?.data?.[0]?.extract === 1 || 
                api2Data?.cpanelresult?.event?.result === 1 ||
                !api2Data?.cpanelresult?.error) {
              extractSuccess = true;
              console.log(`   ✅ Extração via API2 OK`);
            }
          } catch (e) {
            console.log(`   ⚠️ Método API2 falhou: ${e.message}`);
          }
        }
        
        // Método 3: Tentar via UAPI Fileman extract
        if (!extractSuccess) {
          try {
            const uapiUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/extract`;
            const uapiParams = new URLSearchParams({
              'path': zipPath,
              'dir': pluginsPath
            });
            
            const uapiResponse = await axios.post(uapiUrl, uapiParams.toString(), {
              headers, timeout: 120000, httpsAgent
            });
            
            if (uapiResponse.data?.status === 1 || uapiResponse.data?.data) {
              extractSuccess = true;
              console.log(`   ✅ Extração via UAPI OK`);
            }
          } catch (e) {
            console.log(`   ⚠️ Método UAPI falhou: ${e.message}`);
          }
        }
        
        // Método 4: Usar WHM API para executar comando no servidor
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
        
        // Método 5: Usar File Manager Web Interface (último recurso)
        if (!extractSuccess) {
          try {
            console.log(`   🔄 Tentando extração via File Manager Web...`);
            const fmUrl = `${baseUrl}${cpSecurityToken}/frontend/jupiter/filemanager/htextract.html`;
            const fmParams = new URLSearchParams({
              'file': `${plugin.name}.zip`,
              'dir': pluginsPath,
              'doubledecode': '0'
            });
            
            const fmResponse = await axios.post(fmUrl, fmParams.toString(), {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `cpsession=${sessionData.session}`,
                'Referer': `${baseUrl}${cpSecurityToken}/frontend/jupiter/filemanager/index.html`
              },
              timeout: 120000,
              httpsAgent
            });
            
            // Verificar se a pasta do plugin foi criada
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const checkUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/list_files`;
            const checkResponse = await axios.post(checkUrl, new URLSearchParams({
              'dir': pluginsPath,
              'include_mime': '0',
              'include_hash': '0',
              'include_permissions': '0'
            }).toString(), {
              headers, timeout: 30000, httpsAgent
            });
            
            const files = checkResponse.data?.data || [];
            const pluginFolder = files.find(f => f.file === plugin.name && f.type === 'dir');
            
            if (pluginFolder) {
              extractSuccess = true;
              console.log(`   ✅ Extração via FM Web OK`);
            }
          } catch (e) {
            console.log(`   ⚠️ Método FM Web falhou: ${e.message}`);
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
    
    // ETAPA 4: Ativar plugins, atualizar e configurar auto-update
    if (installedPlugins.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🔧 [ETAPA 4] ATIVANDO E CONFIGURANDO PLUGINS');
      console.log('='.repeat(70));
      
      const activationResults = await activateAndConfigurePlugins(domain, installedPlugins);
      
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

// ========== ATIVAR E CONFIGURAR PLUGINS ==========

async function activateAndConfigurePlugins(domain, pluginNames) {
  console.log('\n🔌 Ativando plugins via WordPress...');
  
  const results = {
    activated: [],
    updated: [],
    autoUpdateEnabled: [],
    errors: []
  };
  
  try {
    // Obter senha do WordPress do Passbolt
    const wpPassword = await getPasswordFromPassbolt();
    const wpUser = config.WORDPRESS_DEFAULT_USER;
    const wpUrl = `https://${domain}`;
    
    // Criar autenticação básica para API REST do WordPress
    const authHeader = 'Basic ' + Buffer.from(`${wpUser}:${wpPassword}`).toString('base64');
    const wpHeaders = {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    };
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    
    // Aguardar WordPress estar pronto
    console.log('⏳ Aguardando WordPress estar pronto...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Mapear nomes de plugins para slugs do WordPress
    const pluginSlugs = {
      'duplicate-post': 'duplicate-post/duplicate-post.php',
      'elementor': 'elementor/elementor.php',
      'elementor-pro': 'elementor-pro/elementor-pro.php',
      'google-site-kit': 'google-site-kit/google-site-kit.php',
      'insert-headers-and-footers': 'insert-headers-and-footers/ihaf.php',
      'litespeed-cache': 'litespeed-cache/litespeed-cache.php',
      'rename-wp-admin-login': 'rename-wp-admin-login/rename-wp-admin-login.php',
      'wordfence': 'wordfence/wordfence.php',
      'wordpress-seo': 'wordpress-seo/wp-seo.php',
      'wordpress-seo-premium': 'wordpress-seo-premium/wp-seo-premium.php'
    };
    
    // Primeiro, tentar obter lista de plugins instalados
    console.log('📋 Verificando plugins instalados...');
    
    try {
      const listResponse = await axios.get(`${wpUrl}/wp-json/wp/v2/plugins`, {
        headers: wpHeaders,
        timeout: 30000,
        httpsAgent
      });
      
      const installedPlugins = listResponse.data || [];
      console.log(`   ✅ ${installedPlugins.length} plugins encontrados na API`);
      
      for (const pluginName of pluginNames) {
        const pluginSlug = pluginSlugs[pluginName] || `${pluginName}/${pluginName}.php`;
        const encodedSlug = encodeURIComponent(pluginSlug);
        
        console.log(`\n   🔧 Processando ${pluginName}...`);
        
        // Verificar se plugin existe na lista
        const plugin = installedPlugins.find(p => 
          p.plugin === pluginSlug || 
          p.plugin.includes(pluginName) ||
          p.textdomain === pluginName
        );
        
        const actualSlug = plugin?.plugin || pluginSlug;
        const actualEncodedSlug = encodeURIComponent(actualSlug);
        
        // ATIVAR PLUGIN
        try {
          console.log(`      🔌 Ativando...`);
          const activateResponse = await axios.post(
            `${wpUrl}/wp-json/wp/v2/plugins/${actualEncodedSlug}`,
            { status: 'active' },
            { headers: wpHeaders, timeout: 30000, httpsAgent }
          );
          
          if (activateResponse.data?.status === 'active') {
            console.log(`      ✅ Ativado!`);
            results.activated.push(pluginName);
          }
        } catch (activateErr) {
          // Tentar método alternativo se a API REST não funcionar
          if (activateErr.response?.status === 404) {
            console.log(`      ⚠️ Plugin não encontrado na API, tentando slug alternativo...`);
            
            // Tentar com diferentes variações do slug
            const slugVariations = [
              `${pluginName}/${pluginName}.php`,
              `${pluginName}/plugin.php`,
              `${pluginName}/index.php`,
              `${pluginName}/${pluginName.replace(/-/g, '_')}.php`
            ];
            
            for (const altSlug of slugVariations) {
              try {
                const altResponse = await axios.post(
                  `${wpUrl}/wp-json/wp/v2/plugins/${encodeURIComponent(altSlug)}`,
                  { status: 'active' },
                  { headers: wpHeaders, timeout: 30000, httpsAgent }
                );
                
                if (altResponse.data?.status === 'active') {
                  console.log(`      ✅ Ativado com slug: ${altSlug}`);
                  results.activated.push(pluginName);
                  break;
                }
              } catch (e) { /* continua tentando */ }
            }
          } else {
            console.log(`      ⚠️ Erro ao ativar: ${activateErr.message}`);
            results.errors.push({ plugin: pluginName, action: 'activate', error: activateErr.message });
          }
        }
        
        // ATIVAR AUTO-UPDATE
        try {
          console.log(`      🔄 Ativando auto-update...`);
          const autoUpdateResponse = await axios.post(
            `${wpUrl}/wp-json/wp/v2/plugins/${actualEncodedSlug}`,
            { auto_update: true },
            { headers: wpHeaders, timeout: 30000, httpsAgent }
          );
          
          if (autoUpdateResponse.data) {
            console.log(`      ✅ Auto-update ativado!`);
            results.autoUpdateEnabled.push(pluginName);
          }
        } catch (autoErr) {
          console.log(`      ⚠️ Erro ao ativar auto-update: ${autoErr.message}`);
        }
        
        // Pequena pausa entre operações
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (apiError) {
      console.log(`   ⚠️ API REST não disponível: ${apiError.message}`);
      console.log('   🔄 Tentando ativação via WP-CLI simulado...');
      
      // Método alternativo: Modificar opção do banco de dados via arquivo
      // (Este é um fallback que pode não funcionar em todos os casos)
      results.errors.push({ 
        plugin: 'all', 
        action: 'api_access', 
        error: 'API REST não disponível, plugins precisam ser ativados manualmente' 
      });
    }
    
    // FORÇAR VERIFICAÇÃO DE ATUALIZAÇÕES
    console.log('\n   📥 Forçando verificação de atualizações...');
    try {
      // Limpar transients de update
      await axios.delete(`${wpUrl}/wp-json/wp/v2/settings`, {
        headers: wpHeaders,
        timeout: 30000,
        httpsAgent,
        data: { _transient_update_plugins: null }
      });
      
      // Tentar forçar update check via cron
      await axios.get(`${wpUrl}/wp-cron.php?doing_wp_cron`, {
        timeout: 30000,
        httpsAgent
      });
      
      console.log('   ✅ Verificação de atualizações disparada');
    } catch (updateErr) {
      console.log(`   ⚠️ Não foi possível forçar atualização: ${updateErr.message}`);
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