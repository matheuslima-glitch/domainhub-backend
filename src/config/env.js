// Configuração de variáveis de ambiente

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_USER_ID',
  'NAMECHEAP_API_USER',
  'NAMECHEAP_API_KEY'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('Variáveis de ambiente obrigatórias ausentes:');
  missingVars.forEach(varName => console.error(`  - ${varName}`));
  throw new Error(`Configure as variáveis no Render: ${missingVars.join(', ')}`);
}

// Verificar se OPENAI_API_KEY está configurada (opcional, mas recomendado)
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY não configurada - geração de domínios com IA desabilitada');
}

// Verificar outras variáveis opcionais importantes
const optionalVars = [
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CPANEL_URL',
  'CPANEL_USERNAME',
  'CPANEL_API_TOKEN',
  'ZAPI_INSTANCE',
  'ZAPI_CLIENT_TOKEN',
  'WHATSAPP_PHONE_NUMBER'
];

optionalVars.forEach(varName => {
  if (!process.env[varName]) {
    console.log(`ℹ️ ${varName} não configurada`);
  }
});

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'production',

  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_USER_ID: process.env.SUPABASE_USER_ID,

  NAMECHEAP_API_USER: process.env.NAMECHEAP_API_USER,
  NAMECHEAP_API_KEY: process.env.NAMECHEAP_API_KEY,

  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,

  CPANEL_URL: process.env.CPANEL_URL,
  CPANEL_USERNAME: process.env.CPANEL_USERNAME,
  CPANEL_API_TOKEN: process.env.CPANEL_API_TOKEN,

  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE,
  ZAPI_TOKEN: process.env.ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  WHATSAPP_PHONE_NUMBER: process.env.WHATSAPP_PHONE_NUMBER,

  // Chave OpenAI para geração de domínios com IA
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};