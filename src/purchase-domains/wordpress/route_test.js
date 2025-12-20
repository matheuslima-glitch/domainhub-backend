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
    // Buscar lista de plugins do GitHub
    console.log('📋 Buscando lista de plugins do GitHub...');
    const githubApiUrl = 'https://api.github.com/repos/matheuslima-glitch/wordpress-plugins/contents/';
    
    const githubResponse = await axios.get(githubApiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      timeout: 30000
    });
    
    const plugins = githubResponse.data
      .filter(file => file.name.endsWith('.zip'))
      .map(file => ({
        name: file.name.replace('.zip', ''),
        downloadUrl: file.download_url
      }));
    
    console.log(`✅ Encontrados ${plugins.length} plugins: ${plugins.map(p => p.name).join(', ')}`);
    
    if (plugins.length === 0) {
      return { success: false, error: 'Nenhum plugin encontrado no repositório' };
    }
    
    // Obter credenciais WordPress
    const wpUser = config.WORDPRESS_DEFAULT_USER;
    const wpPass = await getPasswordFromPassbolt();
    const wpUrl = `https://${domain}/wp-json/wp/v2`;
    
    // Criar header de autenticação
    const authHeader = 'Basic ' + Buffer.from(`${wpUser}:${wpPass}`).toString('base64');
    
    // Testar conexão com WordPress
    console.log('🔗 Testando conexão com WordPress REST API...');
    try {
      await axios.get(`${wpUrl}/users/me`, {
        headers: { 'Authorization': authHeader },
        timeout: 30000
      });
      console.log('✅ Conexão OK');
    } catch (err) {
      console.log('⚠️ REST API não disponível, tentando via cPanel File Manager...');
      return await installPluginsViaFileManager(domain, plugins);
    }
    
    // Instalar cada plugin via WordPress
    for (const plugin of plugins) {
      console.log(`\n📦 Instalando ${plugin.name}...`);
      
      try {
        // Baixar o ZIP
        const zipResponse = await axios.get(plugin.downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 120000
        });
        
        // Enviar para WordPress

        const form = new FormData();
        form.append('file', Buffer.from(zipResponse.data), {
          filename: `${plugin.name}.zip`,
          contentType: 'application/zip'
        });
        
        const installResponse = await axios.post(
          `https://${domain}/wp-admin/plugin-install.php?tab=upload`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': authHeader
            },
            timeout: 120000
          }
        );
        
        if (installResponse.status === 200) {
          console.log(`   ✅ ${plugin.name} instalado`);
          results.push({ plugin: plugin.name, success: true });
        } else {
          console.log(`   ⚠️ ${plugin.name}: Status ${installResponse.status}`);
          results.push({ plugin: plugin.name, success: false, error: `Status ${installResponse.status}` });
        }
        
      } catch (err) {
        console.log(`   ❌ ${plugin.name}: ${err.message}`);
        results.push({ plugin: plugin.name, success: false, error: err.message });
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\n📊 Resultado: ${successCount}/${plugins.length} plugins instalados`);
    
    return { 
      success: successCount > 0, 
      total: plugins.length,
      installed: successCount,
      results 
    };
    
  } catch (error) {
    console.error('❌ [ETAPA 3] ERRO:', error.message);
    return { success: false, error: error.message };
  }
}

// Instalar plugins via File Manager do cPanel (fallback)
async function installPluginsViaFileManager(domain, plugins) {
  console.log('\n📁 Instalando plugins via cPanel File Manager...');
  
  const results = [];
  
  try {
    // Criar sessão no cPanel
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
    
    const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
    
    for (const plugin of plugins) {
      console.log(`\n📦 Instalando ${plugin.name}...`);
      
      try {
        // Baixar o ZIP do GitHub
        console.log(`   ⬇️ Baixando de ${plugin.downloadUrl}...`);
        const zipResponse = await axios.get(plugin.downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 120000
        });
        
        // Upload para pasta temporária via cPanel
        const uploadUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`;
        
        const form = new FormData();
        form.append('dir', '/home/' + config.WHM_ACCOUNT_USERNAME + '/public_html/wp-content/plugins');
        form.append('file-0', Buffer.from(zipResponse.data), {
          filename: `${plugin.name}.zip`,
          contentType: 'application/zip'
        });
        
        const uploadResponse = await axios.post(uploadUrl, form, {
          headers: {
            ...form.getHeaders(),
            'Cookie': `cpsession=${sessionData.session}`
          },
          timeout: 120000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        
        console.log(`   📤 Upload response:`, JSON.stringify(uploadResponse.data).substring(0, 200));
        
        // Extrair o ZIP
        const extractUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/extract_archive`;
        
        const extractResponse = await axios.post(extractUrl, 
          new URLSearchParams({
            path: `/home/${config.WHM_ACCOUNT_USERNAME}/public_html/wp-content/plugins/${plugin.name}.zip`,
            extract_to: `/home/${config.WHM_ACCOUNT_USERNAME}/public_html/wp-content/plugins`
          }).toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': `cpsession=${sessionData.session}`
            },
            timeout: 60000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
          }
        );
        
        console.log(`   📂 Extract response:`, JSON.stringify(extractResponse.data).substring(0, 200));
        
        // Deletar o ZIP após extrair
        const deleteUrl = `${baseUrl}${cpSecurityToken}/execute/Fileman/delete_files`;
        await axios.post(deleteUrl,
          new URLSearchParams({
            files: `/home/${config.WHM_ACCOUNT_USERNAME}/public_html/wp-content/plugins/${plugin.name}.zip`
          }).toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': `cpsession=${sessionData.session}`
            },
            timeout: 30000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
          }
        );
        
        console.log(`   ✅ ${plugin.name} instalado`);
        results.push({ plugin: plugin.name, success: true });
        
      } catch (err) {
        console.log(`   ❌ ${plugin.name}: ${err.message}`);
        results.push({ plugin: plugin.name, success: false, error: err.message });
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\n📊 Resultado: ${successCount}/${plugins.length} plugins instalados`);
    
    return { 
      success: successCount > 0, 
      total: plugins.length,
      installed: successCount,
      results 
    };
    
  } catch (error) {
    console.error('❌ Erro no File Manager:', error.message);
    return { success: false, error: error.message };
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