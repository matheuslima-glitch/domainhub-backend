// Exercita os canais de notificação sem rede e sem banco.
//
// O que este teste trava, e por que cada coisa importa:
//
//   1. AS DUAS CONVENÇÕES DE NEGRITO. A base escreve `*texto*` (estilo
//      WhatsApp) nos alertas e `**texto**` (estilo Discord) no aviso de
//      exclusão. Tratar só uma faz a outra chegar com os asteriscos à mostra.
//   2. ESCAPAR ANTES DE CONVERTER. Na ordem inversa as próprias tags <b> que
//      acabamos de criar seriam escapadas, e o grupo veria "&lt;b&gt;".
//   3. TRUNCAR SEM QUEBRAR O HTML. Corte no meio de um <b> faz o Telegram
//      RECUSAR a mensagem inteira com HTTP 400 — o alerta não chegaria.
//   4. DEDUPLICAÇÃO. O laço de contatos do WhatsApp chama o envio uma vez por
//      pessoa; sem colapsar, o grupo recebe a mesma mensagem N vezes.
//   5. A POLÍTICA DO CANAL. "Tudo exceto sucessos": informativa não sai.
//   6. UM CANAL NÃO DERRUBA O OUTRO. É a propriedade que justifica ter
//      trocado as cinco chamadas diretas pelo distribuidor. Se o Discord
//      lançar, o Telegram precisa receber assim mesmo — e vice-versa.
//   7. O DISTRIBUIDOR NUNCA LANÇA. Notificação é acréscimo: ela não pode
//      derrubar a compra, o swap ou o pedido de exclusão que a originou.
//   8. OS DOIS CANAIS RECEBEM OS MESMOS ARGUMENTOS. `critico` e `botao`
//      precisam chegar iguais nos dois, senão um filtra o que o outro envia.
//
// Rode com: node src/scripts/testa-canais-notificacao.js
const Module = require('module');

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.SUPABASE_USER_ID = '00000000-0000-0000-0000-000000000000';
process.env.NAMECHEAP_API_USER = 'fake';
process.env.NAMECHEAP_API_KEY = 'fake';
process.env.NAMECHEAP_CLIENT_IP = '127.0.0.1';
process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
process.env.TELEGRAM_CHAT_ID = '-1009999999999';

const provas = [];
const ok = (rot, cond, detalhe) => provas.push({ rot, cond, detalhe });

// ── Dublês ────────────────────────────────────────────────────────────────
let enviosAxios = [];
let respostaAxios = { data: { ok: true, result: { message_id: 1 } } };

// Trocado entre os dois grupos de prova: no primeiro o telegram.js real roda
// contra um axios falso; no segundo os dois canais são dublês para o
// distribuidor ser observado isoladamente.
let dublarCanais = false;
let recebidoDiscord = [];
let recebidoTelegram = [];
let discordLanca = false;
let telegramLanca = false;

// Banco falso para o grupo 3. `contatosFalsos` é trocado entre as provas para
// simular "ninguém cadastrado" e "vários contatos com nomes diferentes".
let contatosFalsos = [];
const DOMINIO_FALSO = { monthly_visits: 1234, weekly_visits: 56, traffic_source: 'Facebook' };

function clienteFalso() {
  const cadeia = (lista, unico) => {
    const obj = {
      select: () => obj,
      eq: () => obj,
      gte: () => obj,
      order: () => obj,
      limit: () => obj,
      update: () => obj,
      insert: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: unico, error: null }),
      single: () => Promise.resolve({ data: unico, error: null }),
      // Torna a cadeia aguardável: `await client.from(x).select().eq()`
      then: (res, rej) => Promise.resolve({ data: lista, error: null }).then(res, rej)
    };
    return obj;
  };

  return {
    from: (tabela) => {
      if (tabela === 'domains') return cadeia([DOMINIO_FALSO], DOMINIO_FALSO);
      if (tabela === 'notification_settings') return cadeia(contatosFalsos, contatosFalsos[0] || null);
      return cadeia([], null);
    }
  };
}

const original = Module._load;
Module._load = function (pedido, pai, ehPrincipal) {
  if (pedido === '@supabase/supabase-js') {
    return { createClient: () => clienteFalso() };
  }
  if (pedido === 'axios') {
    return {
      post: async (url, body) => {
        enviosAxios.push({ url, body });
        return respostaAxios;
      }
    };
  }
  if (dublarCanais && pedido === './discord') {
    return {
      send: async (m, o) => {
        if (discordLanca) throw new Error('discord explodiu');
        recebidoDiscord.push({ m, o });
        return { success: true };
      }
    };
  }
  if (dublarCanais && pedido === './telegram') {
    return {
      send: async (m, o) => {
        if (telegramLanca) throw new Error('telegram explodiu');
        recebidoTelegram.push({ m, o });
        return { success: true };
      }
    };
  }
  return original.apply(this, arguments);
};

const telegram = require('../services/notify/telegram');

const ultimoTexto = () => enviosAxios[enviosAxios.length - 1].body.text;

async function provarTelegram() {
  // 1. As duas convenções de negrito
  enviosAxios = [];
  await telegram.send('Domínio *caiu* agora');
  ok('negrito do WhatsApp vira <b>', ultimoTexto().includes('<b>caiu</b>'), ultimoTexto());

  await telegram.send('**Quem pediu:** Fulano de Tal');
  ok('negrito do Discord vira <b>', ultimoTexto().includes('<b>Quem pediu:</b>'), ultimoTexto());

  ok(
    'e nao sobra asterisco na tela',
    !ultimoTexto().includes('*'),
    ultimoTexto()
  );

  await telegram.send('Pedido `abc-123` vence em 24h');
  ok('crase vira <code>', ultimoTexto().includes('<code>abc-123</code>'), ultimoTexto());

  // Sublinhado: vira italico FORA de palavra, e e deixado em paz DENTRO dela.
  // O rodape dos templates chegou no grupo com os sublinhados a mostra em
  // 09/10/2026 -- a primeira versao nao convertia nada por medo de estragar
  // nome de dominio.
  await telegram.send('rodape\n_Disparado em 01/01/2030_');
  ok('sublinhado fora de palavra vira <i>', ultimoTexto().includes('<i>Disparado em 01/01/2030</i>'), ultimoTexto());

  await telegram.send('o dominio meu_site_legal.com caiu as 02/02/2030');
  ok(
    'mas sublinhado DENTRO de palavra fica intacto',
    ultimoTexto().includes('meu_site_legal.com') && !ultimoTexto().includes('<i>'),
    ultimoTexto()
  );

  // 2. Escapar antes de converter
  await telegram.send('erro em <script> & cia, no *alpha* dominio');
  const t = ultimoTexto();
  ok('HTML do texto e escapado', t.includes('&lt;script&gt;') && t.includes('&amp;'), t);
  ok('mas a tag que criamos sobrevive', t.includes('<b>alpha</b>'), t);

  // 3. Truncar sem quebrar o HTML
  enviosAxios = [];
  await telegram.send('*' + 'a'.repeat(5000) + '*');
  const longo = ultimoTexto();
  const abertas = (longo.match(/<b>/g) || []).length;
  const fechadas = (longo.match(/<\/b>/g) || []).length;
  ok('mensagem longa e truncada', longo.length <= 4096, `veio ${longo.length}`);
  ok('e o <b> aberto pelo corte e fechado', abertas === fechadas, `${abertas} abertas, ${fechadas} fechadas`);
  ok('e avisa que truncou', longo.includes('(truncado)'), longo.slice(-30));

  // 4. Deduplicação — o laço de contatos manda a mesma coisa N vezes
  enviosAxios = [];
  const alerta = 'Dominio xpto.com caiu em 09/10/2026, 11:22:33';
  const r1 = await telegram.send(alerta);
  const r2 = await telegram.send('Dominio xpto.com caiu em 09/10/2026, 11:22:48');
  ok('o primeiro envio vai', r1.success && !r1.deduplicated, JSON.stringify(r1));
  ok('a copia com outro segundo e engolida', r2.deduplicated === true, JSON.stringify(r2));
  ok('e so uma chamada chegou na API', enviosAxios.length === 1, `foram ${enviosAxios.length}`);

  // 4b. O CENÁRIO REAL: o mesmo domínio caindo, avisado a N contatos.
  //
  // Medido em 09/10/2026: 27 contatos ativos, 18 com número, 17 nomes
  // distintos. O laço manda uma mensagem POR PESSOA e o template é
  // personalizado — então a normalização de data/hora não basta, e sem chave
  // declarada o grupo recebia uma cópia por nome.
  const nomes = ['Eduardo', 'Matheus', 'William', 'Rhanna', 'Vinicius'];
  const alertaDe = (nome) =>
    `🤖 *DOMAIN HUB*\n\n⚠️ *ALERTA URGENTE*\n\n*${nome}*, detectamos que o domínio *alvo.com* foi suspenso!\n⏰ *Detectado em:* 09/10/2026, 11:22:33`;

  enviosAxios = [];
  for (const nome of nomes) {
    await telegram.send(alertaDe(nome), { chaveAlerta: 'suspenso:alvo.com' });
  }
  ok(
    '5 contatos com nomes diferentes viram UMA mensagem',
    enviosAxios.length === 1,
    `foram ${enviosAxios.length}`
  );

  // E a prova de que o defeito existia: sem a chave, cada nome passa.
  enviosAxios = [];
  for (const nome of nomes) {
    await telegram.send(alertaDe(nome).replace('alvo.com', 'semchave.com'));
  }
  ok(
    'sem a chave declarada, cada nome passaria (era o defeito)',
    enviosAxios.length === nomes.length,
    `foram ${enviosAxios.length} de ${nomes.length}`
  );

  // Domínios diferentes NÃO podem colidir — perder alerta é pior que duplicar.
  enviosAxios = [];
  await telegram.send(alertaDe('Eduardo').replace('alvo.com', 'um.com'), {
    chaveAlerta: 'suspenso:um.com'
  });
  await telegram.send(alertaDe('Eduardo').replace('alvo.com', 'dois.com'), {
    chaveAlerta: 'suspenso:dois.com'
  });
  ok('dominios diferentes passam os dois', enviosAxios.length === 2, `foram ${enviosAxios.length}`);

  // Mesmo domínio, evento diferente: suspenso e expirado são avisos distintos.
  enviosAxios = [];
  await telegram.send('x suspenso', { chaveAlerta: 'suspenso:tres.com' });
  await telegram.send('x expirado', { chaveAlerta: 'expirado:tres.com' });
  ok('suspenso e expirado do mesmo dominio nao colidem', enviosAxios.length === 2, `foram ${enviosAxios.length}`);

  // 5. Política do canal
  enviosAxios = [];
  const inf = await telegram.send('Compra concluida com sucesso', { critico: false });
  ok('informativa nao sai', inf.suprimida === true, JSON.stringify(inf));
  ok('e nao toca a API', enviosAxios.length === 0, `foram ${enviosAxios.length}`);

  // Botão de link
  enviosAxios = [];
  await telegram.send('Pedido de exclusao aguardando', {
    botao: { rotulo: 'Aprovar', url: 'https://painel/x' }
  });
  const markup = enviosAxios[0].body.reply_markup;
  ok(
    'botao vira inline_keyboard',
    !!markup && markup.inline_keyboard[0][0].url === 'https://painel/x',
    JSON.stringify(markup)
  );

  // Erro da API vira diagnóstico, não "sucesso"
  enviosAxios = [];
  respostaAxios = { data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
  const ruim = await telegram.send('Alerta que nao vai entregar 00/00/0000');
  ok('resposta ok:false vira falha', ruim.success === false, JSON.stringify(ruim));
  ok('e a mensagem diz o que fazer', /chat n[aã]o encontrado/.test(ruim.error), ruim.error);

  // Virar supergrupo troca o chat_id sozinho, sem ninguem mexer em nada. O id
  // novo vem na resposta: o log tem de dizer qual colar, nao so "deu 400".
  enviosAxios = [];
  respostaAxios = {
    data: {
      ok: false,
      error_code: 400,
      description: 'Bad Request: group chat was upgraded to a supergroup chat',
      parameters: { migrate_to_chat_id: -1001112223334 }
    }
  };
  const migrou = await telegram.send('Alerta no grupo que virou supergrupo 11/11/1111');
  ok('migracao para supergrupo e reconhecida', migrou.success === false, JSON.stringify(migrou));
  ok('e o log entrega o chat_id novo',
    migrou.error.includes('-1001112223334'), migrou.error);

  respostaAxios = { data: { ok: true, result: { message_id: 1 } } };
}

async function provarDistribuidor() {
  dublarCanais = true;
  const notify = require('../services/notify');

  // 8. Os dois recebem os mesmos argumentos
  recebidoDiscord = [];
  recebidoTelegram = [];
  const opts = { critico: true, botao: { rotulo: 'Ver', url: 'https://x' } };
  const res = await notify.espelhar('mensagem unica', opts);

  ok('os dois canais foram chamados', recebidoDiscord.length === 1 && recebidoTelegram.length === 1,
    `discord=${recebidoDiscord.length} telegram=${recebidoTelegram.length}`);
  ok('com o mesmo texto',
    recebidoDiscord[0].m === recebidoTelegram[0].m, recebidoDiscord[0].m);
  ok('e as mesmas opcoes',
    JSON.stringify(recebidoDiscord[0].o) === JSON.stringify(recebidoTelegram[0].o),
    JSON.stringify(recebidoDiscord[0].o));
  ok('o retorno identifica cada canal',
    res.length === 2 && res.every((r) => r.canal && 'success' in r), JSON.stringify(res));

  // 6. Um canal não derruba o outro
  recebidoDiscord = [];
  recebidoTelegram = [];
  discordLanca = true;
  const res2 = await notify.espelhar('o discord vai explodir');
  ok('Discord lancando nao impede o Telegram', recebidoTelegram.length === 1, `telegram=${recebidoTelegram.length}`);
  ok('e a falha dele aparece no retorno',
    res2.find((r) => r.canal === 'DISCORD').success === false, JSON.stringify(res2));
  discordLanca = false;

  recebidoDiscord = [];
  recebidoTelegram = [];
  telegramLanca = true;
  await notify.espelhar('agora o telegram explode');
  ok('Telegram lancando nao impede o Discord', recebidoDiscord.length === 1, `discord=${recebidoDiscord.length}`);
  telegramLanca = false;

  // 7. Nunca lança para quem chamou
  discordLanca = true;
  telegramLanca = true;
  let lancou = false;
  try {
    await notify.espelhar('os dois explodem');
  } catch (e) {
    lancou = true;
  }
  ok('com os dois fora, ainda assim nao lanca', !lancou, lancou ? 'lancou' : 'nao lancou');

  // E o disparo em segundo plano também não derruba o processo
  let derrubou = false;
  try {
    notify.espelharEmSegundoPlano('fogo e fumaca');
    await new Promise((r) => setTimeout(r, 20));
  } catch (e) {
    derrubou = true;
  }
  ok('nem o disparo em segundo plano', !derrubou, derrubou ? 'derrubou' : 'ok');
  discordLanca = false;
  telegramLanca = false;
}

/**
 * A prova que o Matheus pediu em 09/10/2026: "a notificação para o Telegram
 * não deve depender do WhatsApp".
 *
 * Antes, o espelho saía de DENTRO do laço que percorre `notification_settings`
 * — então sem contato com telefone, o grupo não recebia nada, apesar de grupo
 * não ter telefone nenhum.
 */
async function provarIndependenciaDoWhatsApp() {
  dublarCanais = true;
  const notificacoes = require('../services/whatsapp/notifications');

  // Caso 1: NENHUM contato cadastrado. O grupo tem de receber assim mesmo.
  contatosFalsos = [];
  recebidoTelegram = [];
  recebidoDiscord = [];
  await notificacoes.sendSuspendedDomainAlert('user-1', 'semcontatos.com');
  await new Promise((r) => setTimeout(r, 30)); // o espelho é disparado sem await

  ok('sem NENHUM contato, o grupo recebe', recebidoTelegram.length === 1, `telegram=${recebidoTelegram.length}`);
  ok('e o Discord tambem', recebidoDiscord.length === 1, `discord=${recebidoDiscord.length}`);
  ok(
    'com saudacao neutra, nao com nome de pessoa',
    recebidoTelegram[0] && recebidoTelegram[0].m.includes('*Equipe*'),
    recebidoTelegram[0] && recebidoTelegram[0].m.split('\n')[4]
  );

  // Caso 2: VÁRIOS contatos com nomes diferentes. Uma mensagem, não N.
  contatosFalsos = [
    { id: 1, user_id: null, display_name: 'Eduardo', whatsapp_number: '5511999990001' },
    { id: 2, user_id: null, display_name: 'Matheus', whatsapp_number: '5511999990002' },
    { id: 3, user_id: null, display_name: 'William', whatsapp_number: '5511999990003' },
    { id: 4, user_id: null, display_name: 'Rhanna', whatsapp_number: '5511999990004' }
  ];
  recebidoTelegram = [];
  recebidoDiscord = [];
  await notificacoes.sendSuspendedDomainAlert('user-1', 'comcontatos.com');
  await new Promise((r) => setTimeout(r, 30));

  ok('com 4 contatos, o grupo recebe UMA vez', recebidoTelegram.length === 1, `telegram=${recebidoTelegram.length}`);

  // Caso 3: expirado segue a mesma regra.
  contatosFalsos = [];
  recebidoTelegram = [];
  await notificacoes.sendExpiredDomainAlert('user-1', 'expirado-sem-contato.com');
  await new Promise((r) => setTimeout(r, 30));

  ok('expirado sem contato tambem chega', recebidoTelegram.length === 1, `telegram=${recebidoTelegram.length}`);
  ok(
    'e o texto e o de expirado',
    recebidoTelegram[0] && recebidoTelegram[0].m.includes('expirou'),
    recebidoTelegram[0] && recebidoTelegram[0].m.slice(0, 60)
  );
}

(async () => {
  await provarTelegram();
  await provarDistribuidor();
  await provarIndependenciaDoWhatsApp();

  let falhas = 0;
  provas.forEach(({ rot, cond, detalhe }) => {
    if (cond) {
      console.log(`  ok   ${rot}`);
    } else {
      falhas += 1;
      console.log(`  FALHOU  ${rot}  -> ${detalhe}`);
    }
  });

  console.log(
    falhas
      ? `\n${falhas} de ${provas.length} provas FALHARAM\n`
      : `\n${provas.length} provas passaram\n`
  );
  process.exit(falhas ? 1 : 0);
})();
