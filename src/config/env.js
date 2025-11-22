// Arquivo: src/config/env.js


const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_USER_ID',
  'NAMECHEAP_API_USER',
  'NAMECHEAP_API_KEY',
  'NAMECHEAP_CLIENT_IP',
  'GODADDY_API_KEY', 
  'GODADDY_API_SECRET' 
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Variáveis de ambiente obrigatórias ausentes:');
  missingVars.forEach(varName => console.error(`  - ${varName}`));
  throw new Error(`Configure as variáveis no Render: ${missingVars.join(', ')}`);
}

// Verificar OpenAI (crítica para geração de domínios)
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY não configurada - geração de domínios com IA DESABILITADA!');
  console.error('   Configure urgentemente para o sistema funcionar corretamente');
}

// Verificar variáveis importantes para WordPress
const wordpressVars = [
  'WORDPRESS_DEFAULT_USER',
  'WORDPRESS_DEFAULT_PASSWORD',
  'WORDPRESS_ADMIN_EMAIL',
  'CPANEL_URL',
  'CPANEL_USERNAME',
  'CPANEL_API_TOKEN',
  'CPANEL_DOMAIN'
];

const missingWordpress = wordpressVars.filter(v => !process.env[v]);
if (missingWordpress.length > 0) {
  console.warn('⚠️ Variáveis WordPress não configuradas:');
  missingWordpress.forEach(v => console.warn(`  - ${v}`));
  console.warn('   Instalação automática do WordPress será desabilitada');
}

// Verificar variáveis Cloudflare
const cloudflareVars = [
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID'
];

const missingCloudflare = cloudflareVars.filter(v => !process.env[v]);
if (missingCloudflare.length > 0) {
  console.warn('⚠️ Variáveis Cloudflare não configuradas:');
  missingCloudflare.forEach(v => console.warn(`  - ${v}`));
  console.warn('   Configuração de DNS e segurança será desabilitada');
}

// Verificar variáveis WhatsApp
if (!process.env.ZAPI_INSTANCE || !process.env.ZAPI_CLIENT_TOKEN) {
  console.warn('⚠️ Z-API não configurado - notificações WhatsApp desabilitadas');
}

// Log de configuração
console.log('\n📋 CONFIGURAÇÃO DO SISTEMA DOMAINHUB');
console.log('=====================================');
console.log(`✅ Namecheap API: Configurado`);
console.log(`✅ GoDaddy API: ${process.env.GODADDY_API_KEY ? 'Configurado' : 'NÃO CONFIGURADO'}`);
console.log(`✅ IP Cliente: ${process.env.NAMECHEAP_CLIENT_IP}`);
console.log(`${process.env.OPENAI_API_KEY ? '✅' : '❌'} OpenAI: ${process.env.OPENAI_API_KEY ? 'Configurado' : 'NÃO CONFIGURADO'}`);
console.log(`${missingWordpress.length === 0 ? '✅' : '⚠️'} WordPress: ${missingWordpress.length === 0 ? 'Configurado' : 'Parcialmente configurado'}`);
console.log(`${missingCloudflare.length === 0 ? '✅' : '⚠️'} Cloudflare: ${missingCloudflare.length === 0 ? 'Configurado' : 'Parcialmente configurado'}`);
console.log(`${process.env.ZAPI_INSTANCE ? '✅' : '⚠️'} WhatsApp: ${process.env.ZAPI_INSTANCE ? 'Configurado' : 'Não configurado'}`);
console.log('=====================================\n');

module.exports = {
  // Porta e ambiente
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'production',

  // Supabase (Database)
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_USER_ID: process.env.SUPABASE_USER_ID,

  // Namecheap (Compra de Domínios)
  NAMECHEAP_API_USER: process.env.NAMECHEAP_API_USER,
  NAMECHEAP_API_KEY: process.env.NAMECHEAP_API_KEY,
  NAMECHEAP_CLIENT_IP: process.env.NAMECHEAP_CLIENT_IP,

  // GoDaddy (Verificação de Disponibilidade) - NOVAS
  GODADDY_API_KEY: process.env.GODADDY_API_KEY,
  GODADDY_API_SECRET: process.env.GODADDY_API_SECRET,

  // OpenAI (Geração de domínios com IA)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,

  // Cloudflare (DNS e Segurança)
  CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,

  // cPanel/Softaculous (WordPress)
  CPANEL_URL: process.env.CPANEL_URL || 'https://nexus.servidor.net.br:2083',
  CPANEL_USERNAME: process.env.CPANEL_USERNAME || 'institutoexperience',
  CPANEL_API_TOKEN: process.env.CPANEL_API_TOKEN,
  CPANEL_DOMAIN: process.env.CPANEL_DOMAIN || 'nexus.servidor.net.br',

  // WordPress Configurações
  WORDPRESS_DEFAULT_USER: process.env.WORDPRESS_DEFAULT_USER,
  WORDPRESS_DEFAULT_PASSWORD: process.env.WORDPRESS_DEFAULT_PASSWORD,
  WORDPRESS_ADMIN_EMAIL: process.env.WORDPRESS_ADMIN_EMAIL,

  // Servidor de Hospedagem
  HOSTING_SERVER_IP: process.env.HOSTING_SERVER_IP,

  // WhatsApp Z-API
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,
  WHATSAPP_PHONE_NUMBER: process.env.WHATSAPP_PHONE_NUMBER,

  // WordPress
  WORDPRESS_DEFAULT_USER: process.env.WORDPRESS_DEFAULT_USER,
  WORDPRESS_DEFAULT_PASSWORD: process.env.WORDPRESS_DEFAULT_PASSWORD,
  WORDPRESS_ADMIN_EMAIL: process.env.WORDPRESS_ADMIN_EMAIL,

  // cPanel Theme
  CPANEL_THEME: 'jupiter',
};