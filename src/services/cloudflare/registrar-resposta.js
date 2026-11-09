/**
 * LEITURA DAS RESPOSTAS DO CLOUDFLARE REGISTRAR
 *
 * Função pura, SEM NENHUMA DEPENDÊNCIA — nem `config`, nem `axios`. Mora
 * separada de `registrar.js` por isso: `config/env` lança quando falta
 * variável de ambiente, e provar o formato de uma resposta não pode exigir
 * as credenciais de produção.
 *
 * É o mesmo arranjo de `namecheap/pricing-xml.js` e `purchase-domains/tld.js`,
 * e pela mesma razão. Esta é a TERCEIRA vez no projeto que o parser nasceu
 * junto do I/O e precisou ser separado para poder ser testado.
 *
 * As provas estão em `src/scripts/testa-sonda-registrar.js`.
 */

/**
 * LÊ A RESPOSTA DO `domain-check`. Função pura, sem rede.
 *
 * Separada do I/O pelo mesmo motivo que o leitor de XML da Namecheap: o que
 * quebra aqui é o FORMATO, e provar formato não pode exigir credencial nem
 * interceptar `axios`.
 *
 * E este parser já errou. A primeira versão supôs quatro nomes de campo e
 * acertou zero:
 *
 *   enviava `domain_names`      era `domains`
 *   lia `result`                era `result.domains`
 *   lia `available`             era `registrable`
 *   lia `price` / `fees`        era `pricing.registration_cost`, em STRING
 *
 * As provas estão em `src/scripts/testa-sonda-registrar.js`.
 */
function interpretar(resposta, nome, teto) {
  if (!resposta?.success) {
    const erros = (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`);
    return {
      ok: false,
      erro: erros.length ? erros.join(' · ') : 'Resposta sem sucesso e sem erro declarado',
      bruto: resposta,
    };
  }

  // `result.domains`, não `result` direto. A resposta pode OMITIR nomes
  // malformados, então procurar pelo nome é mais seguro que pegar o
  // primeiro.
  const lista = resposta?.result?.domains ?? [];
  const achado = lista.find((d) => d?.name === nome) ?? lista[0] ?? null;

  const preco = achado?.pricing ?? null;
  // Os valores vêm como STRING. Converter aqui, uma vez, em vez de deixar
  // quem lê descobrir isso comparando texto com número.
  const num = (v) => (v == null ? null : Number(v));
  const registro = num(preco?.registration_cost);

  return {
    ok: true,
    dominio: nome,

    // `registrable` responde direto a pergunta que motivou a sonda: dá para
    // registrar ISTO por API?
    registravelPorApi: achado?.registrable ?? null,

    // Distingue casos com conclusões OPOSTAS:
    //   domain_unavailable              nome tomado, tente outro
    //   extension_not_supported_via_api existe no painel, não na API --
    //                                   isto mata a compra automática
    //   domain_premium                  premium, a API não registra
    motivo: achado?.reason ?? null,

    // Propriedade do NOME, não da terminação: um `.com` qualquer serve, um
    // `.com` curto e cobiçado é premium e a API recusa.
    tier: achado?.tier ?? null,

    registroUsd: registro,
    renovacaoUsd: num(preco?.renewal_cost),
    moeda: preco?.currency ?? null,

    // O teto é sobre o REGISTRO, que é o que a compra paga na hora.
    tetoDaCompraPorIA: teto,
    passaNoTeto: registro === null ? null : registro <= teto,

    bruto: achado,
  };
}

/**
 * Estados em que o registro não muda mais sozinho.
 *
 * `action_required` e `blocked` entram aqui de propósito: não são sucesso nem
 * falha, mas a documentação manda parar e mostrar para a pessoa, porque eles
 * não se resolvem esperando.
 */
const ESTADOS_FINAIS = new Set(['succeeded', 'failed', 'action_required', 'blocked']);

/**
 * LÊ A RESPOSTA DE `POST /registrations` E DE `registration-status`.
 *
 * As duas devolvem o mesmo `WorkflowStatus`. Função pura, sem rede.
 */
function interpretarRegistro(resposta) {
  const r = resposta?.result;
  if (!resposta?.success || !r) {
    const erros = (resposta?.errors || []).map((e) => `${e.code}: ${e.message}`);
    return {
      ok: false,
      erro: erros.length ? erros.join(' · ') : 'Resposta sem sucesso e sem erro declarado',
      bruto: resposta,
    };
  }

  const registro = r.context?.registration ?? null;

  return {
    ok: true,
    estado: r.state ?? null,
    terminou: ESTADOS_FINAIS.has(r.state),
    registrado: r.state === 'succeeded',
    expiraEm: registro?.expires_at ?? null,
    renovacaoAutomatica: registro?.auto_renew ?? null,
    erro: r.error ? `${r.error.code}: ${r.error.message}` : null,
    // Em `action_required`, é aqui que a Cloudflare diz o que falta fazer.
    acao: r.context?.action ?? null,
    bruto: r,
  };
}

/** Nome em minúsculo se for um `.com` bem formado; senão `null`. */
function nomeCom(dominio) {
  const nome = String(dominio ?? '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.com$/.test(nome) ? nome : null;
}

/**
 * O PEDIDO FAZ SENTIDO? Roda antes de qualquer chamada à Cloudflare.
 *
 * `confirmar` precisa repetir o domínio: esta rota gasta dinheiro sem
 * reembolso, e um valor colado errado não pode bastar para isso.
 */
function motivoParaRecusarPedido(dominio, confirmar) {
  const nome = nomeCom(dominio);
  if (!nome) return `Só aceita um domínio .com válido. Recebido: ${dominio}`;
  if (nomeCom(confirmar) !== nome) return 'O campo `confirmar` precisa repetir o domínio, igual.';
  return null;
}

/**
 * A CONSULTA DE AGORA LIBERA A COMPRA?
 *
 * Recebe o que `sondar()` devolveu. Tudo que não for um "sim" claro recusa:
 * nesta função, dúvida custa uma nova tentativa, e o contrário custa dinheiro.
 */
function motivoParaRecusarConsulta(consulta, teto) {
  if (!consulta?.configurado) return 'Conta do Registrar não configurada no Render.';
  if (!consulta.ok) return `A consulta falhou: ${consulta.erro}`;
  if (consulta.registravelPorApi !== true) {
    return `A Cloudflare não libera este registro: ${consulta.motivo ?? 'motivo não informado'}`;
  }
  if (consulta.tier !== 'standard') return `Só compra nome comum. Veio: ${consulta.tier}`;
  if (consulta.moeda !== 'USD') return `Só compra em dólar. Veio: ${consulta.moeda}`;
  if (!(consulta.registroUsd > 0)) return `Preço inválido: ${consulta.registroUsd}`;
  if (consulta.registroUsd > teto) {
    return `US$ ${consulta.registroUsd} passa do teto do teste, US$ ${teto}.`;
  }
  return null;
}

/**
 * O APONTAMENTO ESTÁ DE PÉ?
 *
 * `pronto` só é verdadeiro com a zona, o Custom Hostname e o certificado
 * ativos: é a prova de que zona numa conta e Custom Hostname na outra
 * funcionam juntos, que é a pergunta deste teste.
 */
function resumirApontamento(zona, hostname, registro, alvo) {
  const erros = [
    ...(hostname?.verification_errors ?? []),
    ...(hostname?.ssl?.validation_errors ?? []).map((e) => e?.message ?? String(e)),
  ];

  return {
    pronto: zona?.status === 'active'
      && hostname?.status === 'active'
      && hostname?.ssl?.status === 'active'
      && registro?.content === alvo,
    zona: {
      id: zona?.id ?? null,
      status: zona?.status ?? null,
      conta: zona?.account?.id ?? null,
      nameservers: zona?.name_servers ?? [],
    },
    customHostname: {
      status: hostname?.status ?? null,
      certificado: hostname?.ssl?.status ?? null,
      erros,
    },
    apontamento: {
      destino: registro?.content ?? null,
      // Proxy ligado na zona nova mudaria o caminho do tráfego.
      proxied: registro?.proxied ?? null,
    },
  };
}

module.exports = {
  interpretar,
  interpretarRegistro,
  nomeCom,
  motivoParaRecusarPedido,
  motivoParaRecusarConsulta,
  resumirApontamento,
};
