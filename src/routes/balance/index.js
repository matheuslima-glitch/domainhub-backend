// Endpoints para consulta de saldo Namecheap

const express = require('express');
const router = express.Router();
const namecheapBalance = require('../../services/namecheap/balance');
const supabaseBalance = require('../../services/supabase/balance');

router.get('/', async (req, res, next) => {
  try {
    const balance = await namecheapBalance.getBalance();
    await supabaseBalance.save(balance);

    res.json({
      success: true,
      data: balance
    });
  } catch (error) {
    next(error);
  }
});

router.get('/cached', async (req, res, next) => {
  try {
    const balance = await supabaseBalance.get();

    if (!balance) {
      return res.status(404).json({
        success: false,
        error: 'Saldo não encontrado. Execute sincronização primeiro.'
      });
    }

    res.json({
      success: true,
      data: balance,
      cached: true
    });
  } catch (error) {
    next(error);
  }
});

router.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendBalance = async () => {
    try {
      const balance = await supabaseBalance.get();
      if (balance) {
        res.write(`data: ${JSON.stringify(balance)}\n\n`);
      }
    } catch (error) {
      console.error('Erro SSE:', error);
    }
  };

  await sendBalance();

  const interval = setInterval(async () => {
    try {
      const freshBalance = await namecheapBalance.getBalance();
      await supabaseBalance.save(freshBalance);
      await sendBalance();
    } catch (error) {
      console.error('Erro atualização SSE:', error);
    }
  }, 2 * 60 * 1000);

  req.on('close', () => clearInterval(interval));
});

router.post('/sync', async (req, res, next) => {
  try {
    const balance = await namecheapBalance.getBalance();
    await supabaseBalance.save(balance);

    res.json({
      success: true,
      message: 'Saldo sincronizado',
      data: balance
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
