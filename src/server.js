// Servidor Express principal

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
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

app.listen(config.PORT, async () => {
  console.log(`Servidor rodando na porta ${config.PORT}`);
  console.log(`Ambiente: ${config.NODE_ENV}`);
  
  const namecheapBalance = require('./services/namecheap/balance');
  const ip = await namecheapBalance.getServerIP();
  console.log(`IP do servidor: ${ip}`);
  console.log('Adicione na whitelist: https://ap.www.namecheap.com/settings/tools/apiaccess/');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
