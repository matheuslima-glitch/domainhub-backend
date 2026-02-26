// =====================================================
// Middleware de autenticação que valida o token JWT do Supabase.
// Qualquer requisição às rotas /api/* precisa enviar:
//   Authorization: Bearer <token_jwt_do_supabase>
//
// O token é validado diretamente com o Supabase Auth.
// Se válido, req.user é preenchido com os dados do usuário.
// =====================================================

const { createClient } = require('@supabase/supabase-js');
const config = require('../config/env');

// Cliente Supabase admin (para validar tokens)
const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function authMiddleware(req, res, next) {
  // Extrair token do header Authorization
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Não autenticado',
      message: 'Token de autenticação não fornecido. Envie o header Authorization: Bearer <token>',
    });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // Validar token com o Supabase Auth
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        error: 'Token inválido',
        message: error?.message || 'Não foi possível validar o token',
      });
    }

    // Adicionar usuário na request (disponível em todas as rotas)
    req.user = user;
    next();
  } catch (err) {
    console.error('❌ [AUTH] Erro ao validar token:', err.message);
    return res.status(500).json({
      error: 'Erro interno de autenticação',
    });
  }
}

module.exports = authMiddleware;
