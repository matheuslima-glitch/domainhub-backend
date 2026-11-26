// PROVAS DO RELATÓRIO DE DOMÍNIOS CRÍTICOS
//
//   npm run testa:criticos
//
// Sem rede e sem banco: o Supabase é um dublê em memória que obedece ao teto
// de 1.000 linhas do PostgREST, e o distribuidor de notificações é trocado por
// um que só anota o que receberia.
//
// O que este teste trava (pedido do time em 26/11/2026: "esse '…e mais 19' não
// mostra os demais domínios"):
//
//   1. TODOS OS DOMÍNIOS NA MENSAGEM. Nada de "…e mais N".
//   2. NENHUMA PARTE PASSA DO LIMITE. Discord corta em 2.000 caracteres e
//      Telegram em 4.096; mensagem cortada perde domínio em silêncio.
//   3. CADA DOMÍNIO APARECE UMA VEZ SÓ, mesmo quando a lista vira várias
//      partes, e nenhuma linha é partida ao meio.
//   4. SÓ A PRIMEIRA PARTE MENCIONA O GRUPO no Discord.
//   5. O TETO DE 1.000 DO POSTGREST não esconde ninguém: a lista é paginada.
//   6. "EXPIRAM" EM ORDEM DE VENCIMENTO, do mais urgente para o mais distante.

Object.assign(process.env, {
  SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake',
  SUPABASE_USER_ID: '00000000-0000-0000-0000-000000000000',
  NAMECHEAP_API_USER: 'fake',
  NAMECHEAP_API_KEY: 'fake',
  NAMECHEAP_CLIENT_IP: '127.0.0.1',
  CLOUDFLARE_EMAIL: 'falso@exemplo.invalid',
  CLOUDFLARE_API_KEY: 'fake',
  CLOUDFLARE_ACCOUNT_ID: 'conta-falsa',
  DISCORD_WEBHOOK_URL: 'https://discord.invalid/api/webhooks/1/falso',
});

const imprimir = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond: !!cond, detalhe });

// ── canais falsos (o distribuidor index.js é o REAL) ──────────────────────
// Cada canal anota o que receberia. `lancar` simula um canal quebrado.
let envios = { TELEGRAM: [], DISCORD: [] };
const lancar = { TELEGRAM: false, DISCORD: false };
const zerarEnvios = () => { envios = { TELEGRAM: [], DISCORD: [] }; };
const canalFalso = (nome) => ({
  exports: {
    send: async (mensagem, opts) => {
      if (lancar[nome]) throw new Error(`${nome} fora do ar`);
      envios[nome].push({ mensagem, opts });
      return { success: true };
    },
  },
});
const CAMINHO_DISCORD = require.resolve('../services/notify/discord');
require.cache[require.resolve('../services/notify/telegram')] = canalFalso('TELEGRAM');
require.cache[CAMINHO_DISCORD] = canalFalso('DISCORD');

// ── Supabase falso, com o teto de 1.000 por chamada ───────────────────────
function clienteFalso(dominios) {
  const TETO = 1000;
  function executar(e) {
    let linhas = dominios.filter((d) => e.filtros.every((f) => f(d)));
    if (e.head) return { count: linhas.length, error: null };
    linhas = [...linhas].sort((a, b) => {
      for (const [c, o] of e.ordem) {
        const va = a[c];
        const vb = b[c];
        if (va === vb) continue;
        if (va == null) return o.nullsFirst === false ? 1 : -1;
        if (vb == null) return o.nullsFirst === false ? -1 : 1;
        const cmp = va < vb ? -1 : 1;
        return o.ascending === false ? -cmp : cmp;
      }
      return 0;
    });
    const [de, ate] = e.faixa || [0, linhas.length - 1];
    return { data: linhas.slice(de, Math.min(ate, de + TETO - 1) + 1), error: null };
  }
  function criar(e) {
    return {
      eq: (c, v) => criar({ ...e, filtros: [...e.filtros, (d) => d[c] === v] }),
      gte: (c, v) => criar({ ...e, filtros: [...e.filtros, (d) => d[c] != null && d[c] >= v] }),
      lte: (c, v) => criar({ ...e, filtros: [...e.filtros, (d) => d[c] != null && d[c] <= v] }),
      order: (c, o) => criar({ ...e, ordem: [...e.ordem, [c, o || {}]] }),
      range: (de, ate) => criar({ ...e, faixa: [de, ate] }),
      then: (resolver, rejeitar) => {
        try { resolver(executar(e)); } catch (x) { rejeitar(x); }
      },
    };
  }
  return {
    from: () => ({
      select: (_colunas, opts = {}) => criar({ head: !!opts.head, filtros: [], ordem: [], faixa: null }),
    }),
  };
}

const DIA = 24 * 60 * 60 * 1000;
const emDias = (n) => new Date(Date.now() + n * DIA).toISOString();
const vencendo = (nome, dias, req = 100) => ({ domain_name: nome, status: 'active', expiration_date: emDias(dias), requests_30d: req });
const expirado = (nome, req) => ({ domain_name: nome, status: 'expired', expiration_date: emDias(-5), requests_30d: req });
const suspenso = (nome) => ({ domain_name: nome, status: 'suspended', expiration_date: emDias(200), requests_30d: null });
const tranquilo = (nome) => ({ domain_name: nome, status: 'active', expiration_date: emDias(200), requests_30d: 10 });

const rel = require('../services/notify/relatorio-criticos');
const LIMITE = rel.TAMANHO_PARTE;

// Domínios citados nas partes, na ordem em que aparecem.
const citados = (partes) => partes.join('\n').split('\n')
  .filter((l) => l.startsWith('• ')).map((l) => l.slice(2).split(' — ')[0]);

async function principal() {
  // ── 1. o cenário do print de 26/11: 2 expirados e 27 vencendo ──────────
  {
    const dias = [5, 9, 7, 9, 7, 14, 6, 6, 3, 11, 8, 12, 4, 13, 10, 2, 5, 8, 6, 9, 12, 13, 11, 4, 7, 3, 10];
    const base = [
      expirado('mensgrowth.org', 159626), expirado('dailyhealthway.online', null),
      ...dias.map((d, i) => vencendo(`vence${String(i + 1).padStart(2, '0')}.com`, d)),
      tranquilo('tranquilo.com'),
    ];
    rel.client = clienteFalso(base);
    const partes = await rel.montar();
    const nomes = citados(partes);
    ok('cabe numa mensagem só, como no print', partes.length === 1, partes.length);
    ok('os 29 domínios críticos aparecem, nenhum a menos', nomes.length === 29 && new Set(nomes).size === 29, nomes.length);
    ok('não existe mais "…e mais N"', !partes.join('').includes('e mais'), partes[0]);
    ok('domínio sem problema não entra', !nomes.includes('tranquilo.com'));
    ok('totais nos títulos', partes[0].includes('*⛔ Expirados: 2*') && partes[0].includes('*🟡 Expiram em 15 dias: 27*'), partes[0]);
    const venc = partes[0].split('\n').filter((l) => l.includes(' — vence ')).map((l) => {
      const [dd, mm] = l.split(' — vence ')[1].split('/');
      return `${mm}${dd}`;
    });
    const ordenado = [...venc].sort();
    ok('"Expiram" do mais urgente para o mais distante', JSON.stringify(venc) === JSON.stringify(ordenado), venc);
    ok('expirado com tráfego vem antes do sem medição',
      nomes.indexOf('mensgrowth.org') < nomes.indexOf('dailyhealthway.online'), nomes.slice(0, 2));
    ok('mensagem única não diz "parte 1/1"', !partes[0].includes('(parte'), partes[0].split('\n')[0]);
    ok('rodapé com a hora da apuração', /_Apurado em .+ \(Brasília\)_$/.test(partes[0]), partes[0].slice(-60));

    zerarEnvios();
    const r = await rel.enviar();
    ok('enviar: Telegram e Discord recebem uma mensagem cada, crítica e mencionando',
      r.success && ['TELEGRAM', 'DISCORD'].every((c) => envios[c].length === 1
        && envios[c][0].opts.critico === true && envios[c][0].opts.mencionar === true), envios);
    ok('enviar: o Telegram recebe os 29 domínios', citados(envios.TELEGRAM.map((e) => e.mensagem)).length === 29);
  }

  // ── 2. nada crítico ─────────────────────────────────────────────────────
  {
    rel.client = clienteFalso([tranquilo('a.com'), tranquilo('b.com')]);
    ok('sem críticos: montar devolve nulo', (await rel.montar()) === null);
    zerarEnvios();
    const r = await rel.enviar();
    ok('sem críticos: nada é enviado', r.vazio === true && !envios.TELEGRAM.length && !envios.DISCORD.length, r);
  }

  // ── 3. lista grande: vira várias partes ─────────────────────────────────
  {
    const base = [
      suspenso('suspenso-um.com'), suspenso('suspenso-dois.com'), suspenso('suspenso-tres.com'),
      ...Array.from({ length: 150 }, (_, i) => vencendo(`dominio-bem-comprido-para-encher-${i}.online`, (i % 14) + 1)),
    ];
    rel.client = clienteFalso(base);
    const partes = await rel.montar();
    const nomes = citados(partes);
    const n = partes.length;
    ok('150 vencendo + 3 suspensos viram mais de uma parte', n > 1, n);
    ok('nenhuma parte passa do limite', partes.every((p) => p.length <= LIMITE), partes.map((p) => p.length));
    ok('cada domínio aparece exatamente uma vez no conjunto', nomes.length === 153 && new Set(nomes).size === 153, nomes.length);
    ok('nenhuma linha partida ao meio',
      partes.every((p) => p.split('\n').every((l) => !l || l.startsWith('*') || l.startsWith('• ') || l.startsWith('_'))), null);
    ok('cabeçalhos numerados "parte i/n"',
      partes.every((p, i) => p.split('\n')[0] === `*🚨 Domínios críticos (parte ${i + 1}/${n})*`), partes.map((p) => p.split('\n')[0]));
    ok('a parte seguinte diz de que lista é ("continuação")',
      partes.slice(1).every((p) => p.split('\n')[2].includes('(continuação)')), partes.slice(1).map((p) => p.split('\n')[2]));
    ok('rodapé só na última parte',
      partes.slice(0, -1).every((p) => !p.includes('Apurado em')) && partes[n - 1].includes('Apurado em'));
    ok('nenhuma parte termina com título solto',
      partes.every((p) => { const l = p.split('\n').filter(Boolean); return !l[l.length - 1].endsWith(':*') && !l[l.length - 1].includes('(continuação)*'); }), null);

    zerarEnvios();
    const r = await rel.enviar();
    const tg = envios.TELEGRAM.map((e) => e.mensagem);
    const dc = envios.DISCORD.map((e) => e.mensagem);
    ok('Discord: partes de até 1.800 caracteres, na ordem', dc.length === n && dc.join('|') === partes.join('|'), dc.map((p) => p.length));
    ok('Telegram: partes de até 3.800 caracteres', tg.length >= 1 && tg.every((p) => p.length <= 3800), tg.map((p) => p.length));
    ok('Telegram, canal principal, recebe MENOS mensagens que o Discord', tg.length < dc.length, { telegram: tg.length, discord: dc.length });
    ok('Telegram recebe cada domínio exatamente uma vez',
      citados(tg).length === 153 && new Set(citados(tg)).size === 153, citados(tg).length);
    ok('Telegram numera as próprias partes', tg.length === 1 || tg.every((p, i) => p.startsWith(`*🚨 Domínios críticos (parte ${i + 1}/${tg.length})*`)),
      tg.map((p) => p.split('\n')[0]));
    ok('em cada canal só a primeira parte menciona o grupo; todas são críticas',
      ['TELEGRAM', 'DISCORD'].every((c) => envios[c].every((e, i) => e.opts.critico === true && e.opts.mencionar === (i === 0))),
      { tg: envios.TELEGRAM.map((e) => e.opts), dc: envios.DISCORD.map((e) => e.opts) });
    ok('enviar devolve um resultado por parte de cada canal', r.success && r.resultados.length === tg.length + dc.length, r.resultados.length);

    // Um canal quebrado não impede o outro.
    zerarEnvios();
    lancar.DISCORD = true;
    const r2 = await rel.enviar();
    lancar.DISCORD = false;
    ok('Discord fora do ar: o Telegram recebe tudo assim mesmo',
      citados(envios.TELEGRAM.map((e) => e.mensagem)).length === 153
      && r2.resultados.some((x) => x.canal === 'DISCORD' && x.success === false), r2.resultados);
  }

  // ── 4. mais de 1.000: o teto do PostgREST não esconde ninguém ──────────
  {
    rel.client = clienteFalso(Array.from({ length: 1200 }, (_, i) => expirado(`expirado${i}.com`, 1200 - i)));
    const partes = await rel.montar();
    const nomes = citados(partes);
    ok('1.200 expirados: os 1.200 aparecem (lista paginada)', nomes.length === 1200 && new Set(nomes).size === 1200, nomes.length);
    ok('1.200 expirados: título com o total real', partes[0].includes('*⛔ Expirados: 1200*'), partes[0].split('\n').slice(0, 3));
    ok('1.200 expirados: nenhuma parte passa do limite', partes.every((p) => p.length <= LIMITE), Math.max(...partes.map((p) => p.length)));
  }

  // ── 5. o Discord só chama @everyone quando mencionar não é false ───────
  {
    const axios = require('axios');
    const corpos = [];
    axios.defaults.adapter = async (cfg) => {
      corpos.push(JSON.parse(cfg.data));
      return { data: {}, status: 204, statusText: 'No Content', headers: {}, config: cfg };
    };
    delete require.cache[CAMINHO_DISCORD]; // agora o discord.js REAL
    const discord = require('../services/notify/discord');
    await discord.send('*Parte um*', { critico: true });
    await discord.send('*Parte dois*', { critico: true, mencionar: false });
    ok('Discord: alerta crítico normal chama @everyone', corpos[0] && corpos[0].content.startsWith('@everyone'), corpos[0]);
    ok('Discord: continuação (mencionar: false) chega sem @everyone',
      corpos[1] && !corpos[1].content.includes('@everyone') && corpos[1].content.includes('Parte dois'), corpos[1]);
  }

  const falhas = provas.filter((p) => !p.cond);
  for (const p of provas) {
    imprimir(`  ${p.cond ? 'ok  ' : 'FALHA'} ${p.rot}`);
    if (!p.cond && p.detalhe !== undefined) imprimir(`        ${JSON.stringify(p.detalhe).slice(0, 400)}`);
  }
  imprimir(`\n${provas.length} provas, ${falhas.length} falha(s).`);
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((e) => {
  imprimir('ERRO FATAL NA PROVA:', e);
  process.exit(1);
});
