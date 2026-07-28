/**
 * SWAP DE DOMÍNIO NO WHM
 * ----------------------------------------------------------------------------
 * Troca o domínio principal de uma conta cPanel JÁ EXISTENTE (modifyacct) para
 * o domínio novo, trazendo tudo junto (arquivos, banco, WordPress). Depois:
 *   - corrige as URLs do WordPress (siteurl/home + URLs absolutas no conteúdo,
 *     incluindo mídias e páginas do Elementor);
 *   - dispara o AutoSSL para emitir o certificado do novo domínio.
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
 * Dispara o AutoSSL para a conta (emite/renova o certificado do novo domínio).
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
// CORREÇÃO DAS URLs DO WORDPRESS
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
 * Corrige as URLs do WordPress após a troca de domínio:
 *   - siteurl / home
 *   - URLs absolutas no conteúdo (posts, meta, Elementor, mídias)
 *
 * Faz upload de um script PHP temporário (auto-destrutivo) via Fileman e o
 * executa por HTTP. É DNS-independente: bate direto no IP/host do servidor
 * enviando o header `Host` do novo domínio (roteamento por name-based vhost do
 * Apache), então funciona mesmo antes do DNS propagar.
 */
async function fixWordPressUrls({ username, oldDomain, newDomain }) {
  const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
  const publicHtmlPath = `/home/${username}/public_html`;
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 16);
  const phpFileName = `dh-swap-${uniqueId}.php`;
  const token = uuidv4().replace(/-/g, '');

  const phpCode = buildWpFixPhp({ oldDomain, newDomain, token });

  // 1) Upload do script (Fileman/upload_files — idêntico ao wordpress-install.js)
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

  // 2) Executar o script.
  const serverHost = (config.HOSTING_SERVER_IP
    || config.WHM_URL.replace('https://', '').replace(/:\d+$/, '')).trim();
  const q = `?dhtoken=${token}`;

  const attempts = [
    // (a) Direto no servidor + header Host  → DNS-independente (caminho principal)
    { url: `https://${serverHost}/${phpFileName}${q}`, headers: { Host: newDomain } },
    // (b) Pelo novo domínio (caso o DNS já tenha propagado)
    { url: `https://${newDomain}/${phpFileName}${q}`, headers: {} },
    // (c) Userdir do cPanel + header Host (fallback usado no resto do sistema)
    { url: `${baseUrl}/~${username}/${phpFileName}${q}`, headers: { Host: newDomain } }
  ];

  let lastErr = null;
  for (const att of attempts) {
    try {
      const resp = await axios.get(att.url, {
        timeout: 120000,
        httpsAgent,
        headers: { 'User-Agent': 'DomainHub-Swap/1.0', 'Accept': 'application/json', ...att.headers },
        validateStatus: () => true
      });
      const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data;
      if (data && data.ok) return { success: true, result: data };
      lastErr = new Error((data && data.error) || `Resposta inesperada (HTTP ${resp.status})`);
    } catch (e) {
      lastErr = e;
    }
  }
  return { success: false, error: lastErr ? lastErr.message : 'Falha ao executar a correção do WordPress' };
}

/**
 * Gera o PHP temporário que corrige as URLs do WordPress diretamente no banco.
 * Usa SHORTINIT (carrega só o $wpdb, sem disparar o redirect canônico do WP) e
 * faz um search-replace serialization-safe (não corrompe dados serializados),
 * cobrindo também as barras escapadas do Elementor/JSON.
 */
function buildWpFixPhp({ oldDomain, newDomain, token }) {
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

$__old = strtolower(${JSON.stringify(oldDomain)});
$__new = strtolower(${JSON.stringify(newDomain)});

$__wpload = dirname(__FILE__) . '/wp-load.php';
if (!file_exists($__wpload)) { echo json_encode(array('ok'=>false,'error'=>'wp-load.php nao encontrado')); @unlink(__FILE__); exit; }

if (!defined('SHORTINIT')) define('SHORTINIT', true);
require $__wpload;

global $wpdb, $table_prefix;
if (!isset($wpdb) || !is_object($wpdb)) { echo json_encode(array('ok'=>false,'error'=>'wpdb indisponivel')); @unlink(__FILE__); exit; }

$prefix = (isset($wpdb->prefix) && $wpdb->prefix) ? $wpdb->prefix : (isset($table_prefix) ? $table_prefix : 'wp_');
$bs = chr(92); // barra invertida

// Pares de substituicao: http/https, protocolo-relativo, barras escapadas (JSON/Elementor) e host puro
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

$report = array('ok'=>true,'updated'=>array());
$like = '%'.$wpdb->esc_like($__old).'%';

// 1) siteurl / home (sempre) — para o WordPress deixar de redirecionar ao dominio antigo
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='siteurl'",'https://'.$__new));
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='home'",'https://'.$__new));

// 2) URLs absolutas espalhadas pelo conteudo (paginas, posts, mídias, Elementor, etc.)
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
  if($n>0) $report['updated'][$table]=$n;
}

$report['old']=$__old; $report['new']=$__new; $report['siteurl']='https://'.$__new;
@unlink(__FILE__);
$report['self_deleted'] = !file_exists(__FILE__);
echo json_encode($report);
exit;
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRADOR DO SWAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executa o swap completo para uma conta existente.
 * @param {Object} p
 * @param {string} p.oldDomain  domínio antigo (que já existe no WHM)
 * @param {string} p.newDomain  domínio novo (já comprado)
 * @param {string} p.sessionId
 * @param {Function} p.updateProgress  (sessionId, step, status, message, domain)
 */
async function swapDomainOnWHM({ oldDomain, newDomain, sessionId, updateProgress }) {
  const up = async (step, status, msg) => {
    if (updateProgress) { try { await updateProgress(sessionId, step, status, msg, newDomain); } catch (_) {} }
  };

  // 1) Localizar a conta do domínio antigo
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

  // 2) Trocar o domínio principal (modifyacct)
  await up('swap_whm', 'in_progress', `Reapontando ${oldDomain} → ${newDomain} no servidor...`);
  const mod = await modifyPrimaryDomain(account.user, newDomain);
  if (!mod.success) {
    await up('swap_whm', 'error', `Falha ao trocar o domínio no WHM: ${mod.message}`);
    return { success: false, error: mod.message || 'modifyacct falhou' };
  }
  await up('swap_whm', 'completed', `Domínio reapontado (conta ${account.user})`);

  // aguardar o WHM reconstruir o vhost/config do Apache
  await new Promise(r => setTimeout(r, 8000));

  // 3) Corrigir as URLs do WordPress (siteurl/home + conteúdo/mídias)
  await up('swap_wordpress', 'in_progress', `Ajustando o WordPress para ${newDomain}...`);
  let wp = { success: false, error: 'não executado' };
  try {
    wp = await fixWordPressUrls({ username: account.user, oldDomain, newDomain });
  } catch (e) {
    wp = { success: false, error: e.message };
  }
  if (wp.success) {
    await up('swap_wordpress', 'completed', `WordPress e mídias atualizados para ${newDomain}`);
  } else {
    // Não derruba o swap: o domínio JÁ foi reapontado. Apenas avisa.
    await up('swap_wordpress', 'error',
      `Domínio trocado, mas a correção automática do WordPress falhou (${wp.error}). ` +
      `As URLs internas podem precisar de ajuste manual.`);
  }

  // 4) SSL
  await up('swap_ssl', 'in_progress', `Emitindo certificado SSL para ${newDomain}...`);
  await triggerAutoSSL(account.user);
  await up('swap_ssl', 'completed', `SSL solicitado para ${newDomain}`);

  return { success: true, username: account.user, oldDomain, newDomain, wordpressFixed: wp.success };
}

module.exports = {
  swapDomainOnWHM,
  listWHMAccounts,
  findAccountByDomain,
  modifyPrimaryDomain,
  fixWordPressUrls,
  triggerAutoSSL
};
