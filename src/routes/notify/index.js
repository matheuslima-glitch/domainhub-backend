// =====================================================
// ROTAS DE DIAGNÓSTICO DOS CANAIS DE NOTIFICAÇÃO
//
// Existem porque a única forma de saber se um canal entrega era esperar um
// domínio cair. Quando o webhook do Discord virou HTTP 401 em 2026, ninguém
// percebeu: alertas que não chegam são indistinguíveis de "não houve alerta".
//
// As duas rotas são de ESCRITA (POST) de propósito, mesmo não gravando nada:
// elas disparam mensagem para grupos de gente real, e GET é a coisa que
// navegador, prefetch e health-check disparam sozinhos.
//
// Ambas passam pelo authMiddleware, como todas as /api — ver server.js.
// =====================================================

const express = require('express');
const router = express.Router();

/**
 * Manda uma mensagem de teste a TODOS os canais e devolve o resultado de cada.
 *
 * `critico: true` de propósito, ainda que teste seja informativo: a política
 * do canal suprime informativas, então um teste marcado como tal seria
 * engolido e a rota responderia "sucesso" sem nada ter chegado — exatamente o
 * tipo de falha silenciosa que estas rotas existem para acabar.
 *
 * O texto se identifica como teste para ninguém no grupo achar que caiu algo.
 */
router.post('/teste', async (req, res, next) => {
  try {
    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const texto = [
      '*🧪 Teste de canal — DomainHub*',
      '',
      'Nenhum domínio caiu. Esta mensagem só confirma que o canal entrega.',
      '',
      `_Disparado em ${quando} (Brasília)_`
    ].join('\n');

    const resultados = await require('../../services/notify').espelhar(texto, { critico: true });

    // 207: alguns canais entregaram, outros não. Quem chama precisa distinguir
    // "o Telegram funciona e o Discord não" de "nada funciona".
    const todos = resultados.every((r) => r.success);
    res.status(todos ? 200 : 207).json({ success: todos, canais: resultados });
  } catch (error) {
    next(error);
  }
});

/**
 * Roda AGORA o relatório de domínios críticos, sem esperar o cron das 11:15.
 *
 * Mesmo caminho do cron, então testar isto testa o que vai para produção — e
 * não uma simulação que pode divergir.
 */
router.post('/criticos', async (req, res, next) => {
  try {
    const resultado = await require('../../services/notify/relatorio-criticos').enviar();
    res.json(resultado);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
