// =====================================================
// BACKFILL DA SÉRIE MENSAL — rodada única, manual
//
//   npm run backfill:mensal          11 meses (o máximo que a retenção dá)
//   npm run backfill:mensal -- 6      só os 6 meses mais densos
//   npm run backfill:mensal -- 1      teste rápido, só o mês passado
//
// ANTES DE RODAR
//
//   1. migrations/2026-09-10-visitantes-unicos.sql aplicada no Supabase
//   2. CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY, SUPABASE_URL e
//      SUPABASE_SERVICE_ROLE_KEY no ambiente
//   3. COLETA_UNIQUES diferente de "false"
//
// QUANTO TEMPO LEVA: ~5 minutos por mês. Os 11 meses levam cerca de UMA HORA.
//
// Medido em 11/09/2026: um mês com 1.032 zonas levou 286s. O ritmo é lento de
// propósito — a cota da Cloudflare é de 300 consultas por 5 minutos, e o
// backfill inteiro são ~1.144. O script imprime a estimativa real no começo,
// depois de contar as zonas.
//
// É SEGURO RODAR DE NOVO. A gravação é upsert por (domain_id, ano, mes): rodar
// duas vezes reescreve as mesmas linhas com os mesmos valores. Se parar no
// meio, é só rodar outra vez.
//
// O QUE ESPERAR: os meses recentes preenchem muito, os antigos quase nada —
// 88% das zonas em 08/2026 contra 8% em 10/2025. Não é falha; são domínios que
// ainda não existiam. Mês sem dado não vira linha.
// =====================================================

const monthly = require('../services/cloudflare/monthly');

const MESES_PADRAO = 11;

async function principal() {
  const argumento = process.argv[2];
  const meses = argumento ? Number(argumento) : MESES_PADRAO;

  if (!Number.isInteger(meses) || meses < 1 || meses > 12) {
    console.error(`❌ Número de meses inválido: "${argumento}". Use um inteiro de 1 a 12.`);
    process.exit(1);
  }

  if (meses > MESES_PADRAO) {
    console.warn(
      `⚠️ A retenção da Cloudflare é de 52 semanas. Além de ${MESES_PADRAO} meses ` +
        'a consulta é recusada, e o backfill vai parar sozinho ao chegar lá.'
    );
  }

  const resultado = await monthly.backfill(meses);

  if (!resultado.sucesso) {
    console.error(`❌ Backfill não rodou: ${resultado.erro}`);
    process.exit(1);
  }

  // Encerra explicitamente: o cliente do Supabase mantém handles abertos e o
  // processo ficaria pendurado depois de terminar o trabalho.
  process.exit(0);
}

principal().catch((erro) => {
  console.error(`❌ Backfill falhou: ${erro.message}`);
  process.exit(1);
});
