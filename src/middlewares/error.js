// Middleware global de tratamento de erros

module.exports = (err, req, res, next) => {
  console.error('Erro:', err);

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Erro interno do servidor';

  res.status(statusCode).json({
    success: false,
    error: message,
    timestamp: new Date().toISOString()
  });
};
