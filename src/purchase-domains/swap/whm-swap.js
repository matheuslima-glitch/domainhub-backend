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

// Mesmo caminho já usado em services/domain-deactivation
const SOFTACULOUS_PATH = '/frontend/jupiter/softaculous/index.live.php';

/**
 * Host "puro" do servidor (sem esquema, porta ou caminho) para as chamadas
 * DNS-independentes direto no Apache.
 */
function getServerHost() {
  const fromIp = String(config.HOSTING_SERVER_IP || '').trim();
  if (fromIp) return fromIp.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  return String(config.WHM_URL || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '');
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
  return accounts.map(a => {
    const partition = String(a.partition || 'home').replace(/[^A-Za-z0-9_-]/g, '') || 'home';
    return {
      user: a.user,
      domain: String(a.domain || '').toLowerCase(),
      suspended: a.suspended === 1 || a.suspended === '1' || a.suspended === true,
      homedir: `/${partition}/${a.user}`
    };
  });
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
async function uploadSwapScript({ username, oldDomain, newDomain, homedir = null }) {
  const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
  const home = homedir || `/home/${username}`;
  const publicHtmlPath = `${home}/public_html`;
  const uniqueId = uuidv4().replace(/-/g, '').substring(0, 16);
  const phpFileName = `dh-swap-${uniqueId}.php`;
  const token = uuidv4().replace(/-/g, '');

  const phpCode = buildSwapPhp({ oldDomain, newDomain, token, homedir: home });

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

  return { baseUrl, phpFileName, token, username, homedir: home, cpSecurityToken, session };
}

/**
 * Executa o script já enviado, no modo pedido.
 * É DNS-independente: bate direto no IP/host do servidor enviando o header
 * `Host` do domínio novo (vhost name-based do Apache), então funciona mesmo
 * antes do DNS propagar.
 */
async function runSwapScript({ baseUrl, phpFileName, token, username, oldDomain, newDomain, cpSecurityToken, session, mode }) {
  // IP/host do servidor (sem a porta), p/ acessar direto sem depender de DNS
  const serverHost = getServerHost();
  const q = `?dhtoken=${token}&mode=${mode}`;

  // Ordem das tentativas — da mais confiável para a menos:
  // 1) Apache 443 direto no IP com Host do domínio NOVO (vhost já é o novo
  //    após o modifyacct). DNS-independente: é o caminho que sempre funciona.
  // 2) Apache 80 direto no IP com Host do domínio novo (caso o 443 recuse).
  // 3) Pelo domínio novo via DNS/Cloudflare (se já propagou).
  // 4) Apache 443 no IP com Host do domínio ANTIGO (janela rara em que o
  //    vhost antigo ainda não foi reconstruído).
  // 5) Pelo domínio antigo (último recurso).
  // Nenhuma tentativa envia o cookie da sessão cPanel: são requisições web
  // públicas protegidas pelo token — o cookie não é necessário e não deve
  // trafegar pela Cloudflare.
  const attempts = [
    { url: `https://${serverHost}/${phpFileName}${q}`, headers: { Host: newDomain }, timeout: 300000 },
    { url: `http://${serverHost}/${phpFileName}${q}`,  headers: { Host: newDomain }, timeout: 300000 },
    { url: `https://${newDomain}/${phpFileName}${q}`,  headers: {},                  timeout: 180000 },
    { url: `https://${serverHost}/${phpFileName}${q}`, headers: { Host: oldDomain }, timeout: 90000 },
    { url: `https://${oldDomain}/${phpFileName}${q}`,  headers: {},                  timeout: 90000 }
  ];

  let lastErr = null;
  for (const att of attempts) {
    try {
      const resp = await axios.get(att.url, {
        timeout: att.timeout,
        httpsAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 DomainHub-Swap/1.0',
          'Accept': 'application/json',
          ...att.headers
        },
        maxRedirects: 5,
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
 * Neutraliza o script temporário caso o modo `cache` (que se auto-destrói)
 * não tenha conseguido rodar: sobrescreve o arquivo com um PHP inerte via
 * Fileman, para nada executável ficar para trás no public_html.
 */
async function neutralizeSwapScript({ username, phpFileName, homedir = null }) {
  try {
    const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
    const publicHtmlPath = `${homedir || `/home/${username}`}/public_html`;

    const form = new FormData();
    form.append('dir', publicHtmlPath);
    form.append('overwrite', '1');
    form.append('file-0', Buffer.from('<?php http_response_code(410); exit;', 'utf8'), {
      filename: phpFileName,
      contentType: 'application/x-php'
    });

    await axios.post(
      `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`,
      form,
      { headers: { ...form.getHeaders(), 'Cookie': `cpsession=${session}` }, timeout: 20000, httpsAgent }
    );
    console.log(`🧹 [SWAP] Script temporário ${phpFileName} neutralizado`);
    return true;
  } catch (e) {
    console.error('⚠️ [SWAP] Não foi possível neutralizar o script temporário:', e.message);
    return false;
  }
}

/**
 * Lista as instalações WordPress do Softaculous da conta (somente leitura).
 * Usada para VERIFICAR, depois do modo `soft`, se algum registro ainda
 * aponta para o domínio antigo (é dessa listagem que o botão de Login do
 * Softaculous tira a URL).
 */
async function listSoftaculousInstallations(username) {
  const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
  const url = `${baseUrl}${cpSecurityToken}${SOFTACULOUS_PATH}?act=installations&soft=26&api=json`;
  const response = await axios.get(url, {
    headers: { 'Cookie': `cpsession=${session}` },
    timeout: 30000,
    httpsAgent
  });
  const byScript = response.data?.installations || {};
  const records = [];
  for (const scriptId of Object.keys(byScript)) {
    const group = byScript[scriptId] || {};
    for (const insid of Object.keys(group)) {
      records.push({ insid, ...group[insid] });
    }
  }
  return records;
}

/**
 * Confere se algum registro do Softaculous ainda cita o domínio antigo.
 * Best-effort: se a listagem falhar, devolve { checked:false }.
 */
async function verifySoftaculousSwap({ username, oldDomain }) {
  try {
    const records = await listSoftaculousInstallations(username);
    const old = String(oldDomain || '').toLowerCase();
    const stale = records.filter(r => JSON.stringify(r).toLowerCase().includes(old));
    return { checked: true, total: records.length, stale: stale.length, staleIds: stale.map(r => r.insid) };
  } catch (e) {
    return { checked: false, error: e.message };
  }
}

/**
 * Gera o PHP temporário do swap.
 *
 * mode=db     → reescreve as URLs do WordPress direto no banco, em TODAS as
 *               tabelas com o prefixo do WP (core + plugins), de forma
 *               serialization-safe, case-insensitive e em passada única
 *               (sem re-substituição — seguro mesmo quando o domínio novo
 *               contém o antigo), cobrindo http/https, protocolo-relativo,
 *               barras escapadas (JSON/Elementor), url-encoded e host puro
 *   mode=soft → reescreve os registros do Softaculous
 *               (~/.softaculous/installations.json — PHP-serializado; o
 *               re-serialize recalcula sozinho o s:N com o número de
 *               caracteres do domínio novo) + wp-config.php + .htaccess
 * mode=cache  → limpa caches (CSS do Elementor, wp-content/cache, LiteSpeed,
 *               transients) e apaga o próprio arquivo no final
 *
 * Usa SHORTINIT (carrega só o $wpdb, sem disparar o redirect canônico do WP).
 * O modo `soft` nem carrega o WordPress: mexe apenas em arquivos.
 */
function buildSwapPhp({ oldDomain, newDomain, token, homedir }) {
  return `<?php
header('Content-Type: application/json');
error_reporting(0);
@ini_set('display_errors','0');
@set_time_limit(600);
@ini_set('memory_limit','512M');

$__token = ${JSON.stringify(token)};
if ((isset($_GET['dhtoken']) ? $_GET['dhtoken'] : '') !== $__token) {
  http_response_code(403);
  echo json_encode(array('ok'=>false,'error'=>'forbidden'));
  exit;
}

$__mode = isset($_GET['mode']) ? $_GET['mode'] : 'db';
$__old  = strtolower(${JSON.stringify(oldDomain)});
$__new  = strtolower(${JSON.stringify(newDomain)});
$__home = ${JSON.stringify(homedir || '')};
if (!$__home) { $__home = getenv('HOME'); }
if (!$__home) { $__home = dirname(dirname(__FILE__)); }
$__home = rtrim($__home, '/');

$bs = chr(92); // barra invertida
$pc = chr(37); // sinal de porcentagem (url-encoding)

// ─── Pares de substituição: http/https, protocolo-relativo, barras escapadas
//     (JSON/Elementor), url-encoded e host puro. O http antigo vira https novo.
$pairs = array();
$pairs['https://'.$__old] = 'https://'.$__new;
$pairs['http://'.$__old]  = 'https://'.$__new;
$pairs['//'.$__old]       = '//'.$__new;
$pairs['https:'.$bs.'/'.$bs.'/'.$__old] = 'https:'.$bs.'/'.$bs.'/'.$__new;
$pairs['http:'.$bs.'/'.$bs.'/'.$__old]  = 'https:'.$bs.'/'.$bs.'/'.$__new;
$pairs[$bs.'/'.$bs.'/'.$__old]          = $bs.'/'.$bs.'/'.$__new;
$pairs['https'.$pc.'3A'.$pc.'2F'.$pc.'2F'.$__old] = 'https'.$pc.'3A'.$pc.'2F'.$pc.'2F'.$__new;
$pairs['http'.$pc.'3A'.$pc.'2F'.$pc.'2F'.$__old]  = 'https'.$pc.'3A'.$pc.'2F'.$pc.'2F'.$__new;
$pairs[$pc.'2F'.$pc.'2F'.$__old]                  = $pc.'2F'.$pc.'2F'.$__new;
$pairs[str_replace('.', $bs.'.', $__old)]         = str_replace('.', $bs.'.', $__new); // pontos escapados (regex de .htaccess)
$pairs[$__old] = $__new;

// Padrão único, case-insensitive, do MAIOR para o menor. preg_replace_callback
// varre a string original em passada única: o texto já substituído NUNCA é
// re-substituído (seguro até quando o domínio novo contém o antigo). As
// bordas (lookbehind/lookahead) impedem casar o dominio antigo DENTRO de um
// hostname maior (ex.: "meusite.com" quando o antigo é "site.com"), o que
// tambem torna a substituicao idempotente.
$__keys = array_keys($pairs);
usort($__keys, function($a,$b){ return strlen($b) - strlen($a); });
$__alts = array();
$__map  = array();
foreach ($__keys as $k) { $__alts[] = preg_quote($k, '/'); $__map[strtolower($k)] = $pairs[$k]; }
$GLOBALS['dh_map'] = $__map;
$GLOBALS['dh_rx']  = '/(?<![A-Za-z0-9-])(?:'.implode('|', $__alts).')(?![A-Za-z0-9])/i';

function dh_rep($s) {
  if (!is_string($s) || $s === '') return $s;
  return preg_replace_callback($GLOBALS['dh_rx'], function($m){
    $k = strtolower($m[0]);
    return isset($GLOBALS['dh_map'][$k]) ? $GLOBALS['dh_map'][$k] : $m[0];
  }, $s);
}
function dh_has_object($d){ if (is_object($d)) return true; if (is_array($d)){ foreach($d as $v){ if(dh_has_object($v)) return true; } } return false; }
function dh_deep($d){ if (is_array($d)){ $o=array(); foreach($d as $k=>$v){ $o[is_string($k)?dh_rep($k):$k]=dh_deep($v);} return $o;} if (is_string($d)) return dh_rep($d); return $d; }
function dh_fix($val,&$objSkipped){
  if(!is_string($val)) return $val;
  $un=@unserialize($val);
  if($un!==false || $val==='b:0;'){
    if(dh_has_object($un)){ $objSkipped++; return $val; }
    $re=@serialize(dh_deep($un));
    return $re===null?$val:$re;
  }
  return dh_rep($val);
}

// Substitui o domínio em um arquivo de texto (wp-config, .htaccess...):
// backup + escrita atômica (tmp + rename) preservando as permissões.
function dh_fix_file($path,&$report,$label){
  if (!is_file($path) || !is_readable($path)) return;
  $c = @file_get_contents($path);
  if ($c === false || $c === '') return;
  $n = dh_rep($c);
  if ($n === $c) return;
  $perms = @fileperms($path);
  @copy($path, $path.'.dh-bak');
  $tmp = $path.'.dh-tmp';
  if (@file_put_contents($tmp, $n, LOCK_EX) === false) { $report['files'][$label] = 'falha_escrita'; return; }
  if (!@rename($tmp, $path)) { @unlink($tmp); $report['files'][$label] = 'falha_rename'; return; }
  if ($perms !== false) { @chmod($path, $perms & 0777); }
  $report['files'][$label] = 'atualizado';
}

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
$__wproot = $__wpload ? dirname($__wpload) : dirname(__FILE__);

// ══════════════════════════════ MODO SOFT ═════════════════════════════════
// Registros do Softaculous + wp-config.php + .htaccess. NAO carrega o
// WordPress (mexe so em arquivos), entao roda mesmo sem wp-load.
if ($__mode === 'soft') {
  $report = array('ok'=>true,'mode'=>'soft','softaculous'=>array('status'=>'not_found'),'files'=>array());

  // 1) ~/.softaculous/installations.json — arquivo PHP-SERIALIZADO onde o
  //    Softaculous guarda softdomain/softurl de cada instalacao. E daqui que
  //    o botao de Login tira a URL. O serialize() no final recalcula o s:N
  //    (numero de caracteres) do dominio novo automaticamente.
  $sf = $__home.'/.softaculous/installations.json';
  if (is_file($sf) && is_readable($sf)) {
    $raw = @file_get_contents($sf);
    if ($raw !== false && $raw !== '') {
      $before = substr_count(strtolower($raw), $__old);
      $wasSerialized = false; $wasJson = false;
      $data = @unserialize($raw);
      if ($data !== false || trim($raw) === 'b:0;') { $wasSerialized = true; }
      if (!$wasSerialized) {
        $j = json_decode($raw, true);
        if (is_array($j)) { $data = $j; $wasJson = true; }
      }
      if (($wasSerialized || $wasJson) && is_array($data)) {
        if (dh_has_object($data)) {
          $report['softaculous'] = array('status'=>'skipped_object','occurrences'=>$before);
        } else if ($before === 0) {
          $report['softaculous'] = array('status'=>'nothing_to_do','occurrences'=>0);
        } else if (!is_writable($sf)) {
          $report['softaculous'] = array('status'=>'not_writable','occurrences'=>$before);
        } else {
          $fixed = dh_deep($data);
          $out = $wasSerialized ? serialize($fixed) : json_encode($fixed);
          $perms = @fileperms($sf);
          @copy($sf, $sf.'.dh-bak');
          $tmp = $sf.'.dh-tmp';
          $okw = (@file_put_contents($tmp, $out, LOCK_EX) !== false) && @rename($tmp, $sf);
          if (!$okw) { @unlink($tmp); }
          if ($perms !== false) { @chmod($sf, $perms & 0777); }
          $check = @file_get_contents($sf);
          $after = ($check === false) ? -1 : substr_count(strtolower($check), $__old);
          $report['softaculous'] = array(
            'status' => ($okw && $after === 0) ? 'updated' : 'partial',
            'occurrences' => $before,
            'remaining' => $after,
            'format' => $wasSerialized ? 'serialized' : 'json'
          );
        }
      } else {
        $report['softaculous'] = array('status'=>'unreadable_format');
      }
    }
  }

  // 2) wp-config.php (na raiz do WP ou um nivel acima) e .htaccess
  dh_fix_file($__wproot.'/wp-config.php', $report, 'wp-config.php');
  dh_fix_file(dirname($__wproot).'/wp-config.php', $report, 'wp-config.php (nivel acima)');
  dh_fix_file($__wproot.'/.htaccess', $report, '.htaccess');
  if (dirname(__FILE__) !== $__wproot) {
    dh_fix_file(dirname(__FILE__).'/.htaccess', $report, '.htaccess (public_html)');
  }

  $report['old']=$__old; $report['new']=$__new;
  echo json_encode($report);
  exit;
}

// Para os modos db/cache o WordPress precisa existir
if (!$__wpload) {
  echo json_encode(array('ok'=>false,'error'=>'wp-load.php nao encontrado'));
  if ($__mode === 'cache') { @unlink(__FILE__); }
  exit;
}

if (!defined('SHORTINIT')) define('SHORTINIT', true);
require $__wpload;

global $wpdb, $table_prefix;
if (!isset($wpdb) || !is_object($wpdb)) {
  echo json_encode(array('ok'=>false,'error'=>'wpdb indisponivel'));
  if ($__mode === 'cache') { @unlink(__FILE__); }
  exit;
}

$prefix = (isset($wpdb->prefix) && $wpdb->prefix) ? $wpdb->prefix : (isset($table_prefix) ? $table_prefix : 'wp_');

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
    'uploads_cache' => $__wproot.'/wp-content/uploads/cache',
    'litespeed'     => $__wproot.'/wp-content/litespeed'
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
$report = array('ok'=>true,'mode'=>'db','updated'=>array(),'total'=>0,'skipped_objects'=>0,'skipped_tables'=>array());
$like = '%'.$wpdb->esc_like($__old).'%';
$objSkipped = 0;

// 1) siteurl / home (sempre) — para o WordPress deixar de redirecionar ao dominio antigo
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='siteurl'",'https://'.$__new));
$wpdb->query($wpdb->prepare("UPDATE {$prefix}options SET option_value=%s WHERE option_name='home'",'https://'.$__new));

// 2) TODAS as tabelas com o prefixo do WP (core + plugins). Para cada tabela:
//    - so colunas de texto (varchar/char/text/json), fora as de "nome de chave"
//      (option_name, meta_key, logins), que nao devem ser reescritas;
//    - exige chave primaria de UMA coluna (paginacao segura por keyset);
//    - le em lotes de 800 linhas que contenham o dominio antigo e atualiza
//      apenas o que realmente mudou, preservando dados serializados.
$__textTypes = array('char','varchar','tinytext','text','mediumtext','longtext','json');
$__colBlacklist = array('option_name','meta_key','user_login','user_pass','user_activation_key','user_nicename');

$tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($prefix).'%'));
if (!is_array($tables)) $tables = array();

foreach ($tables as $table) {
  if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) { $report['skipped_tables'][] = $table; continue; }

  // chave primaria (precisa ser de 1 coluna)
  $keys = $wpdb->get_results("SHOW KEYS FROM {$table} WHERE Key_name = 'PRIMARY'");
  if (!is_array($keys) || count($keys) !== 1) { $report['skipped_tables'][] = $table.' (pk)'; continue; }
  $pk = $keys[0]->Column_name;
  if (!preg_match('/^[A-Za-z0-9_]+$/', $pk)) { $report['skipped_tables'][] = $table.' (pk)'; continue; }

  // colunas de texto
  $cols = array();
  $colInfo = $wpdb->get_results("SHOW COLUMNS FROM {$table}");
  if (is_array($colInfo)) {
    foreach ($colInfo as $ci) {
      $cname = $ci->Field;
      $ctype = strtolower(preg_replace('/[^a-z].*$/i','',(string)$ci->Type));
      if (!preg_match('/^[A-Za-z0-9_]+$/', $cname)) continue;
      if ($cname === $pk) continue;
      if (in_array($cname, $__colBlacklist, true)) continue;
      if (in_array($ctype, $__textTypes, true)) $cols[] = $cname;
    }
  }
  if (count($cols) === 0) continue;

  // WHERE (c1 LIKE %s OR c2 LIKE %s ...) — uma unica varredura por tabela
  $whereParts = array(); $params = array();
  foreach ($cols as $c) { $whereParts[] = $c.' LIKE %s'; $params[] = $like; }
  $whereSql = '('.implode(' OR ', $whereParts).')';
  $selectCols = $pk.' AS dh_pk, '.implode(', ', $cols);

  $n = 0; $last = null;
  while (true) {
    if ($last === null) {
      $sqlParams = $params;
      $sql = "SELECT {$selectCols} FROM {$table} WHERE {$whereSql} ORDER BY {$pk} ASC LIMIT 800";
    } else {
      $sqlParams = array_merge($params, array($last));
      $sql = "SELECT {$selectCols} FROM {$table} WHERE {$whereSql} AND {$pk} > %s ORDER BY {$pk} ASC LIMIT 800";
    }
    $rows = $wpdb->get_results($wpdb->prepare($sql, $sqlParams));
    if (!is_array($rows) || count($rows) === 0) break;

    foreach ($rows as $r) {
      $last = $r->dh_pk;
      $sets = array(); $vals = array();
      foreach ($cols as $c) {
        $fixed = dh_fix($r->$c, $objSkipped);
        if ($fixed !== $r->$c) { $sets[] = $c.'=%s'; $vals[] = $fixed; }
      }
      if (count($sets) > 0) {
        $vals[] = $r->dh_pk;
        $wpdb->query($wpdb->prepare("UPDATE {$table} SET ".implode(', ', $sets)." WHERE {$pk}=%s", $vals));
        $n++;
      }
    }
    if (count($rows) < 800) break;
  }

  if ($n > 0) { $report['updated'][$table] = $n; $report['total'] += $n; }
}

$report['skipped_objects'] = $objSkipped;
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
    uploaded = await uploadSwapScript({
      username: account.user,
      oldDomain,
      newDomain,
      homedir: account.homedir
    });
  } catch (e) {
    await up('swap_database', 'error',
      `Domínio trocado, mas não foi possível preparar o ajuste do WordPress (${e.message}).`);
    return {
      success: true, partial: true, username: account.user, oldDomain, newDomain,
      wordpressFixed: false, softaculousFixed: false, cacheCleared: false
    };
  }

  // ═══ 4) Banco de dados do WordPress (siteurl/home + páginas + mídias + Elementor)
  await up('swap_database', 'in_progress', `Apontando o banco de dados do WordPress para ${newDomain}...`);
  const db = await runSwapScript({ ...uploaded, oldDomain, newDomain, mode: 'db' });
  if (db.success) {
    const total = db.result?.total || 0;
    const nTables = Object.keys(db.result?.updated || {}).length;
    await up('swap_database', 'completed',
      `Banco atualizado: ${total} registro(s) em ${nTables} tabela(s) reapontados para ${newDomain}`);
  } else {
    // Não derruba o swap: o domínio JÁ foi reapontado. Apenas avisa.
    await up('swap_database', 'error',
      `Domínio trocado, mas a correção automática do WordPress falhou (${db.error}). ` +
      `As URLs internas podem precisar de ajuste manual.`);
  }

  // ═══ 5) Softaculous (softdomain/softurl) + wp-config.php + .htaccess
  await up('swap_softaculous', 'in_progress', `Atualizando os registros do Softaculous para ${newDomain}...`);
  const soft = await runSwapScript({ ...uploaded, oldDomain, newDomain, mode: 'soft' });
  let softOk = false;
  if (soft.success) {
    const st = soft.result?.softaculous?.status || 'not_found';
    softOk = (st === 'updated' || st === 'nothing_to_do');

    // Verificação real: a listagem do Softaculous é a mesma fonte que o
    // botão de Login usa — se nenhum registro cita o domínio antigo, o
    // login vai abrir no domínio novo.
    const check = await verifySoftaculousSwap({ username: account.user, oldDomain });
    if (check.checked && check.stale === 0) {
      softOk = true;
      await up('swap_softaculous', 'completed',
        `Softaculous atualizado — login e registros apontando para ${newDomain}`);
    } else if (check.checked && check.stale > 0) {
      softOk = false;
      await up('swap_softaculous', 'error',
        `O Softaculous ainda tem ${check.stale} registro(s) citando ${oldDomain} (status: ${st}). ` +
        `Ajuste pelo "Edit Installation Details" se o login abrir no domínio antigo.`);
    } else if (softOk) {
      await up('swap_softaculous', 'completed',
        `Registros do Softaculous atualizados para ${newDomain}`);
    } else {
      await up('swap_softaculous', 'error',
        `Registros do Softaculous não puderam ser confirmados (status: ${st}).`);
    }
  } else {
    await up('swap_softaculous', 'error',
      `Domínio trocado, mas a atualização do Softaculous falhou (${soft.error}).`);
  }

  // ═══ 6) Cache (CSS do Elementor, wp-content/cache, LiteSpeed, transients) + apaga o script
  await up('swap_media', 'in_progress', `Limpando cache de páginas, mídias e Elementor...`);
  const cache = await runSwapScript({ ...uploaded, oldDomain, newDomain, mode: 'cache' });
  if (cache.success) {
    await up('swap_media', 'completed', `Cache limpo — páginas e mídias servindo por ${newDomain}`);
  } else {
    await up('swap_media', 'error',
      `Cache não pôde ser limpo automaticamente (${cache.error}). Limpe o cache do site se algo aparecer quebrado.`);
    // o modo cache é quem apaga o script; se ele não rodou, neutraliza o arquivo
    await neutralizeSwapScript(uploaded);
  }

  // ═══ 7) SSL
  await up('swap_ssl', 'in_progress', `Emitindo certificado SSL para ${newDomain}...`);
  await triggerAutoSSL(account.user);
  await up('swap_ssl', 'completed', `SSL solicitado para ${newDomain}`);

  return {
    success: true,
    username: account.user,
    oldDomain,
    newDomain,
    wordpressFixed: !!db.success,
    softaculousFixed: softOk,
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
  triggerAutoSSL,
  listSoftaculousInstallations,
  verifySoftaculousSwap,
  neutralizeSwapScript,
  buildSwapPhp
};
