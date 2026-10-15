// bili2ncm — B站音频 → 网易云音乐云盘
// 单文件 · 零依赖 · 基于客户端 eapi 协议 (NeteaseCloudMusicApi 删库后仍可用)
// 用法: node server.js  然后访问 http://127.0.0.1:3210
//
// 免责声明: 本项目仅供技术学习与个人使用, 上传至云盘的内容仅限本人收听,
// 请勿用于商业用途, 使用者需自行遵守相关平台服务条款及版权法规。
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3210;
const HOST = '127.0.0.1';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const BUCKET = 'jd-musicrep-privatecloud-audio-public';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0';
const NCM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseMusicDesktop/3.1.10.203506';

const DIR = __dirname;
// cookie 兼容: 项目目录优先, 其次上级目录 (便于从旧脚本迁移)
function cookieFile(name) {
  if (fs.existsSync(path.join(DIR, name))) return path.join(DIR, name);
  const parent = path.join(DIR, '..', name);
  if (fs.existsSync(parent)) return parent;
  return path.join(DIR, name); // 可写路径, 用于保存
}
const NCM_COOKIE_FILE = cookieFile('cookie.txt');
const BILI_COOKIE_FILE = cookieFile('bilibili_cookie.txt');

function readNcmCookie() {
  try { return fs.readFileSync(NCM_COOKIE_FILE, 'utf8').trim(); } catch (e) { return ''; }
}
function readBiliCookie() {
  try { return fs.readFileSync(BILI_COOKIE_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

// ---------- 通用 HTTP (跟随重定向) ----------
function req(method, url, headers, body, isBinary) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: body ? { ...headers, 'Content-Length': body.length } : headers,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(req(method, res.headers.location, headers, body, isBinary));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(isBinary ? buf : { status: res.statusCode, text: buf.toString('utf8'), buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(600000);
    if (body) r.write(body);
    r.end();
  });
}
async function getJSON(url, headers) {
  return JSON.parse((await req('GET', url, headers)).text);
}
function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'audio';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 上传历史 (防重复参考, 本地 history.json, 不进 git) ----------
const HISTORY_FILE = path.join(DIR, 'history.json');
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
function appendHistory(entry) {
  try {
    const list = readHistory();
    list.unshift({ time: new Date().toISOString().replace('T', ' ').slice(0, 19), ...entry });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 500), null, 2));
  } catch (e) { /* 历史写失败不影响上传 */ }
}

// ---------- 网易云 eapi ----------
function aesEcb(buf, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(buf), c.final()]);
}
function eapi(apiPath, data) {
  const text = JSON.stringify(data);
  const message = `nobody${apiPath}use${text}md5forencrypt`;
  const digest = crypto.createHash('md5').update(message).digest('hex');
  const raw = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return 'params=' + aesEcb(Buffer.from(raw), EAPI_KEY).toString('hex').toUpperCase();
}
function ncmReq(apiPath, data) {
  return new Promise((resolve, reject) => {
    const cookie = readNcmCookie();
    if (!cookie) return reject(new Error('未配置网易云cookie, 请在页面设置中粘贴MUSIC_U'));
    const body = eapi(apiPath, data);
    const r = https.request({
      hostname: 'interface.music.163.com',
      path: '/eapi' + apiPath.slice(4),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': NCM_UA,
        'Cookie': cookie + '; os=pc; appver=3.1.10.203506',
        'os': 'pc', 'appver': '3.1.10.203506',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let text = buf.toString('utf8');
        if (!/^[\s{\[]/.test(text) && buf.length > 16) {
          try {
            const d = crypto.createDecipheriv('aes-128-ecb', EAPI_KEY, null);
            text = Buffer.concat([d.update(buf), d.final()]).toString('utf8');
          } catch (e) { /* keep */ }
        }
        let j;
        try { j = JSON.parse(text); } catch (e) { return reject(new Error('非JSON: ' + text.slice(0, 100))); }
        // code 301 = 登录失效: 明确中断, 避免半成品 (文件已传存储但无法入库)
        if (j.code === 301) {
          const err = new Error('网易云登录已失效(301): MUSIC_U 过期或无效, 请在页面设置中重新粘贴');
          err.authFail = true;
          return reject(err);
        }
        resolve(j);
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// ---------- 网易云云盘操作 ----------
async function ncmAccount() {
  try {
    const j = await ncmReq('/api/nuser/account/get', {});
    if (j.code === 200 && j.profile) return { ok: true, nickname: j.profile.nickname, userId: j.account.id };
    return { ok: false };
  } catch (e) { return { ok: false }; }
}
async function cloudList() {
  const list = await ncmReq('/api/v1/cloud/get', { limit: 50, offset: 0, e_r: true });
  return {
    count: list.count, size: list.size,
    songs: (list.data || []).map(d => {
      const s = d.simpleSong || {};
      return {
        songId: d.songId,
        name: s.name || d.songName || '?',
        artist: (s.ar || []).map(a => a.name).filter(Boolean).join('/') || '',
        album: (s.al || {}).name || '',
        size: d.fileSize || (s.l || {}).size || 0,
        bitrate: (s.l || {}).bitrate || 0,
      };
    }),
  };
}
async function cloudDel(songId) {
  return ncmReq('/api/cloud/del', { songIds: songId });
}

// 上传一个音频文件(Buffer)到云盘, 返回 songId
async function uploadBuffer({ buffer, ext, filename, song, artist, album, contentType, send }) {
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  send(`预检中... (${(buffer.length / 1048576).toFixed(2)}MB, md5=${md5.slice(0, 8)}...)`);
  const check = await ncmReq('/api/cloud/upload/check', {
    bitrate: '999000', ext, length: buffer.length, md5, songId: '0', version: 1,
  });
  if (check.code !== 200) throw new Error('预检失败: ' + JSON.stringify(check).slice(0, 150));
  if (!check.needUpload) send('云盘已存在相同内容, 秒传');

  send('分配云存储...');
  const tokenRes = await ncmReq('/api/nos/token/alloc', {
    bucket: BUCKET, ext, filename, local: false, nos_product: 3, type: 'audio', md5,
  });
  if (!tokenRes.result || !tokenRes.result.objectKey) throw new Error('存储分配失败: ' + JSON.stringify(tokenRes).slice(0, 150));
  const { objectKey, token, resourceId } = tokenRes.result;

  if (check.needUpload) {
    send('上传文件到云存储...');
    const lbs = JSON.parse((await req('GET', `https://wanproxy.127.net/lbs?version=1.0&bucketname=${BUCKET}`, {})).text);
    const upUrl = `${lbs.upload[0]}/${BUCKET}/${objectKey.replace(/\//g, '%2F')}?offset=0&complete=true&version=1.0`;
    const up = await req('POST', upUrl, { 'x-nos-token': token, 'Content-MD5': md5, 'Content-Type': contentType || 'audio/mp4' }, buffer);
    if (up.status !== 200) throw new Error('云存储上传失败: ' + up.text.slice(0, 150));
    send('文件上传完成');
  }

  send('写入歌曲信息...');
  // 入库偶发失败(频率限制 uploadStatus:9 / 存储同步延迟), 重试一次
  let info = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    info = await ncmReq('/api/upload/cloud/info/v2', {
      md5, songid: check.songId, filename, song, album: album || '', artist, bitrate: '999000', resourceId,
    });
    if (info.code === 200) break;
    if (attempt === 1) {
      send(`入库失败, 5秒后重试: ${JSON.stringify(info).slice(0, 120)}`);
      await sleep(5000);
    }
  }
  if (info.code !== 200) throw new Error('入库失败: ' + JSON.stringify(info).slice(0, 200));

  send('发布...');
  const pub = await ncmReq('/api/cloud/pub/v2', { songid: info.songId });
  if (pub.code !== 200) {
    // 重复上传场景: 歌曲已在云盘且已发布, pub 会失败但返回歌曲信息 — 视为已存在
    if (pub.privateCloud && pub.privateCloud.simpleSong) {
      send('歌曲已在云盘中, 跳过重复发布');
    } else {
      throw new Error('发布失败: ' + JSON.stringify(pub).slice(0, 150));
    }
  }
  return info.songId;
}

// 下载音频流: baseUrl 失败自动切换 backup_url (CDN 故障转移)
async function downloadAudio(stream, headers, send) {
  const urls = [stream.baseUrl, ...(stream.backup_url || [])].filter(Boolean);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      if (urls.length > 1) send(`下载源 ${i + 1}/${urls.length}: ${new URL(urls[i]).hostname}`);
      return await req('GET', urls[i], headers, null, true);
    } catch (e) {
      lastErr = e;
      send(`  ✗ 源 ${i + 1} 连接失败: ${e.message}, 尝试备用源...`);
    }
  }
  throw new Error('所有下载源均失败: ' + (lastErr ? lastErr.message : '未知'));
}

// ---------- B站 ----------
const QUALITY_IDS = { '192k': 30280, '132k': 30232, '64k': 30216 };
function pickAudio(dash, quality) {
  // 30250=杜比全景声(ec-3), 云盘不支持, 直接排除
  const audios = (dash.audio || []).filter(a => a.id !== 30250).slice().sort((a, b) => b.bandwidth - a.bandwidth);
  if (!audios.length) return null;
  if (!quality || quality === 'best') return { a: audios[0], downgraded: false };
  const want = QUALITY_IDS[quality];
  const exact = audios.find(a => a.id === want);
  if (exact) return { a: exact, downgraded: false };
  // 找不到精确码率: 取不超过目标的最高一档
  const cap = audios.filter(a => a.id <= (want || 0));
  const chosen = cap.length ? cap[0] : audios[audios.length - 1];
  return { a: chosen, downgraded: true };
}
// 智能清洗歌名: 去序号前缀/【】[]标签, 拆"歌手-歌名"结构 (右段含版本词时不拆, 如"晴天-周杰伦版")
function cleanSongName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^[0-9]{1,4}[.、\-\s]+/, '').replace(/[【\[].*?[】\]]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/^([^\-–—]{1,16}?)\s*[-–—]\s*(.{1,40})$/);
  if (m && m[1].trim() && m[2].trim() && !/版|翻唱|伴奏|cover|live|remix|纯音乐|钢琴|八音盒|串烧|混剪|DJ/i.test(m[2].trim()))
    return { song: m[2].trim(), artist: m[1].trim() };
  return { song: s, artist: null };
}
async function biliHeaders() {
  const c = readBiliCookie();
  return {
    'User-Agent': UA, 'Referer': 'https://www.bilibili.com/',
    ...(c ? { Cookie: c } : {}),
  };
}
// 解析输入: 支持BV号/视频URL(?p=n)/多选
function parseBvid(input) {
  const bv = (input.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  const p = (input.match(/[?&]p=(\d+)/) || [])[1];
  return { bvid: bv || input.trim(), page: p ? parseInt(p) : null };
}

// 主流程: 上传B站视频的指定分P(或全部分P)
async function biliUpload(input, opts, send) {
  const { bvid, page } = parseBvid(input);
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('无法解析BV号: ' + input);
  const quality = opts.quality || 'best';
  const allPages = opts.allPages || false;
  const H = await biliHeaders();

  send('获取视频信息 ' + bvid + '...');
  const view = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H);
  if (view.code !== 0) throw new Error('B站视频信息获取失败: ' + view.message);
  const { title, owner, pages } = view.data;

  // 防御: B站对未登录请求偶发截断 pages 列表 (实测: 2P视频返回1P)
  const declared = view.data.videos || pages.length;
  if (declared > pages.length) {
    send(`⚠ B站返回分P列表不完整 (${pages.length}/${declared}P), "全部分P"模式可能漏传. 在页面配置B站cookie可改善`);
  }

  let targets = pages;
  if (!allPages) {
    targets = page ? pages.filter(p => p.page === page) : [pages[0]];
    if (!targets.length) throw new Error(`未找到分P ${page} (接口返回了 ${pages.length}P${declared > pages.length ? ', 且列表不完整' : ''})`);
  }
  send(`「${title}」 UP: ${owner.name} | 分P: ${allPages ? '全部 ' + pages.length + 'P' : targets[0].page + 'P'}`);

  const results = [];
  const useClean = opts.clean !== false; // 智能清洗默认开启
  for (let i = 0; i < targets.length; i++) {
    const pg = targets[i];
    // 命名优先级: 手动指定 > (清洗开启时)清洗分P名 > 原始分P名 > 视频标题
    const rawName = pg.part && pg.part !== title ? pg.part : title;
    let songName, artist;
    if (opts.song) {
      songName = sanitize(opts.song);
      artist = sanitize(opts.artist || owner.name);
    } else {
      const cleaned = useClean ? cleanSongName(rawName) : null;
      songName = sanitize((cleaned && cleaned.song) || rawName);
      artist = sanitize(opts.artist || (cleaned && cleaned.artist) || owner.name);
    }
    if (i > 0) { send('风控保护: 等待5秒...'); await sleep(5000); }
    send(`\n=== [${i + 1}/${targets.length}] ${pg.part} ===`);

    // 单P失败不中断批量, 最后汇总; 登录失效类错误则提前终止
    try {
      const prev = readHistory().find(h => h.bvid === bvid && h.page === pg.page);
      if (prev) send(`[提示] 该分P曾于 ${prev.time} 上传过 (songId=${prev.songId}), 重复内容会被云盘秒传合并`);

      send('获取音频流(音质: ' + (quality === 'best' ? '最高' : quality) + ')...');
      const play = await getJSON(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${pg.cid}&fnval=16&fnver=0&qn=0`, H);
      if (play.code === -101) throw new Error('B站登录已失效(-101): SESSDATA 过期或无效, 请在页面设置中更新或清空');
      if (play.code !== 0 || !play.data.dash) throw new Error('playurl失败: ' + (play.message || '无DASH流'));
      const { a, downgraded } = pickAudio(play.data.dash, quality);
      if (!a) throw new Error('无音频流');
      if (downgraded) send(`目标音质不可用, 已降级到 ${Math.round(a.bandwidth / 1000)}kbps (id=${a.id})`);
      else send(`选中 ${Math.round(a.bandwidth / 1000)}kbps (id=${a.id})`);
      if (!readBiliCookie() && a.id <= QUALITY_IDS['64k']) send('[提示] 未配置B站cookie, 音质受限. 页面设置中可粘贴SESSDATA提升音质');

      send('下载音频中...');
      const buf = await downloadAudio(a, H, send);
      send(`已下载 ${(buf.length / 1048576).toFixed(2)}MB`);

      // 30251=Hi-Res(FLAC), 其余为 AAC(m4a); 专辑不写(留空给网易云/后续手动匹配)
      const ext = a.id === 30251 ? 'flac' : 'm4a';
      const songId = await uploadBuffer({
        buffer: buf, ext, filename: songName + '.' + ext,
        song: songName, artist, album: '', contentType: ext === 'flac' ? 'audio/flac' : 'audio/mp4', send,
      });
      results.push({ page: pg.page, song: songName, songId, ok: true });
      send(`✓ 完成 songId=${songId}`);
      appendHistory({ bvid, page: pg.page, song: songName, artist, songId, size: buf.length });
    } catch (e) {
      send(`✗ 本P失败: ${e.message}`);
      results.push({ page: pg.page, song: songName, ok: false, error: e.message });
      // 登录失效: 后续每P必然同样失败, 提前终止
      if (e.authFail || /-101/.test(e.message)) { send('登录已失效, 终止剩余分P'); break; }
    }
  }

  const okCount = results.filter(r => r.ok).length;
  send(`\n===== 汇总: 成功 ${okCount}/${targets.length} =====`);
  return results;
}

// ---------- 页面 ----------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>bili2ncm — B站音频传网易云云盘</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Segoe UI","Microsoft YaHei",sans-serif; background:linear-gradient(135deg,#0f0c29,#302b63,#24243e); min-height:100vh; color:#eee; padding:30px 16px; }
  .wrap { max-width:780px; margin:0 auto; }
  h1 { font-size:22px; margin-bottom:6px; } h1 span{ color:#ec407a; }
  .sub { color:#aaa; font-size:13px; margin-bottom:22px; line-height:1.6; }
  .card { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:20px; margin-bottom:18px; }
  .card h3 { font-size:14px; margin-bottom:12px; color:#f8bbd0; }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  input[type=text],input[type=password],select { flex:1; min-width:160px; padding:11px 13px; border-radius:10px; border:1px solid rgba(255,255,255,.15); background:rgba(0,0,0,.3); color:#fff; font-size:13.5px; outline:none; }
  input:focus,select:focus { border-color:#ec407a; }
  select { cursor:pointer; }
  button { padding:11px 20px; border:none; border-radius:10px; background:linear-gradient(135deg,#ec407a,#ff6d00); color:#fff; font-size:14px; cursor:pointer; white-space:nowrap; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:rgba(255,255,255,.12); font-size:12.5px; padding:8px 14px; }
  label.chk { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:#ccc; cursor:pointer; }
  .hint { font-size:12px; color:#888; margin-top:8px; line-height:1.6; }
  .ok { color:#69f0ae; } .bad { color:#ff8a80; }
  #log { margin-top:14px; background:rgba(0,0,0,.35); border-radius:10px; padding:12px; font-family:Consolas,monospace; font-size:12.5px; max-height:240px; overflow-y:auto; white-space:pre-wrap; color:#9fdca4; display:none; }
  .stats { color:#aaa; font-size:12.5px; margin-bottom:10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#bbb; font-weight:normal; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,.12); }
  td { padding:8px; border-bottom:1px solid rgba(255,255,255,.06); }
  .del { color:#ff8a80; cursor:pointer; font-size:12px; }
  .empty { color:#888; text-align:center; padding:18px; }
  .disclaimer { font-size:11.5px; color:#777; line-height:1.7; margin-top:20px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>bili2ncm <span>→</span> 网易云音乐云盘</h1>
  <div class="sub">单文件 · 零依赖 · 基于客户端 eapi 协议<br>粘贴B站视频链接或BV号, 提取音频并上传到你的音乐云盘</div>

  <div class="card">
    <div class="row">
      <input type="text" id="input" placeholder="BV1xxx... 或 https://www.bilibili.com/video/BVxxx?p=2" style="flex:2" />
      <select id="quality">
        <option value="best">最高音质</option>
        <option value="192k">192kbps</option>
        <option value="132k">132kbps</option>
        <option value="64k">64kbps</option>
      </select>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="chk"><input type="checkbox" id="allPages"> 上传全部分P</label>
      <label class="chk" title="去序号/标签, 拆分'歌手-歌名', 歌手字段自动纠正"><input type="checkbox" id="clean" checked> 智能清洗歌名</label>
      <input type="text" id="song" placeholder="歌名(留空=自动)" style="max-width:200px" />
      <input type="text" id="artist" placeholder="歌手(留空=自动)" style="max-width:160px" />
      <button id="go" onclick="doUpload()">上传</button>
    </div>
    <div id="log"></div>
  </div>

  <div class="card">
    <h3>设置</h3>
    <div class="row" style="margin-bottom:10px">
      <input type="password" id="ncmCookie" placeholder="网易云 MUSIC_U=F90E1F... (多个cookie分号连接)" />
      <button class="ghost" onclick="saveCookie('ncm')">保存网易云</button>
    </div>
    <div class="row">
      <input type="password" id="biliCookie" placeholder="B站 SESSDATA=xxx (可选, 提升音质上限)" />
      <button class="ghost" onclick="saveCookie('bili')">保存B站</button>
    </div>
    <div class="hint" id="status">加载中...</div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h3 style="margin:0">我的音乐云盘</h3>
      <button class="ghost" onclick="loadList()">刷新</button>
    </div>
    <div class="stats" id="stats"></div>
    <table><thead><tr><th style="width:42%">歌曲</th><th>歌手</th><th>音质</th><th>大小</th><th></th></tr></thead>
    <tbody id="list"><tr><td colspan="5" class="empty">加载中...</td></tr></tbody></table>
  </div>

  <details class="card">
    <summary style="cursor:pointer;color:#f8bbd0;font-size:14px;">上传历史 (最近50条, 本地记录)</summary>
    <div style="margin-top:12px;">
      <table><thead><tr><th>时间</th><th style="width:34%">歌曲</th><th>来源</th><th>大小</th></tr></thead>
      <tbody id="history"><tr><td colspan="4" class="empty">暂无记录</td></tr></tbody></table>
    </div>
  </details>

  <div class="disclaimer">
    免责声明: 本工具仅供技术学习与个人使用, 上传至云盘的内容仅限本人收听。<br>
    请遵守B站、网易云音乐服务条款及相关版权法规, 请勿用于商业用途。使用者自行承担使用责任。
  </div>
</div>
<script>
function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function log(msg, cls) {
  const el = document.getElementById('log');
  el.style.display = 'block';
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
async function loadStatus() {
  const j = await (await fetch('/api/status')).json();
  document.getElementById('status').innerHTML =
    '网易云: ' + (j.ncm.ok ? '<span class=ok>已登录 (' + esc(j.ncm.nickname) + ')</span>' : '<span class=bad>未配置/失效, 请粘贴MUSIC_U</span>')
    + ' &nbsp;|&nbsp; B站: ' + (j.bili ? '<span class=ok>已配置 (高音质)</span>' : '未配置 (仅64kbps)');
}
async function saveCookie(kind) {
  const v = kind === 'ncm' ? document.getElementById('ncmCookie').value.trim() : document.getElementById('biliCookie').value.trim();
  const r = await (await fetch('/api/cookie', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind, value:v}) })).json();
  if (r.ok) { log('✓ cookie已保存', 'ok'); loadStatus(); if (kind==='ncm') loadList(); }
  else log('✗ 保存失败: ' + r.error, 'err');
}
async function loadHistory() {
  const j = await (await fetch('/api/history')).json();
  const tb = document.getElementById('history');
  if (!j.items.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">暂无记录</td></tr>'; return; }
  tb.innerHTML = j.items.map(h =>
    '<tr><td style="color:#888;white-space:nowrap">' + esc(h.time) + '</td><td>' + esc(h.song) + '</td><td>'
    + esc(h.bvid + '?p=' + h.page) + '</td><td>' + (h.size ? (h.size/1048576).toFixed(1)+'MB' : '-') + '</td></tr>').join('');
}
async function loadList() {
  const j = await (await fetch('/api/list')).json();
  document.getElementById('stats').textContent = '共 ' + j.count + ' 首 | 已用 ' + (j.size/1048576).toFixed(1) + ' MB' + (j.error ? ' | ' + j.error : '');
  const tb = document.getElementById('list');
  if (!j.songs.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">' + (j.error ? esc(j.error) : '云盘为空') + '</td></tr>'; return; }
  tb.innerHTML = j.songs.map(s =>
    '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.artist) + '</td><td>' +
    (s.bitrate ? Math.round(s.bitrate/1000)+'kbps' : '-') + '</td><td>' +
    (s.size ? (s.size/1048576).toFixed(1)+'MB' : '-') + '</td>' +
    '<td><span class="del" onclick="del(' + s.songId + ')">删除</span></td></tr>').join('');
}
async function del(id) {
  if (!confirm('确定从云盘删除这首歌曲?')) return;
  await fetch('/api/del', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({songId:id}) });
  loadList();
}
async function doUpload() {
  const input = document.getElementById('input').value.trim();
  if (!input) return;
  const btn = document.getElementById('go');
  btn.disabled = true; btn.textContent = '处理中...';
  document.getElementById('log').innerHTML = ''; document.getElementById('log').style.display='block';
  try {
    const res = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ input, quality: document.getElementById('quality').value,
        allPages: document.getElementById('allPages').checked,
        clean: document.getElementById('clean').checked,
        song: document.getElementById('song').value.trim(), artist: document.getElementById('artist').value.trim() }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream:true });
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const j = JSON.parse(l);
        if (j.type === 'done') { log('✓ 全部完成: ' + j.results.map(r => r.song + '(id=' + r.songId + ')').join(', '), 'ok'); loadList(); loadHistory(); }
        else if (j.type === 'error') log('✗ ' + j.msg, 'err');
        else log(j.msg);
      }
    }
  } catch (e) { log('✗ ' + e.message, 'err'); }
  btn.disabled = false; btn.textContent = '上传';
}
loadStatus(); loadList(); loadHistory();
</script>
</body>
</html>`;

// ---------- 服务器 ----------
http.createServer((rq, rs) => {
  const url = rq.url.split('?')[0];
  if (rq.method === 'GET' && url === '/') {
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return rs.end(PAGE);
  }
  if (rq.method === 'GET' && url === '/api/status') {
    ncmAccount().then(ncm => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ncm, bili: /SESSDATA/.test(readBiliCookie()) }));
    }).catch(e => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ncm: { ok: false, error: e.message }, bili: /SESSDATA/.test(readBiliCookie()) }));
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/cookie') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', () => {
      try {
        const { kind, value } = JSON.parse(body);
        if (kind === 'ncm') {
          const cookie = value.match(/MUSIC_U\s*=\s*([0-9A-Fa-f]{16,})/)
            ? value.trim() : 'MUSIC_U=' + value.trim();
          fs.writeFileSync(path.join(DIR, 'cookie.txt'), cookie);
        } else {
          fs.writeFileSync(path.join(DIR, 'bilibili_cookie.txt'), value.trim());
        }
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ok: true }));
      } catch (e) {
        rs.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/list') {
    cloudList().then(j => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify(j));
    }).catch(e => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ count: 0, size: 0, songs: [], error: e.message }));
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/history') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    rs.end(JSON.stringify({ items: readHistory().slice(0, 50) }));
    return;
  }
  if (rq.method === 'POST' && url === '/api/del') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      try {
        const { songId } = JSON.parse(body);
        const j = await cloudDel(songId);
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ok: j.code === 200, resp: j }));
      } catch (e) {
        rs.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/upload') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      // 客户端可能中途断开(关浏览器/超时), 上传任务需继续跑完, 写日志失败必须静默
      const send = msg => { try { rs.write(JSON.stringify({ type: 'log', msg }) + '\n'); } catch (e) {} };
      try {
        const opts = JSON.parse(body);
        const results = await biliUpload(opts.input, opts, send);
        rs.end(JSON.stringify({ type: 'done', results }) + '\n');
      } catch (e) {
        rs.end(JSON.stringify({ type: 'error', msg: e.message }) + '\n');
      }
    });
    return;
  }
  rs.writeHead(404); rs.end('not found');
}).listen(PORT, HOST, () => {
  console.log(`bili2ncm 已启动: http://${HOST}:${PORT}`);
  console.log('免责声明: 仅供技术学习与个人使用, 云盘内容仅限本人收听');
});
