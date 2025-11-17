// Servidor Express principal

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cron = require('node-cron');
const config = require('./config/env');
const errorHandler = require('./middlewares/error');
const balanceRoutes = require('./routes/balance');

const app = express();

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    service: 'DomainHub Backend',
    version: '1.0.0',
    status: 'online'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime()
  });
});

app.get('/api/ip', async (req, res) => {
  const axios = require('axios');
  try {
    const { data } = await axios.get('https://api.ipify.org?format=json');
    res.json({
      ip: data.ip,
      message: 'Adicione este IP na whitelist da Namecheap'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter IP' });
  }
});

app.use('/api/balance', balanceRoutes);
app.use('/api/domains', require('./routes/domains'));

app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada'
  });
});

app.use(errorHandler);

cron.schedule('0 */4 * * *', async () => {
  console.log('🔄 [CRON] Iniciando sincronização automática de domínios...');
  
  try {
    const namecheapDomains = require('./services/namecheap/domains');
    const supabaseDomains = require('./services/supabase/domains');
    
    const domains = await namecheapDomains.syncAllDomains();
    console.log(`✅ [CRON] ${domains.length} domínios listados da API Namecheap`);
    
    const BATCH_SIZE = 100; // Processar e salvar a cada 100 domínios
    const rateLimitDelay = 250;
    let processedCount = 0;
    let rateLimitHits = 0;
    const MAX_RATE_LIMIT_RETRIES = 3;
    let totalSaved = 0;
    let totalFailed = 0;

    // Processar em lotes de 100
    for (let i = 0; i < domains.length; i += BATCH_SIZE) {
      const batch = domains.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(domains.length / BATCH_SIZE);
      
      console.log(`\n📦 [CRON] Processando lote ${batchNumber}/${totalBatches} (${batch.length} domínios)`);
      
      const detailedDomains = [];

      for (const domain of batch) {
        processedCount++;
        console.log(`📋 [CRON] Processando ${processedCount}/${domains.length}: ${domain.domain_name}`);
        
        let details = await namecheapDomains.getDomainInfo(domain.domain_name);
        
        if (!details.has_error) {
          detailedDomains.push(details);
          rateLimitHits = 0;
        } else if (details.error_type === 'rate_limit') {
          rateLimitHits++;
          console.warn(`⚠️ [CRON] Rate limit atingido (${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES}) em ${domain.domain_name}`);
          
          if (rateLimitHits >= MAX_RATE_LIMIT_RETRIES) {
            console.error(`❌ [CRON] Rate limit persistente. Salvando lote atual e parando. Progresso: ${processedCount}/${domains.length}`);
            
            // Salvar o que já foi processado neste lote antes de parar
            if (detailedDomains.length > 0) {
              console.log(`💾 [CRON] Salvando ${detailedDomains.length} domínios do lote incompleto...`);
              const results = await supabaseDomains.batchUpsertDomains(detailedDomains);
              totalSaved += results.success;
              totalFailed += results.failed;
              console.log(`✅ [CRON] Lote salvo: ${results.success} domínios, ${results.failed} falhas`);
            }
            
            console.log(`\n📊 [CRON] Estatísticas finais (interrompido por rate limit):`);
            console.log(`   Total processado: ${processedCount}/${domains.length} domínios`);
            console.log(`   Total salvo no Supabase: ${totalSaved} domínios`);
            console.log(`   Total de falhas: ${totalFailed} domínios`);
            return; // Parar a execução
          }
          
          console.log('⏳ [CRON] Aguardando 2 minutos antes de continuar...');
          await namecheapDomains.delay(120000);
          
          details = await namecheapDomains.getDomainInfo(domain.domain_name);
          if (!details.has_error) {
            detailedDomains.push(details);
            rateLimitHits = 0;
          }
        } else if (details.error_type === 'other_error') {
          console.warn(`⚠️ [CRON] Erro em ${domain.domain_name}: ${details.error_message}`);
          
          if (details.has_alert) {
            detailedDomains.push(details);
          }
        }
        
        await namecheapDomains.delay(rateLimitDelay);
      }

      // Salvar o lote atual no Supabase
      if (detailedDomains.length > 0) {
        console.log(`💾 [CRON] Salvando lote ${batchNumber}/${totalBatches} com ${detailedDomains.length} domínios no Supabase...`);
        const results = await supabaseDomains.batchUpsertDomains(detailedDomains);
        totalSaved += results.success;
        totalFailed += results.failed;
        console.log(`✅ [CRON] Lote ${batchNumber} salvo: ${results.success} domínios atualizados, ${results.failed} falhas`);
      } else {
        console.log(`⚠️ [CRON] Lote ${batchNumber} vazio, nada para salvar`);
      }
      
      // Pequeno delay entre lotes
      if (i + BATCH_SIZE < domains.length) {
        await namecheapDomains.delay(1000);
      }
    }

    console.log(`\n📊 [CRON] Sincronização concluída com sucesso!`);
    console.log(`   Total processado: ${processedCount}/${domains.length} domínios`);
    console.log(`   Total salvo no Supabase: ${totalSaved} domínios`);
    console.log(`   Total de falhas: ${totalFailed} domínios`);
  } catch (error) {
    console.error('❌ [CRON] Erro na sincronização automática:', error);
  }
});

app.listen(config.PORT, async () => {
  console.log(`Servidor rodando na porta ${config.PORT}`);
  console.log(`Ambiente: ${config.NODE_ENV}`);
  console.log('🕐 Cron de domínios configurado: A cada 4 horas');
  console.log('📦 Processamento em lotes de 100 domínios');
  
  const namecheapBalance = require('./services/namecheap/balance');
  const ip = await namecheapBalance.getServerIP();
  console.log(`IP do servidor: ${ip}`);
  console.log('Adicione na whitelist: https://ap.www.namecheap.com/settings/tools/apiaccess/');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));