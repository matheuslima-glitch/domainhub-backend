/**
 * MIGRAÇÃO DE E-MAIL DO SWAP
 * ----------------------------------------------------------------------------
 * Só entra em ação quando o domínio ANTIGO tem contas de e-mail de verdade.
 * Se não tiver, o swap segue normal e nada disto roda.
 *
 * O que faz, quando há caixas:
 *   1. ANTES do modifyacct  → captura as contas do domínio antigo (endereços,
 *      hash da senha e cota) e guarda num arquivo temporário (600) na home.
 *      Tem que ser antes, porque depois da troca o cPanel não lista mais as
 *      caixas do domínio antigo.
 *   2. DEPOIS do modifyacct → recria cada caixa no domínio novo pela API do
 *      próprio cPanel (Email::add_pop, do jeito certo, aparece na UI),
 *      restaura a senha ORIGINAL (injeta o hash) e MOVE as mensagens de
 *      /mail/ANTIGO/localpart → /mail/NOVO/localpart com rename() no sistema
 *      de arquivos. Como é a mesma partição, o move é O(1) — instantâneo
 *      independente do tamanho da caixa (não trafega nada pela API, não dá
 *      timeout nem em caixa de dezenas de GB).
 *   3. NO FIM → cria na Cloudflare, via API, os registros de entregabilidade
 *      do domínio novo (MX, SPF, DKIM real do domínio e DMARC), pra ele
 *      enviar e receber.
 *
 * Reaproveita os mesmos padrões do resto do swap: sessão cPanel + Fileman,
 * WHM API 1 com Authorization: whm user:token, httpsAgent self-signed.
 */

const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/env');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const CF_API = 'https://api.cloudflare.com/client/v4';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de infra (sessão cPanel, WHM API, host do servidor, execução do PHP)
// ─────────────────────────────────────────────────────────────────────────────

function whmHeaders() {
  return { 'Authorization': `whm ${config.WHM_USERNAME}:${config.WHM_API_TOKEN}` };
}

function cfHeaders() {
  return {
    'X-Auth-Email': config.CLOUDFLARE_EMAIL,
    'X-Auth-Key': config.CLOUDFLARE_API_KEY,
    'Content-Type': 'application/json'
  };
}

function getServerHost() {
  const fromIp = String(config.HOSTING_SERVER_IP || '').trim();
  if (fromIp) return fromIp.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  return String(config.WHM_URL || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '');
}

async function whmApi(func, params = {}) {
  const qs = new URLSearchParams({ 'api.version': '1', ...params });
  const resp = await axios.get(`${config.WHM_URL}/json-api/${func}?${qs.toString()}`, {
    headers: whmHeaders(), timeout: 60000, httpsAgent
  });
  return resp.data;
}

async function createCpanelSession(username) {
  const r = await axios.get(
    `${config.WHM_URL}/json-api/create_user_session?api.version=1&user=${username}&service=cpaneld`,
    { headers: whmHeaders(), timeout: 30000, httpsAgent }
  );
  const d = r.data?.data;
  if (!d?.cp_security_token) throw new Error('Não foi possível criar sessão no cPanel');
  const baseUrl = config.WHM_URL.replace(':2087', ':2083').replace(/\/$/, '');
  return { baseUrl, cpSecurityToken: d.cp_security_token, session: d.session };
}

function safeJson(str) {
  try {
    const s = str.indexOf('{');
    const e = str.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    return JSON.parse(str.substring(s, e + 1));
  } catch { return null; }
}

/** Sobe o PHP de e-mail para o public_html (uma vez; serve os 3 modos). */
async function uploadEmailPhp({ username, homedir, oldDomain, newDomain }) {
  const { baseUrl, cpSecurityToken, session } = await createCpanelSession(username);
  const home = homedir || `/home/${username}`;
  const publicHtmlPath = `${home}/public_html`;
  const phpFileName = `dh-mail-${uuidv4().replace(/-/g, '').substring(0, 16)}.php`;
  const token = uuidv4().replace(/-/g, '');
  const phpCode = buildEmailPhp({ oldDomain, newDomain, token, homedir: home });

  const form = new FormData();
  form.append('dir', publicHtmlPath);
  form.append('overwrite', '1');
  form.append('file-0', Buffer.from(phpCode, 'utf8'), { filename: phpFileName, contentType: 'application/x-php' });

  const up = await axios.post(
    `${baseUrl}${cpSecurityToken}/execute/Fileman/upload_files`,
    form,
    { headers: { ...form.getHeaders(), 'Cookie': `cpsession=${session}` }, timeout: 30000, httpsAgent }
  );
  if (up.data?.data?.succeeded !== 1) {
    throw new Error('Falha ao subir o script de e-mail: ' + (up.data?.data?.uploads?.[0]?.reason || 'desconhecido'));
  }
  await new Promise(r => setTimeout(r, 1500));
  return { phpFileName, token, homedir: home };
}

/**
 * Executa o PHP de e-mail no modo pedido, DNS-independente (bate no IP do
 * servidor com o header Host do vhost que serve o public_html no momento):
 * na captura o vhost ainda é o ANTIGO; na migração/limpeza já é o NOVO.
 */
async function runEmailPhp({ phpFileName, token, mode, hostDomain }) {
  const host = getServerHost();
  const q = `?dhtoken=${token}&mode=${mode}`;
  const attempts = [
    { url: `https://${host}/${phpFileName}${q}`, headers: { Host: hostDomain }, timeout: 300000 },
    { url: `http://${host}/${phpFileName}${q}`,  headers: { Host: hostDomain }, timeout: 300000 },
    { url: `https://${hostDomain}/${phpFileName}${q}`, headers: {},             timeout: 180000 }
  ];
  let lastErr = null;
  for (const att of attempts) {
    try {
      const resp = await axios.get(att.url, {
        timeout: att.timeout, httpsAgent,
        headers: { 'User-Agent': 'DomainHub-SwapMail/1.0', 'Accept': 'application/json', ...att.headers },
        maxRedirects: 5, validateStatus: () => true
      });
      const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data;
      if (data && data.ok) return { success: true, result: data };
      lastErr = new Error((data && data.error) || `Resposta inesperada (HTTP ${resp.status})`);
    } catch (e) { lastErr = e; }
  }
  return { success: false, error: lastErr ? lastErr.message : 'Falha ao executar o script de e-mail' };
}

// ─────────────────────────────────────────────────────────────────────────────
// UAPI (via sessão): add_pop, forwarders
// ─────────────────────────────────────────────────────────────────────────────

async function uapi({ baseUrl, cpSecurityToken, session }, module, func, params) {
  const body = new URLSearchParams(params);
  const url = `${baseUrl}${cpSecurityToken}/execute/${module}/${func}`;
  const resp = await axios.post(url, body.toString(), {
    headers: { 'Cookie': `cpsession=${session}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 60000, httpsAgent, maxRedirects: 5, validateStatus: () => true
  });
  const data = typeof resp.data === 'string' ? safeJson(resp.data) : resp.data;
  return data || {};
}

function strongTempPassword() {
  const u = uuidv4().replace(/-/g, '');
  // garante upper, lower, dígito e símbolos exigidos pelo cPanel
  return `Dh${u.substring(0, 10)}${u.substring(10, 20).toUpperCase()}!@9x`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) CAPTURA (antes do modifyacct)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Descobre se o domínio antigo tem caixas e captura o necessário para migrar.
 * Retorna { hasEmail, accounts:[{localpart,quota}], forwarders:[...],
 *           phpFileName, token, homedir }.
 */
async function captureEmailPlan({ username, homedir, oldDomain, newDomain }) {
  const uploaded = await uploadEmailPhp({ username, homedir, oldDomain, newDomain });
  const cap = await runEmailPhp({ ...uploaded, mode: 'mailcapture', hostDomain: oldDomain });
  if (!cap.success) {
    // captura falhou: apaga o script pra não deixar órfão no public_html
    try { await runEmailPhp({ phpFileName: uploaded.phpFileName, token: uploaded.token, mode: 'mailcleanup', hostDomain: oldDomain }); } catch (_) {}
    return { hasEmail: false, error: cap.error, ...uploaded, accounts: [], forwarders: [] };
  }
  const accounts = cap.result.accounts || [];

  // encaminhamentos ficam em /etc/valiases (root); pega via UAPI antes da troca
  let forwarders = [];
  try {
    const sess = await createCpanelSession(username);
    const fr = await uapi(sess, 'Email', 'list_forwarders', { domain: oldDomain });
    forwarders = (fr.data || []).map(f => ({ forward: f.forward || f.email, dest: f.forwardto || f.dest }));
  } catch (_) {}

  const hasEmail = accounts.length > 0 || forwarders.length > 0;

  // Sem e-mail: a migração (que faria a limpeza) não roda, então apaga o
  // script agora pra não deixar o dh-mail-*.php órfão no public_html.
  if (!hasEmail) {
    try { await runEmailPhp({ phpFileName: uploaded.phpFileName, token: uploaded.token, mode: 'mailcleanup', hostDomain: oldDomain }); } catch (_) {}
  }

  return { hasEmail, accounts, forwarders, ...uploaded };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) MIGRAÇÃO (depois do modifyacct)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recria as caixas no domínio novo (add_pop), restaura as senhas originais e
 * move as mensagens (rename O(1)). Recria os encaminhamentos. Limpa o stash e
 * apaga o script no fim.
 */
async function migrateEmail({ username, oldDomain, newDomain, plan, onProgress }) {
  const say = (m) => { if (onProgress) { try { onProgress(m); } catch (_) {} } };
  const accounts = plan.accounts || [];
  const report = { created: 0, mailMoved: 0, passwords: 0, forwarders: 0, perAccount: [], errors: [] };

  let sess;
  try {
    sess = await createCpanelSession(username);

  // 2a) recriar cada caixa via API do cPanel (com a cota original)
  for (const acc of accounts) {
    const quotaMB = acc.quota && acc.quota > 0 ? Math.max(1, Math.ceil(acc.quota / (1024 * 1024))) : 0;
    say(`Recriando ${acc.localpart}@${newDomain}...`);
    try {
      const res = await uapi(sess, 'Email', 'add_pop', {
        email: acc.localpart,
        domain: newDomain,
        password: strongTempPassword(),
        quota: String(quotaMB)
      });
      const ok = res.status === 1 || res.status === '1';
      const already = JSON.stringify(res.errors || []).toLowerCase().includes('already');
      if (ok || already) report.created++;
      else report.errors.push(`add_pop ${acc.localpart}: ${(res.errors || []).join('; ') || 'falhou'}`);
    } catch (e) {
      report.errors.push(`add_pop ${acc.localpart}: ${e.message}`);
    }
  }

  // 2b) restaurar senhas (injeta hash) + mover maildirs (rename O(1))
  say(`Movendo caixas e restaurando senhas...`);
  const restore = await runEmailPhp({
    phpFileName: plan.phpFileName, token: plan.token, mode: 'mailrestore', hostDomain: newDomain
  });
  if (restore.success) {
    for (const r of restore.result.accounts || []) {
      report.perAccount.push(r);
      if (r.shadow === 'ok') report.passwords++;
      if (r.mail === 'rename' || r.mail === 'copy') report.mailMoved++;
    }
  } else {
    report.errors.push(`restore: ${restore.error}`);
  }

  // 2c) recriar encaminhamentos (best-effort)
  for (const fwd of plan.forwarders || []) {
    const full = String(fwd.forward || '');
    if (!full.toLowerCase().endsWith('@' + oldDomain.toLowerCase())) continue;
    const localpart = full.split('@')[0];
    try {
      await uapi(sess, 'Email', 'add_forwarder', {
        domain: newDomain, email: localpart, fwdopt: 'fwd', fwdemail: fwd.dest
      });
      report.forwarders++;
    } catch (_) {}
  }

  } finally {
    // 2d) limpeza — SEMPRE roda, mesmo se algo acima falhar (remove stash + apaga o script)
    try { await runEmailPhp({ phpFileName: plan.phpFileName, token: plan.token, mode: 'mailcleanup', hostDomain: newDomain }); } catch (_) {}
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) DNS DE ENTREGABILIDADE NA CLOUDFLARE (só quando há e-mail)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTxt(txt) {
  if (Array.isArray(txt)) txt = txt.join('');
  return String(txt || '').replace(/^"|"$/g, '').replace(/"\s*"/g, '');
}

/** Extrai SPF e DKIM da zona LOCAL do cPanel (fonte de verdade dos registros). */
function extractFromZone(zoneData, newDomain) {
  const records = [];
  const zones = zoneData?.data?.zone || [];
  for (const z of zones) for (const rec of (z.record || [])) records.push(rec);

  let spf = null, dkim = null;
  for (const rec of records) {
    if ((rec.type || '').toUpperCase() !== 'TXT') continue;
    const val = normalizeTxt(rec.txtdata !== undefined ? rec.txtdata : rec.record);
    const name = String(rec.name || '').toLowerCase();
    if (!spf && /^v=spf1\b/i.test(val)) spf = val;
    if (!dkim && name.includes('_domainkey')) dkim = val;
  }
  return { spf, dkim };
}

async function getCloudflareZoneId(domain) {
  const r = await axios.get(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, { headers: cfHeaders(), timeout: 30000, httpsAgent });
  return r.data?.result?.[0]?.id || null;
}

/** Cria (ou atualiza) um registro na Cloudflare, evitando duplicar. */
async function upsertCfRecord(zoneId, desired) {
  // procura registro existente do mesmo tipo e nome
  const list = await axios.get(
    `${CF_API}/zones/${zoneId}/dns_records?type=${desired.type}&name=${encodeURIComponent(desired.name)}`,
    { headers: cfHeaders(), timeout: 30000, httpsAgent }
  );
  const existing = (list.data?.result || []).find(r => {
    if (desired.type === 'MX') return true;
    return normalizeTxt(r.content) === normalizeTxt(desired.content) || r.type === desired.type;
  });

  if (existing) {
    await axios.put(`${CF_API}/zones/${zoneId}/dns_records/${existing.id}`, desired, { headers: cfHeaders(), timeout: 30000, httpsAgent });
    return 'updated';
  }
  await axios.post(`${CF_API}/zones/${zoneId}/dns_records`, desired, { headers: cfHeaders(), timeout: 30000, httpsAgent });
  return 'created';
}

/**
 * Publica na Cloudflare os 4 registros de entregabilidade do domínio novo.
 * Busca a chave DKIM real do domínio (única por domínio) na zona local do
 * cPanel; MX aponta pro hostname do servidor (que já tem PTR válido).
 */
async function setupEmailDns({ newDomain, onProgress }) {
  const say = (m) => { if (onProgress) { try { onProgress(m); } catch (_) {} } };
  const out = { zoneId: null, records: {}, errors: [] };

  // garante que a chave DKIM existe no servidor e lê a zona local
  try { await whmApi('enable_dkim', { domain: newDomain }); } catch (_) {}

  let mailHost = getServerHost();
  try {
    const gh = await whmApi('gethostname', {});
    if (gh?.data?.hostname) mailHost = gh.data.hostname;
    else if (gh?.hostname) mailHost = gh.hostname;
  } catch (_) {}

  let spf = null, dkim = null;
  try {
    const zone = await whmApi('dumpzone', { domain: newDomain });
    const ext = extractFromZone(zone, newDomain);
    spf = ext.spf; dkim = ext.dkim;
  } catch (e) { out.errors.push('dumpzone: ' + e.message); }

  const serverIp = String(config.HOSTING_SERVER_IP || '').trim();
  if (!spf) spf = `v=spf1 +mx +a${serverIp ? ' +ip4:' + serverIp : ''} +include:spf.${mailHost} ~all`;
  const dmarc = 'v=DMARC1; p=none;';

  const zoneId = await getCloudflareZoneId(newDomain);
  if (!zoneId) { out.errors.push('zona Cloudflare não encontrada'); return out; }
  out.zoneId = zoneId;

  const desiredRecords = [
    { type: 'MX',  name: newDomain, content: mailHost, priority: 0, ttl: 1 },
    { type: 'TXT', name: newDomain, content: spf, ttl: 1 },
    { type: 'TXT', name: `_dmarc.${newDomain}`, content: dmarc, ttl: 1 }
  ];
  if (dkim) desiredRecords.push({ type: 'TXT', name: `default._domainkey.${newDomain}`, content: dkim, ttl: 1 });
  else out.errors.push('DKIM não encontrado na zona local (verifique manualmente)');

  for (const rec of desiredRecords) {
    const key = rec.type === 'MX' ? 'MX' : rec.name.startsWith('_dmarc') ? 'DMARC' : rec.name.startsWith('default._domainkey') ? 'DKIM' : 'SPF';
    say(`Publicando ${key} na Cloudflare...`);
    try { out.records[key] = await upsertCfRecord(zoneId, rec); }
    catch (e) { out.records[key] = 'erro'; out.errors.push(`${key}: ${e.response?.data?.errors?.[0]?.message || e.message}`); }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHP (capture / restore / cleanup) — roda como o usuário cPanel
// ─────────────────────────────────────────────────────────────────────────────

function buildEmailPhp({ oldDomain, newDomain, token, homedir }) {
  return `<?php
header('Content-Type: application/json');
error_reporting(0);
@ini_set('display_errors','0');
@set_time_limit(0);
@ini_set('memory_limit','512M');

$__token = ${JSON.stringify(token)};
if ((isset($_GET['dhtoken']) ? $_GET['dhtoken'] : '') !== $__token) {
  http_response_code(403); echo json_encode(array('ok'=>false,'error'=>'forbidden')); exit;
}
$__mode = isset($_GET['mode']) ? $_GET['mode'] : '';
$__old  = strtolower(${JSON.stringify(oldDomain)});
$__new  = strtolower(${JSON.stringify(newDomain)});
$__home = ${JSON.stringify(homedir || '')};
if (!$__home) { $__home = getenv('HOME'); }
if (!$__home) { $__home = dirname(dirname(__FILE__)); }
$__home = rtrim($__home, '/');
$__stash = $__home.'/.dh-mail-'.$__token.'.json';

function dh_rrmdir($dir){
  if(!is_dir($dir)) return;
  $items=@scandir($dir); if(!is_array($items)) return;
  foreach($items as $it){ if($it==='.'||$it==='..') continue; $p=$dir.'/'.$it; if(is_dir($p)) dh_rrmdir($p); else @unlink($p); }
  @rmdir($dir);
}
function dh_rcopy($src,$dst){
  if(!is_dir($src)) return false;
  @mkdir($dst,0700,true);
  $items=@scandir($src); if(!is_array($items)) return false;
  foreach($items as $it){ if($it==='.'||$it==='..') continue; $s=$src.'/'.$it; $d=$dst.'/'.$it;
    if(is_dir($s)){ if(!dh_rcopy($s,$d)) return false; } else { if(!@copy($s,$d)) return false; } }
  return true;
}
function dh_read_accounts($file){
  $out=array();
  if(!is_file($file)||!is_readable($file)) return $out;
  $lines=@file($file, FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES);
  if(!is_array($lines)) return $out;
  foreach($lines as $ln){ $p=explode(':',$ln); $lp=trim($p[0]); if($lp===''||$lp==='*') continue; $out[$lp]=isset($p[1])?$p[1]:''; }
  return $out;
}
function dh_read_quota($file){
  $out=array();
  if(!is_file($file)||!is_readable($file)) return $out;
  $lines=@file($file, FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES);
  if(is_array($lines)) foreach($lines as $ln){ $p=explode(':',$ln); if(isset($p[0])){ $out[trim($p[0])]=isset($p[1])?intval($p[1]):0; } }
  return $out;
}

// ─────────────────────── CAPTURA (antes do modifyacct) ───────────────────────
if ($__mode==='mailcapture'){
  $etc=$__home.'/etc/'.$__old;
  $accs=dh_read_accounts($etc.'/passwd');
  $shadow=dh_read_accounts($etc.'/shadow');
  $quota=dh_read_quota($etc.'/quota');
  $list=array(); $safe=array();
  foreach($accs as $lp=>$pw){
    $hash = (isset($shadow[$lp]) && $shadow[$lp]!=='') ? $shadow[$lp] : $pw;
    $list[]=array('localpart'=>$lp,'hash'=>$hash,'quota'=>isset($quota[$lp])?$quota[$lp]:0);
    $safe[]=array('localpart'=>$lp,'quota'=>isset($quota[$lp])?$quota[$lp]:0);
  }
  if(count($list)>0){ @file_put_contents($__stash, json_encode($list), LOCK_EX); @chmod($__stash,0600); }
  echo json_encode(array('ok'=>true,'mode'=>'mailcapture','count'=>count($safe),'hasEmail'=>count($safe)>0,'accounts'=>$safe));
  exit;
}

// ─────────────────────── RESTAURA (depois do modifyacct) ─────────────────────
if ($__mode==='mailrestore'){
  $data = is_file($__stash) ? json_decode(@file_get_contents($__stash), true) : null;
  if(!is_array($data)){ echo json_encode(array('ok'=>false,'error'=>'stash_missing')); exit; }
  $newEtc=$__home.'/etc/'.$__new;

  $inject = function($file,$lp,$hash){
    if(!is_file($file)) return 'no_file';
    $lines=@file($file, FILE_IGNORE_NEW_LINES);
    if(!is_array($lines)) return 'read_err';
    $found=false;
    foreach($lines as $i=>$ln){
      if($ln==='') continue;
      $p=explode(':',$ln);
      if(trim($p[0])===$lp){ if(count($p)<2){ $p[]=$hash; } else { $p[1]=$hash; } $lines[$i]=implode(':',$p); $found=true; }
    }
    if(!$found) return 'not_found';
    $perms=@fileperms($file); @copy($file,$file.'.dh-bak');
    $tmp=$file.'.dh-tmp';
    if(@file_put_contents($tmp, implode(chr(10),$lines).chr(10), LOCK_EX)===false) return 'write_err';
    if(!@rename($tmp,$file)){ @unlink($tmp); return 'rename_err'; }
    if($perms!==false) @chmod($file,$perms & 0777);
    return 'ok';
  };

  $movedir = function($src,$dst){
    if(!is_dir($src)) return 'no_src';
    if(is_dir($dst)) dh_rrmdir($dst);
    if(@rename($src,$dst)) return 'rename';
    if(dh_rcopy($src,$dst)){ dh_rrmdir($src); return 'copy'; }
    return 'fail';
  };

  $report=array();
  foreach($data as $it){
    $lp=$it['localpart']; $hash=$it['hash'];
    $r1=$inject($newEtc.'/shadow',$lp,$hash);
    $r2=$inject($newEtc.'/passwd',$lp,$hash);
    $src=$__home.'/mail/'.$__old.'/'.$lp;
    $dst=$__home.'/mail/'.$__new.'/'.$lp;
    $rm = is_dir($src) ? $movedir($src,$dst) : 'no_src';
    if($rm==='rename'||$rm==='copy'){ @chmod($dst,0700); }
    $report[]=array('localpart'=>$lp,'shadow'=>$r1,'passwd'=>$r2,'mail'=>$rm);
  }
  echo json_encode(array('ok'=>true,'mode'=>'mailrestore','accounts'=>$report));
  exit;
}

// ─────────────────────── LIMPEZA ─────────────────────────────────────────────
if ($__mode==='mailcleanup'){
  @unlink($__stash);
  $oldMail=$__home.'/mail/'.$__old;
  if(is_dir($oldMail)){
    $items=@scandir($oldMail);
    if(is_array($items) && count($items)<=2){ @rmdir($oldMail); }
  }
  $ok = !file_exists($__stash);
  echo json_encode(array('ok'=>true,'mode'=>'mailcleanup','stash_removed'=>$ok));
  @unlink(__FILE__);
  exit;
}

echo json_encode(array('ok'=>false,'error'=>'bad_mode'));
`;
}

module.exports = {
  captureEmailPlan,
  migrateEmail,
  setupEmailDns,
  buildEmailPhp
};