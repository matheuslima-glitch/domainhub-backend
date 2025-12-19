/**
 * ARQUIVO DE TESTE - WHM + PASSBOLT
 * Execute: node src/purchase-domains/wordpress/route_test.js
 */

const express = require('express');
const axios = require('axios');
const openpgp = require('openpgp');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

// Carregar configurações
const config = require('../../config/env');

const app = express();
app.use(express.json());

/**
 * AUTENTICAR NO PASSBOLT
 */
async function authenticatePassbolt() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔐 [PASSBOLT] AUTENTICANDO`);
  console.log(`${'='.repeat(70)}`);
  
  const baseUrl = (config.PASSBOLT_BASE_URL || '').replace(/\/$/, '');
  const userId = config.PASSBOLT_USER_ID;
  const passphrase = config.PASSBOLT_PASSPHRASE;
  const privateKeyArmored = (config.PASSBOLT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  
  // Validação de configuração
  if (!baseUrl || !userId || !passphrase || !privateKeyArmored) {
    console.error(`❌ [PASSBOLT] Configuração incompleta:`);
    console.error(`   BASE_URL: ${baseUrl ? 'OK' : 'FALTANDO'}`);
    console.error(`   USER_ID: ${userId ? 'OK' : 'FALTANDO'}`);
    console.error(`   PASSPHRASE: ${passphrase ? 'OK' : 'FALTANDO'}`);
    console.error(`   PRIVATE_KEY: ${privateKeyArmored ? 'OK' : 'FALTANDO'}`);
    throw new Error('Configuração do Passbolt incompleta');
  }
  
  console.log(`   URL: ${baseUrl}`);
  console.log(`   User ID: ${userId}`);
  
  // 1. Buscar chave do servidor
  console.log(`\n1️⃣ Buscando chave do servidor...`);
  const verifyRes = await axios.get(`${baseUrl}/auth/verify.json`, { timeout: 30000 });
  const serverKey = await openpgp.readKey({ armoredKey: verifyRes.data.body.keydata });
  console.log(`   ✅ OK`);
  
  // 2. Preparar chave do usuário
  console.log(`2️⃣ Descriptografando chave privada...`);
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  const userKey = await openpgp.decryptKey({ privateKey, passphrase });
  console.log(`   ✅ OK`);
  
  // 3. Criar e criptografar challenge
  console.log(`3️⃣ Criando challenge...`);
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
  console.log(`   ✅ OK`);
  
  // 4. Login
  console.log(`4️⃣ Enviando login...`);
  const loginRes = await axios.post(
    `${baseUrl}/auth/jwt/login.json`,
    { user_id: userId, challenge: encryptedChallenge },
    { timeout: 30000 }
  );
  console.log(`   ✅ OK - Status: ${loginRes.status}`);
  
  // 5. Validar resposta e extrair token
  console.log(`5️⃣ Validando resposta...`);
  const decryptedMsg = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: loginRes.data.body.challenge }),
    decryptionKeys: userKey
  });
  
  const decryptedData = JSON.parse(decryptedMsg.data);
  if (decryptedData.verify_token !== verifyToken) {
    throw new Error('Token de verificação inválido');
  }
  console.log(`   ✅ OK - Token JWT obtido`);
  
  return {
    token: decryptedData.access_token,
    cookies: loginRes.headers['set-cookie'],
    userKey: userKey,
    baseUrl: baseUrl
  };
}

/**
 * BUSCAR SENHA DO PASSBOLT
 */
async function getPasswordFromPassbolt() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔐 [PASSBOLT] BUSCANDO SENHA`);
  console.log(`${'='.repeat(70)}`);
  
  const resourceId = config.PASSBOLT_RESOURCE_ID;
  
  if (!resourceId) {
    throw new Error('PASSBOLT_RESOURCE_ID não configurado');
  }
  
  console.log(`   Resource ID: ${resourceId}`);
  
  // 1. Autenticar
  const authData = await authenticatePassbolt();
  
  // 2. Montar headers
  const headers = {
    'Authorization': `Bearer ${authData.token}`,
    'Content-Type': 'application/json'
  };
  if (authData.cookies) {
    headers['Cookie'] = authData.cookies.join('; ');
  }
  
  // 3. Buscar secret criptografado
  console.log(`\n🔍 Buscando secret...`);
  const secretRes = await axios.get(
    `${authData.baseUrl}/secrets/resource/${resourceId}.json`,
    { headers, timeout: 30000 }
  );
  console.log(`   ✅ Secret obtido`);
  
  // 4. Descriptografar
  console.log(`🔓 Descriptografando...`);
  const decryptedMsg = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: secretRes.data.body.data }),
    decryptionKeys: authData.userKey
  });
  
  // 5. Extrair senha (pode ser JSON ou string pura)
  let password;
  try {
    const secretData = JSON.parse(decryptedMsg.data);
    password = secretData.password;
  } catch {
    password = decryptedMsg.data;
  }
  
  if (!password) {
    throw new Error('Senha vazia retornada do Passbolt');
  }
  
  console.log(`   ✅ Senha obtida (${password.length} caracteres)`);
  return password;
}

/**
 * CRIAR CONTA NO WHM
 */
async function createWHMAccount(domain) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🖥️ [WHM] CRIANDO CONTA`);
  console.log(`   Domain: ${domain}`);
  console.log(`${'='.repeat(70)}`);
  
  // Validar configurações WHM
  if (!config.WHM_URL || !config.WHM_USERNAME || !config.WHM_API_TOKEN) {
    throw new Error('Configuração WHM incompleta (WHM_URL, WHM_USERNAME ou WHM_API_TOKEN)');
  }
  
  if (!config.WHM_ACCOUNT_USERNAME || !config.WHM_ACCOUNT_PACKAGE || !config.WHM_CONTACT_EMAIL_DOMAIN) {
    throw new Error('Configuração de conta WHM incompleta');
  }
  
  // Buscar senha do Passbolt
  let accountPassword;
  try {
    console.log(`\n🔐 Buscando senha no Passbolt...`);
    accountPassword = await getPasswordFromPassbolt();
  } catch (error) {
    console.error(`❌ [PASSBOLT] Erro: ${error.message}`);
    
    if (config.WORDPRESS_DEFAULT_PASSWORD) {
      console.log(`⚠️ Usando senha padrão como fallback`);
      accountPassword = config.WORDPRESS_DEFAULT_PASSWORD;
    } else {
      throw new Error('Não foi possível obter senha do Passbolt e não há senha padrão configurada');
    }
  }
  
  // Configurações da conta
  const username = config.WHM_ACCOUNT_USERNAME;
  const contactEmail = `${domain}@${config.WHM_CONTACT_EMAIL_DOMAIN}`;
  const packageName = config.WHM_ACCOUNT_PACKAGE;
  
  console.log(`\n📋 Configuração:`);
  console.log(`   Domínio: ${domain}`);
  console.log(`   Username: ${username}`);
  console.log(`   Email: ${contactEmail}`);
  console.log(`   Pacote: ${packageName}`);
  
  // Criar conta no WHM
  const params = new URLSearchParams({
    api_token_style: '1',
    domain: domain,
    username: username,
    password: accountPassword,
    contactemail: contactEmail,
    plan: packageName,
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
  
  console.log(`\n📤 Enviando requisição para WHM...`);
  
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
  
  console.log(`📥 Resposta WHM:`, JSON.stringify(response.data, null, 2));
  
  // Verificar sucesso
  const result = response.data?.metadata?.result || response.data?.result;
  const reason = response.data?.metadata?.reason || response.data?.reason || '';
  
  if (result === 1 || result === '1') {
    console.log(`\n✅ [WHM] CONTA CRIADA COM SUCESSO!`);
    return { success: true, domain, username, reason };
  }
  
  console.error(`\n❌ [WHM] FALHA AO CRIAR CONTA`);
  return { success: false, domain, reason };
}

// ============================================
// ROTA DE TESTE
// ============================================
app.post('/test/create-account', async (req, res) => {
  const { domain } = req.body;
  
  if (!domain) {
    return res.status(400).json({ 
      error: 'Domínio não informado',
      exemplo: 'Envie: { "domain": "exemplo.com" }'
    });
  }
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🧪 [TESTE] INICIANDO CRIAÇÃO DE CONTA`);
  console.log(`   Domínio: ${domain}`);
  console.log(`${'='.repeat(70)}`);
  
  try {
    const result = await createWHMAccount(domain);
    res.json(result);
  } catch (error) {
    console.error(`\n❌ [ERRO FATAL] ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'WHM Test' });
});

// ============================================
// INICIAR SERVIDOR DE TESTE
// ============================================
const PORT = process.env.TEST_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🧪 SERVIDOR DE TESTE RODANDO`);
  console.log(`   Porta: ${PORT}`);
  console.log(`   Endpoint: POST http://localhost:${PORT}/test/create-account`);
  console.log(`   Body: { "domain": "exemplo.com" }`);
  console.log(`${'='.repeat(70)}\n`);
});