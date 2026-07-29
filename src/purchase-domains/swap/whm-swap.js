/**
 * SWAP DE DOMÍNIO NO WHM — FASE 2 (OPERAÇÕES DE SERVIDOR)
 * ----------------------------------------------------------------------------
 * Troca o domínio principal de uma conta cPanel JÁ EXISTENTE (modifyacct) para
 * o domínio novo. Como é a MESMA conta, tudo continua onde está — arquivos,
 * mídias, banco de dados, e-mails — e passa a responder pelo domínio novo.
 * Depois disso:
 *   1. reescreve as URLs do WordPress no banco (siteurl/home + conteúdo,
 *      páginas, mídias e dados serializados do Elementor);
 *   2. limpa os caches que guardam o domínio antigo (CSS do Elementor,
 *      wp-content/cache, transients);
 *   3. dispara o AutoSSL para emitir o certificado do domínio novo.
 *
 * NÃO cria conta nova e NÃO apaga dados.
 *
 * Reutiliza EXATAMENTE os mesmos padrões já usados em wordpress-install.js:
 *   - WHM API 1 (json-api) com header  Authorization: whm <user>:<token>
 *   - create_user_session + Fileman/upload_files
 *   - httpsAgent { rejectUnauthorized:false }  (certificado self-signed)
 */

const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/env');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function whmHeaders() {
  return { 'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTAR / ENCONTRAR CONTAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lista todas as contas do WHM com { user, domain, suspended }.
 * @returns {Promise<Array<{user:string, domain:string, suspended:boolean}>>}
 */
async function listWHMAccounts() {
  const response = await axios.get(
    `${config.WHM_URL}/json-api/listaccts?api.version=1`,
    { headers: whmHeaders(), timeout: 30000, httpsAgent }
  );
  const accounts = response.data?.data?.acct || [];
  return accounts.map(a => ({
    user: a.user,
    domain: String(a.domain || '').toLowerCase(),
    suspended: a.suspended === 1 || a.suspended === '1' || a.suspended === true
  }));
}

/**
 * Encontra a conta cujo domínio principal == oldDomain (case-insensitive).
 * @returns {Promise<{user:string, domain:string, suspended:boolean}|null>}
 */
async function findAccountByDomain(oldDomain) {
  const target = String(oldDomain || '').trim().toLowerCase();
  const accounts = await listWHMAccounts();
  return accounts.find(a => a.domain === target) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODIFYACCT (a troca em si)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Troca o domínio principal da conta `username` para `newDomain`.
 */
async function modifyPrimaryDomain(username, newDomain) {
  const params = new URLSearchParams({
    'api.version': '1',
    user: username,
    domain: newDomain
  });
  const response = await axios.get(
    `${config.WHM_URL}/json-api/modifyacct?${params.toString()}`,
    { headers: whmHeaders(), timeout: 120000, httpsAgent }
  );
  const meta = response.data?.metadata || {};
  const ok = meta.result === 1 || meta.result === '1';
  return { success: ok, message: meta.reason || '', raw: response.data };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOSSL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispara o AutoSSL para a conta (emite/renova o certificado do domínio novo).
 */
async function triggerAutoSSL(username) {
  try {
    const params = new URLSearchParams({ 'api.version': '1', username });
    const response = await axios.get(
      `${config.WHM_URL}/json-api/start_autossl_check_for_one_user?${params.toString()}`,
      { headers: whmHeaders(), timeout: 60000, httpsAgent }
    );
    return response.data?.metadata?.result === 1;
  } catch (e) {
    console.error('⚠️ [SWAP] AutoSSL falhou:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSÃO cPANEL + SCRIPT TEMPORÁRIO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria sessão cPanel para a conta e retorna { baseUrl, cpSecurityToken, session }.
 * (mesmo mecanismo do wordpress-install.js)
 */
async function createCpanelSession(username) {
  const sessionResponse = await axios.get(
    `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
    { headers: whmHeaders(), timeout: 30000, httpsAgent }
  );
  const sessionData = sessionResponse.data?.data;
  const cpSecurityToken = sessionData?.cp_security_token;
  if (!cpSecurityToken) throw new Error('Não foi possível criar sessão no cPanel');
  const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
  return { baseUrl, cpSecurityToken, session: sessionData.session };
}

function safeJson(str) {
  try {
    const s = str.indexOf('{');
    const e = str.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    return JSON.parse(str.substring(s, e + 1));
  } catch { return null; }
}

/**
 * Faz o upload do script PHP temporário do swap para o public_html da conta.
 * O MESMO arquivo atende os dois modos (?mode=db e ?mode=cache) e se
 * auto-destrói no último modo.
 */
async function uploadSwapScript({ username, oldDomain, newDomain }) {
  const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
  const publicHtmlPath = `/home/${username}/public_html`;
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 16);
  const phpFileName = `dh-swap-${uniqueId}.php`;
  const token = uuidv4().replace(/-/g, '');

  const phpCode = buildSwapPhp({ oldDomain, newDomain, token });

  const form = new FormData();
  form.append('dir', publicHtmlPath);
  form.append('overwrite', '1');
  form.append('file-0', Buffer.from(phpCode, 'utf8'), {
    filename: phpFileName,
    contentType: 'application/x-php'
  });

  const uploadResponse = await axios.post(
    `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`,
    form,
    { headers: { ...form.getHeaders(), 'Cookie': `cpsession=${session}` }, timeout: 30000, httpsAgent }
  );

  if (uploadResponse.data?.data?.succeeded !== 1) {
    const reason = uploadResponse.data?.data?.uploads?.[0]?.reason || 'desconhecido';
    throw new Error(`Upload do script de correção falhou: ${reason}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  return { baseUrl, phpFileName, token, username, cpSecurityToken, session };
}

/**
 * Executa o script já enviado, no modo pedido.
 * É DNS-independente: bate direto no IP/host do servidor enviando o header
 * `Host` do domínio novo (vhost name-based do Apache), então funciona mesmo
 * antes do DNS propagar.
 */
async function runSwapScript({ baseUrl, phpFileName, token, username, oldDomain, newDomain, cpSecurityToken, session, mode }) {
  // IP/host do servidor (sem a porta), p/ acessar direto sem depender de DNS
  const serverHost = (config.HOSTING_SERVER_IP
    || config.WHM_URL.replace('https://', '').replace(/:\d+$/, '')).trim();
  const q = `?dhtoken=${token}&mode=${mode}`;

  // Ordem das tentativas — da mais confiável para a menos:
  // 1) Userdir pelo IP do servidor com Host do domínio ANTIGO. No momento do
  //    swap o domínio antigo ainda resolve/tem vhost, então o Apache serve o
  //    arquivo que está fisicamente na conta. É o caminho que mais funciona.
  // 2) Pelo domínio ANTIGO direto (DNS dele ainda aponta pro servidor).
  // 3) Pelo domínio novo (caso o DNS já tenha propagado).
  // 4) Userdir pelo IP com Host do domínio novo.
  // 5) Userdir "puro" pelo IP, sem Host (último recurso).
  const attempts = [
    { url: `https://${serverHost}:2083/~${username}/${phpFileName}${q}`, headers: { Host: oldDomain } },
    { url: `https://${oldDomain}/${phpFileName}${q}`, headers: {} },
    { url: `https://${newDomain}/${phpFileName}${q}`, headers: {} },
    { url: `https://${serverHost}:2083/~${username}/${phpFileName}${q}`, headers: { Host: newDomain } },
    { url: `https://${serverHost}:2083/~${username}/${phpFileName}${q}`, headers: {} }
  ];

  let lastErr = null;
  for (const att of attempts) {
    try {
      const resp = await axios.get(att.url, {
        timeout: 180000,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 DomainHub-Swap/1.0',
          'Accept': 'application/json',
          ...(session ? { 'Cookie': `cpsession=${session}` } : {}),
          ...att.headers
        },
        validateStatus: () => true
      });
      const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data;
      if (data && data.ok) return { success: true, result: data };
      lastErr = new Error((data && data.error) || `Resposta inesperada (HTTP ${resp.status})`);
    } catch (e) {
      lastErr = e;
    }
  }
  return { success: false, error: lastErr ? lastErr.message : 'Falha ao executar o script do swap' };
}

/**
 * Gera o PHP temporário do swap.
 *
 * mode=db     → reescreve as URLs do WordPress direto no banco
 * mode=cache  → limpa caches (CSS do Elementor, wp-content/cache, transients)
 *               e apaga o próprio arquivo no final
 *
 * Usa SHORTINIT (carrega só o $wpdb, sem disparar o redirect canônico do WP) e
 * faz um search-replace serialization-safe (não corrompe dados serializados),
 * cobrindo também as barras escapadas do Elementor/JSON.
 */
function buildSwapPhp({ oldDomain, newDomain, token }) {
  return `<?php
header('Content-Type: application/json');
error_reporting(0);
@ini_set('display_errors','0');
@set_time_limit(300);

$__token = ${JSON.stringify(token)};
if ((isset($_GET['dhtoken']) ? $_GET['dhtoken'] : '') !== $__token) {
  http_response_code(403);
  echo json_encode(array('ok'=>false,'error'=>'forbidden'));
  exit;
}

$__mode = isset($_GET['mode']) ? $_GET['mode'] : 'db';
$__old  = strtolower(${JSON.stringify(oldDomain)});
$__new  = strtolower(${JSON.stringify(newDomain)});

// Localiza o wp-load.php (raiz do public_html ou 1 nivel de subpasta)
function dh_find_wpload($base){
  if (file_exists($base.'/wp-load.php')) return $base.'/wp-load.php';
  $items = @scandir($base);
  if (is_array($items)) {
    foreach ($items as $it) {
      if ($it === '.' || $it === '..') continue;
      $p = $base.'/'.$it;
      if (is_dir($p) && file_exists($p.'/wp-load.php')) return $p.'/wp-load.php';
    }
  }
  return null;
}

$__wpload = dh_find_wpload(dirname(__FILE__));
if (!$__wpload) {
  echo json_encode(array('ok'=>false,'error'=>'wp-load.php nao encontrado'));
  if ($__mode === 'cache') { @unlink(__FILE__); }
  exit;
}
$__wproot = dirname($__wpload);

if (!defined('SHORTINIT')) define('SHORTINIT', true);
require $__wpload;

global $wpdb, $table_prefix;
if (!isset($wpdb) || !is_object($wpdb)) {
  echo json_encode(array('ok'=>false,'error'=>'wpdb indisponivel'));
  if ($__mode === 'cache') { @unlink(__FILE__); }
  exit;
}

$prefix = (isset($wpdb->prefix) && $wpdb->prefix) ? $wpdb->prefix : (isset($table_prefix) ? $table_prefix : 'wp_');
$bs = chr(92); // barra invertida

// ═══════════════════════════════ MODO CACHE ═══════════════════════════════
if ($__mode === 'cache') {
  $report = array('ok'=>true,'mode'=>'cache','removed'=>array());

  // 1) Arquivos de cache que guardam URL absoluta do dominio antigo
  function dh_rmfiles($dir,$depth){
    if ($depth < 0 || !is_dir($dir)) return 0;
    $n = 0;
    $items = @scandir($dir);
    if (!is_array($items)) return 0;
    foreach ($items as $it) {
      if ($it === '.' || $it === '..') continue;
      $p = $dir.'/'.$it;
      if (is_dir($p)) { $n += dh_rmfiles($p,$depth-1); @rmdir($p); }
      else { if (@unlink($p)) $n++; }
    }
    return $n;
  }

  $paths = array(
    'elementor_css' => $__wproot.'/wp-content/uploads/elementor/css',
    'wp_cache'      => $__wproot.'/wp-content/cache',
    'uploads_cache' => $__wproot.'/wp-content/uploads/cache'
  );
  foreach ($paths as $k=>$p) {
    $report['removed'][$k] = dh_rmfiles($p, 4);
  }

  // 2) CSS do Elementor guardado no banco (forca regeneracao com a URL nova)
  $wpdb->query("DELETE FROM {$prefix}postmeta WHERE meta_key = '_elementor_css'");
  $wpdb->query("DELETE FROM {$prefix}options WHERE option_name = '_elementor_global_css'");

  // 3) Transients (muitos guardam URL absoluta)
  $wpdb->query("DELETE FROM {$prefix}options WHERE option_name LIKE '\\_transient\\_%'");
  $wpdb->query("DELETE FROM {$prefix}options WHERE option_name LIKE '\\_site\\_transient\\_%'");

  // 4) Rewrite rules (forca o WP a regravar as permalinks no proximo acesso)
  $wpdb->query("UPDATE {$prefix}options SET option_value = '' WHERE option_name = 'rewrite_rules'");

  $report['old'] = $__old;
  $report['new'] = $__new;
  @unlink(__FILE__);
  $report['self_deleted'] = !file_exists(__FILE__);
  echo json_encode($report);
  exit;
}

// ════════════════════════════════ MODO DB ═════════════════════════════════
// Pares de substituicao: http/https, protocolo-relativo, barras escapadas
// (JSON/Elementor) e host puro
$pairs = array();
$pairs['https://'.$__old] = 'https://'.$__new;
$pairs['http://'.$__old]  = 'https://'.$__new;
$pairs['//'.$__old]       = '//'.$__new;
$pairs['https:'.$bs.'/'.$bs.'/'.$__old] = 'https:'.$bs.'/'.$bs.'/'.$__new;
$pairs['http:'.$bs.'/'.$bs.'/'.$__old]  = 'https:'.$bs.'/'.$bs.'/'.$__new;
$pairs[$bs.'/'.$bs.'/'.$__old]          = $bs.'/'.$bs.'/'.$__new;
$pairs[$__old] = $__new;

function dh_has_object($d){ if (is_object($d)) return true; if (is_array($d)){ foreach($d as $v){ if(dh_has_object($v)) return true; } } return false; }
function dh_deep($d,$pairs){ if (is_array($d)){ $o=array(); foreach($d as $k=>$v){ $o[is_string($k)?strtr($k,$pairs):$k]=dh_deep($v,$pairs);} return $o;} if (is_string($d)) return strtr($d,$pairs); return $d; }
function dh_fix($val,$pairs){ if(!is_string($val)) return $val; $un=@unserialize($val); if($un!==false || $val==='b:0;'){ if(dh_has_object($un)) return $val; $re=@serialize(dh_deep($un,$pairs)); return $re===null?$val:$re; } return strtr($val,$pairs); }

$report = array('ok'=>true,'mode'=>'db','updated'=>array(),'total'=>0);
$like = '%'.$wpdb->esc_like($__old).'%';

// 1) siteurl / home (sempre) — para o WordPress deixar de redirecionar ao dominio antigo
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='siteurl'",'https://'.$__new));
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='home'",'https://'.$__new));

// 2) URLs absolutas espalhadas pelo conteudo (paginas, posts, midias, Elementor, etc.)
$targets = array(
  array($prefix.'options','option_id',array('option_value')),
  array($prefix.'posts','ID',array('post_content','post_excerpt','guid')),
  array($prefix.'postmeta','meta_id',array('meta_value')),
  array($prefix.'termmeta','meta_id',array('meta_value')),
  array($prefix.'usermeta','umeta_id',array('meta_value')),
  array($prefix.'comments','comment_ID',array('comment_content')),
  array($prefix.'commentmeta','meta_id',array('meta_value'))
);

foreach($targets as $t){
  $table=$t[0]; $pk=$t[1]; $cols=$t[2];
  $exists = $wpdb->get_var("SHOW TABLES LIKE '".str_replace("'","''",$table)."'");
  if(!$exists) continue;
  $n=0;
  foreach($cols as $col){
    $rows = $wpdb->get_results($wpdb->prepare("SELECT {$pk} AS pk, {$col} AS val FROM {$table} WHERE {$col} LIKE %s",$like));
    if(!$rows) continue;
    foreach($rows as $r){
      $fixed = dh_fix($r->val,$pairs);
      if($fixed !== $r->val){
        $wpdb->query($wpdb->prepare("UPDATE {$table} SET {$col}=%s WHERE {$pk}=%d",$fixed,$r->pk));
        $n++;
      }
    }
  }
  if($n>0){ $report['updated'][$table]=$n; $report['total'] += $n; }
}

$report['old']=$__old; $report['new']=$__new; $report['siteurl']='https://'.$__new;
echo json_encode($report);
exit;
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR DAS OPERAÇÕES DE SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executa o swap completo para uma conta existente.
 * @param {Object} p
 * @param {string} p.oldDomain  domínio antigo (que já existe no WHM)
 * @param {string} p.newDomain  domínio novo (já comprado na fase 1)
 * @param {string} p.sessionId
 * @param {Function} p.updateProgress  (sessionId, step, status, message, domain)
 */
async function swapDomainOnWHM({ oldDomain, newDomain, sessionId, updateProgress }) {
  const up = async (step, status, msg) => {
    if (updateProgress) { try { await updateProgress(sessionId, step, status, msg, newDomain); } catch (_) {} }
  };

  // ═══ 1) Localizar a conta do domínio antigo
  await up('swap_whm', 'in_progress', `Localizando a conta de ${oldDomain} no servidor...`);
  const account = await findAccountByDomain(oldDomain);
  if (!account) {
    await up('swap_whm', 'error', `Conta de ${oldDomain} não encontrada no WHM`);
    return { success: false, error: `Domínio antigo ${oldDomain} não encontrado no WHM` };
  }
  if (account.suspended) {
    await up('swap_whm', 'error', `A conta de ${oldDomain} está suspensa`);
    return { success: false, error: `Conta de ${oldDomain} está suspensa` };
  }

  // ═══ 2) Trocar o domínio principal (modifyacct)
  await up('swap_whm', 'in_progress', `Modificando a conta ${account.user} no WHM: ${oldDomain} → ${newDomain}...`);
  const mod = await modifyPrimaryDomain(account.user, newDomain);
  if (!mod.success) {
    await up('swap_whm', 'error', `Falha ao trocar o domínio no WHM: ${mod.message}`);
    return { success: false, error: mod.message || 'modifyacct falhou' };
  }
  await up('swap_whm', 'completed', `Conta ${account.user} agora responde por ${newDomain}`);

  // aguardar o WHM reconstruir o vhost/config do Apache
  await new Promise(r => setTimeout(r, 8000));

  // ═══ 3) Enviar o script temporário para dentro da conta
  let uploaded = null;
  try {
    uploaded = await uploadSwapScript({ username: account.user, oldDomain, newDomain });
  } catch (e) {
    await up('swap_database', 'error',
      `Domínio trocado, mas não foi possível preparar o ajuste do WordPress (${e.message}).`);
    return { success: true, partial: true, username: account.user, oldDomain, newDomain, wordpressFixed: false };
  }

  // ═══ 4) Banco de dados do WordPress (siteurl/home + páginas + mídias + Elementor)
  await up('swap_database', 'in_progress', `Apontando o banco de dados do WordPress para ${newDomain}...`);
  const db = await runSwapScript({ ...uploaded, oldDomain, newDomain, mode: 'db' });
  if (db.success) {
    const total = db.result?.total || 0;
    await up('swap_database', 'completed',
      `Banco atualizado: ${total} registro(s) reapontados para ${newDomain}`);
  } else {
    // Não derruba o swap: o domínio JÁ foi reapontado. Apenas avisa.
    await up('swap_database', 'error',
      `Domínio trocado, mas a correção automática do WordPress falhou (${db.error}). ` +
      `As URLs internas podem precisar de ajuste manual.`);
  }

  // ═══ 5) Cache (CSS do Elementor, wp-content/cache, transients) + apaga o script
  await up('swap_media', 'in_progress', `Limpando cache de páginas, mídias e Elementor...`);
  const cache = await runSwapScript({ ...uploaded, oldDomain, newDomain, mode: 'cache' });
  if (cache.success) {
    await up('swap_media', 'completed', `Cache limpo — páginas e mídias servindo por ${newDomain}`);
  } else {
    await up('swap_media', 'error',
      `Cache não pôde ser limpo automaticamente (${cache.error}). Limpe o cache do site se algo aparecer quebrado.`);
  }

  // ═══ 6) SSL
  await up('swap_ssl', 'in_progress', `Emitindo certificado SSL para ${newDomain}...`);
  await triggerAutoSSL(account.user);
  await up('swap_ssl', 'completed', `SSL solicitado para ${newDomain}`);

  return {
    success: true,
    username: account.user,
    oldDomain,
    newDomain,
    wordpressFixed: !!db.success,
    cacheCleared: !!cache.success
  };
}

module.exports = {
  swapDomainOnWHM,
  listWHMAccounts,
  findAccountByDomain,
  modifyPrimaryDomain,
  uploadSwapScript,
  runSwapScript,
  triggerAutoSSL
};
