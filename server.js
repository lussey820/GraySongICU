// GraySongICU — B站音频 → 网易云音乐云盘
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
const { execFile, spawn } = require('child_process');
const os = require('os');

const PORT = Number(process.env.GRAYSONGICU_PORT) || 3210;
const HOST = '127.0.0.1';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const BUCKET = 'jd-musicrep-privatecloud-audio-public';
// 实测(2026-10-22): 云盘存储层单文件上限 200MB, 200MB+1KB 即返回 413
const MAX_CLOUD_BYTES = 200 * 1024 * 1024;
// 留声机: 本地上传的封面暂存, 10 分钟内有效
const localCovers = new Map();
// 全局上传锁: 同一时间只允许一个上传任务, 避免多开页面同时打接口触发平台风控
let uploadBusy = false;
function uploadBusyReply(rs) {
  rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  rs.end(JSON.stringify({ type: 'error', msg: '已有一个上传任务在跑, 请等它结束再试' }) + '\n');
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0';
const NCM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseMusicDesktop/3.1.10.203506';

// APP_DIR = 程序资源目录(只读), DIR = 用户数据目录(可写)
// 打包后数据写到 %APPDATA%\GraySongICU, 避免 Program Files 无写权限
const APP_DIR = process.env.GRAYSONGICU_APP_DIR || __dirname;
const DIR = process.env.GRAYSONGICU_DATA_DIR || __dirname;
// cookie 兼容: 项目目录优先, 其次上级目录 (便于从旧脚本迁移)
function cookieFile(name) {
  if (fs.existsSync(path.join(DIR, name))) return path.join(DIR, name);
  const parent = path.join(DIR, '..', name);
  if (fs.existsSync(parent)) return parent;
  return path.join(DIR, name); // 可写路径, 用于保存
}
const NCM_COOKIE_FILE = cookieFile('cookie.txt');
const BILI_COOKIE_FILE = cookieFile('bilibili_cookie.txt');
// 桌面版: 登录凭据由 Electron 主进程用系统 DPAPI 加密保存, 这里只在内存里用
// 浏览器直接跑 server.js 时没有加密能力, 才回退写明文文件
const COOKIE_HOOK = String(process.env.GRAYSONGICU_LYRIC_HOOK || '');
const HOOK_TOKEN = String(process.env.GRAYSONGICU_HOOK_TOKEN || '');
const cookieMem = {
  ncm: String(process.env.GRAYSONGICU_NCM_COOKIE || '').trim(),
  bili: String(process.env.GRAYSONGICU_BILI_COOKIE || '').trim(),
};
function readNcmCookie() {
  if (cookieMem.ncm) return cookieMem.ncm;
  try { return (cookieMem.ncm = fs.readFileSync(NCM_COOKIE_FILE, 'utf8').trim()); } catch (e) { return ''; }
}
function readBiliCookie() {
  if (cookieMem.bili) return cookieMem.bili;
  try { return (cookieMem.bili = fs.readFileSync(BILI_COOKIE_FILE, 'utf8').trim()); } catch (e) { return ''; }
}
// 写入登录凭据: 桌面版交给主进程加密, 浏览器版直接落盘
async function saveCookie(kind, value) {
  const v = String(value || '').trim();
  if (COOKIE_HOOK) {
    const r = await hookPost('/cookie/set', { kind, value: v });
    if (!r || !r.ok) throw new Error('登录凭据保存失败: ' + ((r && r.error) || '加密服务无响应'));
    cookieMem[kind] = v;
    return;
  }
  fs.writeFileSync(kind === 'ncm' ? NCM_COOKIE_FILE : BILI_COOKIE_FILE, v);
  cookieMem[kind] = v;
}
// 每次启动生成一个随机凭据, 只有本应用页面能拿到; 本机其它程序/网页调接口会 401
const API_TOKEN = crypto.randomBytes(16).toString('hex');
const AUTH_COOKIE = 'gsi_token=' + API_TOKEN + '; Path=/; HttpOnly; SameSite=Strict';
function hasApiToken(rq) {
  const h = String(rq.headers['x-gsi-token'] || '');
  if (h && h === API_TOKEN) return true;
  const c = String(rq.headers.cookie || '');
  return c.split(/;\s*/).includes('gsi_token=' + API_TOKEN);
}

// ---------- 通用 HTTP (跟随重定向) ----------
function req(method, url, headers, body, isBinary, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method,
      headers: body ? { ...headers, 'Content-Length': body.length } : headers,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('重定向地址无效')); }
        try { if (isPrivateHost(new URL(next).hostname)) return reject(new Error('已拦截内网地址')); } catch (e) {}
        return resolve(req(method, next, headers, body, isBinary, timeoutMs));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(isBinary ? buf : { status: res.statusCode, text: buf.toString('utf8'), buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    // 空闲超时(无数据流动才计时, 慢速下载不受影响), 默认60秒
    r.setTimeout(timeoutMs, () => r.destroy(new Error('请求超时 (' + Math.round(timeoutMs / 1000) + '秒无响应)')));
    if (body) r.write(body);
    r.end();
  });
}
async function getJSON(url, headers, timeoutMs) {
  return JSON.parse((await req('GET', url, headers, null, false, timeoutMs)).text);
}

// ---------- 苹果播客 (Apple Podcasts / iTunes 中国区公开接口) ----------
// 搜索节目 + 拉取单集, 单集自带音频直链, 不需要登录
function appleJSON(url) {
  return getJSON(url, { 'User-Agent': UA }, 25000);
}
async function appleSearch(kw) {
  const j = await appleJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(kw) + '&media=podcast&country=cn&limit=20');
  return (j.results || []).filter(r => r.collectionId).map(r => ({
    collectionId: String(r.collectionId),
    name: decodeEntities(r.collectionName || r.trackName || '播客'),
    artist: decodeEntities(r.artistName || ''),
    count: r.trackCount || 0,
    artwork: r.artworkUrl100 || r.artworkUrl600 || '',
    link: 'https://podcasts.apple.com/cn/podcast/id' + r.collectionId,
  }));
}
async function appleEpisodes(collectionId) {
  const j = await appleJSON('https://itunes.apple.com/lookup?id=' + encodeURIComponent(collectionId) + '&entity=podcastEpisode&country=cn&limit=100');
  return (j.results || []).filter(r => r.wrapperType === 'podcastEpisode' && r.episodeUrl).map(r => ({
    episodeId: String(r.trackId || ''),
    name: decodeEntities(r.trackName || '播客单集'),
    show: decodeEntities(r.collectionName || ''),
    durationMs: Number(r.trackTimeMillis || 0),
    date: r.releaseDate || '',
    url: r.episodeUrl,
    artwork: r.artworkUrl600 || r.artworkUrl100 || '',
    link: 'https://podcasts.apple.com/cn/podcast/id' + (r.collectionId || collectionId) + (r.trackId ? '?i=' + r.trackId : ''),
  }));
}
// 音频扩展名/类型推断 + HEAD 预取体积(避免白下载 200MB+)
function extFromType(ct) {
  const s = String(ct || '').toLowerCase();
  if (/mpeg|mp3/.test(s)) return 'mp3';
  if (/mp4|m4a|x-m4a/.test(s)) return 'm4a';
  if (/aac/.test(s)) return 'aac';
  if (/flac/.test(s)) return 'flac';
  if (/ogg|opus/.test(s)) return 'ogg';
  if (/wav/.test(s)) return 'wav';
  return null;
}
function contentTypeFor(ext) {
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav' }[ext] || 'application/octet-stream';
}
async function probeAudio(url, referer) {
  try {
    const h = await req('HEAD', url, { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) }, null, false, 20000);
    const len = Number((h.headers && h.headers['content-length']) || 0);
    return { size: Number.isFinite(len) ? len : 0, contentType: String((h.headers && h.headers['content-type']) || '') };
  } catch (e) {
    return { size: 0, contentType: '' };
  }
}
// 限时竞速: 超过ms毫秒未完成则放弃等待(底层请求仍有自身超时兜底)
function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
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
// 本地时间, 24 小时制 YYYY-MM-DD HH:mm:ss
function nowStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function appendHistory(entry) {
  try {
    const list = readHistory();
    list.unshift({ time: nowStamp(), ...entry });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 500), null, 2));
  } catch (e) { /* 历史写失败不影响上传 */ }
}
// 补歌词历史: 只记录真正写入歌词的动作, 没补过就保持空
const LYRIC_HISTORY_FILE = path.join(DIR, 'lyric-history.json');
function readLyricHistory() {
  try { return JSON.parse(fs.readFileSync(LYRIC_HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
function appendLyricHistory(entry) {
  try {
    const list = readLyricHistory();
    list.unshift({ time: nowStamp(), ...entry });
    fs.writeFileSync(LYRIC_HISTORY_FILE, JSON.stringify(list.slice(0, 200), null, 2));
  } catch (e) { /* 历史写失败不影响补歌词 */ }
}

// ---------- 统一异常处理 ----------
// 原则: 技术细节只写服务端日志, 返回给页面的一律是人话
function rawErrorText(e) {
  if (typeof e === 'string') return e;
  if (!e) return '未知错误';
  return String(e.stack || e.message || e);
}
function friendlyError(e) {
  const msg = String((e && e.message) || e || '').trim();
  const code = String((e && e.code) || '');
  const status = Number((e && (e.statusCode || e.status)) || 0);
  const all = (msg + ' ' + code + ' ' + (status || '')).trim();
  if (e && e.authFail) return '登录已过期, 请重新登录网易云后再试。';
  if (/301|凭证.{0,6}(失效|无效)|MUSIC_U.{0,6}(失效|过期)|重新粘贴|登录已?(失效|过期)/i.test(msg)) return '登录已过期, 请重新登录网易云后再试。';
  if (/-101|-352|SESSDATA|B站登录|B 站登录/i.test(msg)) return 'B 站登录信息已失效, 请重新登录 B 站。';
  if (/-412|风控|请求过于频繁|操作太频繁|频率/i.test(msg)) return '操作太快了, 请稍等一会儿再试。';
  if (/413|too large|payload too large|超过.{0,8}(200|上限)|文件过[大超]/i.test(all)) return '文件超过云盘上限, 请拆分后再传。';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|getaddrinfo|socket hang up|连接超时|网络|连接失败/i.test(all)) {
    if (/ETIMEDOUT|连接超时|请求超时|timeout/i.test(all)) return '请求超时, 请稍后重试。';
    return '网络连接失败, 请检查网络后重试。';
  }
  if (/超时|timeout/i.test(all)) return '请求超时, 请稍后重试。';
  if (/未配置.{0,6}cookie|未登录|请先登录/i.test(msg)) return '还没有登录, 请先完成登录。';
  if (/非JSON|Unexpected token|JSON.{0,3}parse|返回格式|格式异常/i.test(msg)) return '服务返回的数据无法识别, 请稍后重试。';
  if (/ffmpeg|转码/i.test(msg)) return '音频转换失败, 请换一个音源试试。';
  if (/ffprobe|读取音频|音频时[长间]/i.test(msg)) return '音频文件无法读取, 请换一个音源试试。';
  if (/没有可用音频|无可用音频|未找到可用音频|没有音频/i.test(msg)) return '这个视频没有可用音频, 换一个试试。';
  if (/视频不存在|稿件.{0,6}(不可见|删除)|已删除|已下架/i.test(msg)) return '视频不存在或已下架, 换一个试试。';
  if (/视频信息.{0,6}(获取|读取)失败/i.test(msg)) return '视频信息读取失败, 请稍后重试。';
  if (/ENOENT|EPERM|EACCES|写入失败|临时文件/i.test(msg)) return '本地文件读写失败, 请检查目录权限后重试。';
  if (/无法解析.{0,6}(BV号|链接)|链接格式/i.test(msg)) return '链接无法识别, 请检查后重试。';
  if (/合集为空/i.test(msg)) return '这个合集是空的, 换一个试试。';
  // 已经是中文人话, 且没有明显技术痕迹 → 原样展示
  if (/[\u4e00-\u9fa5]/.test(msg) && !/[A-Za-z_]{6,}|\[object|undefined|null|HTTP|status|code|stack|Error:/i.test(msg)) return msg;
  return '操作失败, 请稍后重试。';
}
function logError(scope, e) {
  const detail = rawErrorText(e);
  console.error('[' + nowStamp() + '][' + scope + '] ' + (detail.split('\n')[0] || '未知错误'));
  if (e && e.stack && e.stack !== detail) console.error(e.stack);
}
function fail(rs, e, extra, status) {
  logError('api', e);
  try {
    if (!rs.headersSent) {
      rs.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (!rs.writableEnded) rs.end(JSON.stringify(Object.assign({ ok: false, error: friendlyError(e) }, extra || {})));
  } catch (_) { /* 连接已断开, 忽略 */ }
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

// weapi加密(登录二维码等账号接口用): AES-CBC双层 + RSA(BigInt实现, 免PEM)
const WEAPI_PRESET = '0CoJUm6Qyw8W8jud';
const WEAPI_IV = '0102030405060708';
const WEAPI_RSA_N = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
function weapi(data) {
  const text = JSON.stringify(data);
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 16; i++) key += pool[Math.floor(Math.random() * pool.length)];
  const aes = (t, k) => {
    const c = crypto.createCipheriv('aes-128-cbc', k, WEAPI_IV);
    return Buffer.concat([c.update(Buffer.from(t, 'utf8')), c.final()]).toString('base64');
  };
  const params = aes(aes(text, WEAPI_PRESET), key);
  let r = 1n;
  let b = BigInt('0x' + Buffer.from(key.split('').reverse().join(''), 'utf8').toString('hex')) % BigInt('0x' + WEAPI_RSA_N);
  let k = 0x10001n;
  const N = BigInt('0x' + WEAPI_RSA_N);
  while (k > 0n) { if (k & 1n) r = r * b % N; b = b * b % N; k >>= 1n; }
  return 'params=' + encodeURIComponent(params) + '&encSecKey=' + r.toString(16).padStart(256, '0');
}
// 免登录态的网易云weapi请求(扫码登录用), 返回解析JSON与Set-Cookie
function weapiRaw(apiPath, data) {
  return new Promise((resolve, reject) => {
    const body = weapi(data);
    const r = https.request({
      hostname: 'music.163.com',
      path: '/weapi' + apiPath.slice(4),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': NCM_UA,
        'Referer': 'https://music.163.com/',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ json: JSON.parse(text), setCookie: res.headers['set-cookie'] || [] }); }
        catch (e) { reject(new Error('非JSON: ' + text.slice(0, 100))); }
      });
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('请求超时')));
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
    count: list.count, size: list.size, maxSize: list.maxSize || 0,
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

// ---------- 灰歌扫描: 歌单里因 VIP/版权原因无法播放的歌 ----------
let ncmUidCache = null;
async function ncmUid() {
  if (ncmUidCache) return ncmUidCache;
  const j = await ncmReq('/api/nuser/account/get', {});
  if (j.code !== 200 || !j.account) throw new Error('无法获取网易云账号, 请先登录网易云');
  ncmUidCache = j.account.id;
  return ncmUidCache;
}
async function ncmPlaylists() {
  const uid = await ncmUid();
  const j = await ncmReq('/api/user/playlist', { uid, limit: 100, offset: 0, includeVideo: false });
  if (j.code !== 200) throw new Error('歌单读取失败: ' + (j.message || j.code));
  const mine = Number(uid);
  return (j.playlist || []).map(p => ({
    id: p.id, name: p.name, count: p.trackCount || 0, special: p.specialType === 5,
    // 只有自己创建的歌单才能加歌, 收藏来的歌单没有操作权限
    own: Number(p.userId || (p.creator && p.creator.userId) || 0) === mine,
  }));
}
// 「我喜欢的音乐」歌单 id (specialType=5)
async function likedPlaylistId() {
  const pl = await ncmPlaylists();
  const hit = pl.find(p => p.special);
  return hit ? hit.id : null;
}
// 侧栏数据: 我喜欢的音乐按总播放次数排序 + 网易云每日推荐
let sideCache = { at: 0, data: null };
async function ncmSide() {
  if (sideCache.data && Date.now() - sideCache.at < 10 * 60 * 1000) return sideCache.data;
  const uid = await ncmUid();
  const pid = await likedPlaylistId();
  const out = { liked: [], rec: [] };
  let tracks = [];
  if (pid) {
    const j = await ncmReq('/api/v6/playlist/detail', { id: Number(pid), n: 1000, s: 0 });
    if (j.code === 200 && j.playlist) tracks = j.playlist.tracks || [];
  }
  let record = null;
  try { record = await ncmReq('/api/v1/play/record', { uid, type: 0 }); } catch (e) { record = null; }
  const counts = new Map();
  for (const it of (record && record.allData) || []) {
    if (it.song && it.song.id) counts.set(it.song.id, it.playCount || 0);
  }
  out.liked = tracks.map(t => ({
    id: t.id,
    name: t.name || '?',
    artist: (t.ar || []).map(a => a.name).filter(Boolean).join('/'),
    count: counts.get(t.id) || 0,
  })).sort((a, b) => b.count - a.count).slice(0, 3);
  try {
    // ---- 行为画像: 总榜(长期) + 周榜(近期) + 关注艺人 + 我的喜欢 ----
    let allRes = null, weekRes = null, subRes = null;
    try { allRes = await ncmReq('/api/v1/play/record', { uid, type: 0 }); } catch (e) {}
    try { weekRes = await ncmReq('/api/v1/play/record', { uid, type: 1 }); } catch (e) {}
    try { subRes = await ncmReq('/api/artist/sublist', { limit: 100, offset: 0 }); } catch (e) {}
    const allData = (allRes && allRes.allData) || [];
    const weekPlays = new Map();
    for (const it of (weekRes && weekRes.weekData) || []) {
      if (it.song && it.song.id) weekPlays.set(it.song.id, it.playCount || 0);
    }
    const followed = new Set(((subRes && subRes.data) || []).map(a => a.id));
    const heard = new Set(counts.keys()); // 常听榜里的歌不再重复推荐

    // 歌手亲和度: 累计播放量取对数; 喜欢歌单里的歌额外加权
    const artistPlay = new Map();
    for (const it of allData) {
      const pc = it.playCount || 0;
      for (const a of ((it.song || {}).ar) || []) artistPlay.set(a.id, (artistPlay.get(a.id) || 0) + pc);
    }
    for (const t of tracks) for (const a of t.ar || []) artistPlay.set(a.id, (artistPlay.get(a.id) || 0) + 8);
    const maxArtistPlay = Math.max(1, ...artistPlay.values());

    // ---- 风格圈: 用总榜前 8 首当种子, 取网易云「相似歌曲」 ----
    const seeds = allData.slice(0, 8).map(x => x.song).filter(Boolean);
    const simiSets = await Promise.all(seeds.map(s =>
      ncmReq('/api/v1/discovery/simiSong', { songid: s.id, limit: 50 }).catch(() => null)));
    const styleSongs = new Map(); // id -> { song, w }
    const styleArtists = new Set();
    simiSets.forEach((j, i) => {
      const seedW = 0.7 + 0.3 * (1 - i / Math.max(1, seeds.length));
      const seedArt = new Set(((seeds[i] || {}).ar || []).map(a => a.id));
      for (const s of ((j && j.songs) || [])) {
        const ar = s.artists || s.ar || [];
        for (const a of ar) styleArtists.add(a.id);
        if (heard.has(s.id)) continue;
        // 同一歌手的相似曲更多是「歌手重复」而非「风格相近」, 降权
        const sameArtist = ar.some(a => seedArt.has(a.id));
        const w = seedW * Math.min(1, (s.score || 0) / 100) * (sameArtist ? 0.35 : 1);
        const prev = styleSongs.get(s.id);
        if (!prev || prev.w < w) styleSongs.set(s.id, { song: s, w });
      }
    });

    // ---- 候选池: 相似歌曲(风格驱动) + 每日推荐(平台个性化) ----
    const dailyRes = await ncmReq('/api/v1/discovery/recommend/songs', {}).catch(() => null);
    const dailySongs = ((dailyRes && dailyRes.data && dailyRes.data.dailySongs) || []);
    const cands = new Map();
    const put = (s, isSimi) => {
      const ar = s.artists || s.ar || [];
      if (!s.id || heard.has(s.id)) return;
      const aid = ar.map(a => a.id).filter(Boolean);
      let aMax = 0;
      for (const id of aid) aMax = Math.max(aMax, artistPlay.get(id) || 0);
      let artistScore = Math.log1p(aMax) / Math.log1p(maxArtistPlay);
      if (aid.some(id => followed.has(id))) artistScore = Math.min(1, artistScore + 0.25);
      const alg = String(s.alg || '') + ' ' + String(s.reason || '') + ' ' + String(s.recommendReason || '');
      let styleScore;
      if (isSimi) {
        const sw = styleSongs.get(s.id);
        styleScore = 0.55 + 0.45 * (sw ? sw.w : 0.5);
      } else {
        styleScore = /vec|embedding|interest|hstu_multi|hpCover|sim_song/.test(alg) ? 0.65 : 0.4;
        if (aid.some(id => styleArtists.has(id))) styleScore = Math.min(0.8, styleScore + 0.15);
      }
      const pop = Number(s.popularity != null ? s.popularity : (s.pop || 0)) || 0;
      const heat = Math.min(1, pop / 100);
      const fresh = weekPlays.has(s.id) ? 0.2 : 1; // 最近在听过的先让位
      const score = styleScore * 0.55 + artistScore * 0.2 + heat * 0.15 + fresh * 0.1;
      const prev = cands.get(s.id);
      if (prev && prev.styleScore >= styleScore) return;
      cands.set(s.id, {
        id: s.id,
        name: s.name || '?',
        artist: ar.map(a => a.name).filter(Boolean).join('/'),
        artistIds: aid,
        styleScore, score,
      });
    };
    for (const [id, v] of styleSongs) put(v.song, true);
    for (const s of dailySongs) put(s, false);

    // ---- 排序 + 同名去重 + 每位艺人最多 1 首(风格多样, 防单歌手屠榜) ----
    const seenName = new Set(), usedArtist = new Map();
    out.rec = [...cands.values()].sort((a, b) => b.score - a.score).filter(c => {
      const nk = (c.name + '|' + c.artist).toLowerCase();
      if (seenName.has(nk)) return false;
      if (c.artistIds.some(id => (usedArtist.get(id) || 0) >= 1)) return false;
      seenName.add(nk);
      for (const id of c.artistIds) usedArtist.set(id, (usedArtist.get(id) || 0) + 1);
      return true;
    }).slice(0, 10);

    // 印章显示相对相似度: 榜首≈97%, 末位≈65%
    const vals = out.rec.map(s => s.score);
    const maxS = Math.max(0.001, ...vals), minS = Math.min(...vals);
    out.rec = out.rec.map(s => ({
      id: s.id, name: s.name, artist: s.artist,
      score: Math.round(65 + ((s.score - minS) / Math.max(0.001, maxS - minS)) * 32),
    }));
  } catch (e) { /* 推荐失败不影响喜欢列表 */ }
  sideCache = { at: Date.now(), data: out };
  return out;
}
// 扫描分两类: 暂无音源(pl=0 或 st<0) / VIP专属(fee=1 且当前账号能播)
async function scanPlaylist(pid) {
  const j = await ncmReq('/api/v6/playlist/detail', { id: Number(pid), n: 1000, s: 0 });
  if (j.code !== 200 || !j.playlist) throw new Error('歌单打开失败: ' + (j.message || j.code));
  const pl = j.playlist;
  const priv = new Map((j.privileges || []).map(p => [p.id, p]));
  const gray = [], vip = [];
  for (const t of pl.tracks || []) {
    const p = priv.get(t.id);
    if (!p) continue;
    const item = {
      id: t.id,
      name: t.name || '?',
      artist: (t.ar || []).map(a => a.name).filter(Boolean).join('/'),
      album: (t.al || {}).name || '',
      durMs: t.dt || 0,
      fee: p.fee || 0,
    };
    if (p.pl === 0 || p.st < 0) gray.push(item);
    else if (p.fee === 1) vip.push(item);
  }
  return { id: pl.id, name: pl.name, total: pl.trackCount || (pl.tracks || []).length, gray, vip };
}
// 歌单增删曲目: 加默认进「我喜欢的音乐」, 也可指定歌单; 删从指定歌单移除
async function editPlaylistTracks({ op, pid, ids }) {
  let target = Number(pid);
  if (op === 'add' && (!Number.isFinite(target) || target <= 0)) {
    target = await likedPlaylistId();
    if (!target) throw new Error('找不到「我喜欢的音乐」歌单');
  }
  if (!Number.isFinite(target) || target <= 0) throw new Error('缺少歌单');
  const j = await ncmReq('/api/playlist/manipulate/tracks', {
    op: op === 'del' ? 'del' : 'add',
    pid: target,
    trackIds: JSON.stringify(ids),
    imme: true,
  });
  if (j.code !== 200) {
    // 已在该歌单里视为成功, 避免重复添加时报错
    if (String(j.message || '').indexOf('重复') > -1) return { id: target, count: ids.length, already: true };
    throw new Error(j.message || ('操作失败 code ' + j.code));
  }
  return { id: target, count: ids.length };
}

// 流式上传文件到 NOS: 边读边发, 不把整首歌读进内存
function uploadFileStream(url, headers, file, size, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('上传地址无效')); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': size },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => r.destroy(new Error('请求超时 (' + Math.round(timeoutMs / 1000) + '秒无响应)')));
    const rs = fs.createReadStream(file);
    rs.on('error', e => r.destroy(e));
    rs.pipe(r);
  });
}
// 把新 ID3 标签写到新文件开头, 原音频数据流式拷贝过去
function writeMp3WithCover(src, dest, cover, mime, meta) {
  return new Promise((resolve, reject) => {
    let start = 0;
    try {
      const sz = fs.statSync(src).size;
      const fd = fs.openSync(src, 'r');
      const head = Buffer.alloc(Math.min(10, sz));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      start = Math.min(id3HeaderOffset(head), sz);
    } catch (e) { return reject(e); }
    const ws = fs.createWriteStream(dest);
    ws.write(buildMp3Id3(cover, mime, meta));
    const rs = fs.createReadStream(src, { start });
    rs.on('error', e => { ws.destroy(); reject(e); });
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

// 上传一个音频文件到云盘, 返回 songId
// buffer: 已在内存里的文件; file/size/md5: 流式上传时用磁盘文件, 二者互斥
async function uploadBuffer({ buffer, file, size, md5, ext, filename, song, artist, album, contentType, send, cover }) {
  if (cover && buffer) {
    const before = buffer.length;
    buffer = embedCover(buffer, ext, cover, { title: song, artist, album });
    if (buffer.length > before) send('已写入歌曲封面');
  }
  const total = file ? Number(size || 0) : buffer.length;
  const digest = md5 || crypto.createHash('md5').update(buffer).digest('hex');
  send(`正在准备上传 (大小 ${(total / 1048576).toFixed(2)}MB)...`);
  const check = await ncmReq('/api/cloud/upload/check', {
    bitrate: '999000', ext, length: total, md5: digest, songId: '0', version: 1,
  });
  if (check.code !== 200) throw new Error('预检失败: ' + JSON.stringify(check).slice(0, 150));
  if (!check.needUpload) send('⚡ 云盘里已有相同内容, 秒传完成 (无需上传文件)');

  send('正在连接云盘存储...');
  const tokenRes = await ncmReq('/api/nos/token/alloc', {
    bucket: BUCKET, ext, filename, local: false, nos_product: 3, type: 'audio', md5: digest,
  });
  if (!tokenRes.result || !tokenRes.result.objectKey) throw new Error('存储分配失败: ' + JSON.stringify(tokenRes).slice(0, 150));
  const { objectKey, token, resourceId } = tokenRes.result;

  if (check.needUpload) {
    send('正在上传文件...');
    const lbs = JSON.parse((await req('GET', `https://wanproxy.127.net/lbs?version=1.0&bucketname=${BUCKET}`, {})).text);
    const upUrl = `${lbs.upload[0]}/${BUCKET}/${objectKey.replace(/\//g, '%2F')}?offset=0&complete=true&version=1.0`;
    const headers = { 'x-nos-token': token, 'Content-MD5': digest, 'Content-Type': contentType || 'audio/mp4' };
    const up = file
      ? await uploadFileStream(upUrl, headers, file, total)
      : await req('POST', upUrl, headers, buffer);
    if (up.status !== 200) throw new Error('云存储上传失败: ' + up.text.slice(0, 150));
    send('文件上传完成');
  }

  send('正在保存歌曲信息...');
  // 入库偶发失败: 大文件首次处理可能超过网关60秒返回504, 稍后重试即秒回 (限流 uploadStatus:9 同理)
  let info = null, lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      info = await ncmReq('/api/upload/cloud/info/v2', {
        md5: digest, songid: check.songId, filename, song, album: album || '', artist, bitrate: '999000', resourceId,
      });
      if (info.code === 200) break;
      lastErr = JSON.stringify(info).slice(0, 150);
    } catch (e) {
      if (e.authFail) throw e;
      lastErr = e.message;
      info = null;
    }
    if (attempt < 3) {
      send('网易云处理较慢, 稍后自动重试...');
      await sleep(attempt === 1 ? 10000 : 20000);
    }
  }
  if (!info || info.code !== 200) throw new Error('入库失败: ' + lastErr);

  send('正在发布到云盘...');
  const pub = await ncmReq('/api/cloud/pub/v2', { songid: info.songId });
  if (pub.code !== 200) {
    // 重复上传场景: 歌曲已在云盘且已发布, pub 会失败但返回歌曲信息 — 视为已存在
    if (pub.privateCloud && pub.privateCloud.simpleSong) {
      send('歌曲已在云盘中, 跳过重复发布');
    } else {
      throw new Error('发布失败: ' + JSON.stringify(pub).slice(0, 150));
    }
  }
  return { songId: info.songId, instant: !check.needUpload };
}

// ---------- 超过云盘单文件 200MB 上限: 按 MP3 帧边界切成多段, 每段独立上传 ----------
const MP3_BITRATE = {
  mpeg1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // Layer II
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // Layer III
  ],
  mpeg2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const MP3_SAMPLERATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
// 返回该位置的 MPEG 音频帧长度; 0 = 不是有效帧头
function mp3FrameLen(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (b[i + 1] >> 3) & 3;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (b[i + 1] >> 1) & 3; // 3=Layer I, 2=Layer II, 1=Layer III
  if (ver === 1 || layer === 0) return 0;
  const bri = (b[i + 2] >> 4) & 0xf;
  const sri = (b[i + 2] >> 2) & 3;
  if (bri === 0 || bri === 0xf || sri === 3) return 0;
  const br = MP3_BITRATE[ver === 3 ? 'mpeg1' : 'mpeg2'][3 - layer][bri];
  const sr = MP3_SAMPLERATE[ver === 3 ? 3 : ver === 2 ? 2 : 0][sri];
  if (!br || !sr) return 0;
  const pad = (b[i + 2] >> 1) & 1;
  const coef = layer === 3 ? 12 : (ver !== 3 ? 72 : 144); // MPEG2/2.5 的 Layer II/III 系数为 72
  return layer === 3 ? Math.floor(12 * br * 1000 / sr + pad) * 4 : Math.floor(coef * br * 1000 / sr + pad);
}
// 在帧边界切成若干段(第一段保留 ID3 标签); 非 MP3 结构返回 null
function splitMp3(buf, maxBytes) {
  let i = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    i = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  while (i < buf.length - 4 && !mp3FrameLen(buf, i)) i++;
  if (i >= buf.length - 4) return null;
  const starts = [i];
  let p = i;
  while (p < buf.length) {
    const len = mp3FrameLen(buf, p);
    if (!len || p + len > buf.length) break;
    p += len;
    starts.push(p);
  }
  if (starts.length < 2) return null;
  const parts = [];
  let start = 0;
  for (let k = 0; k < starts.length; k++) {
    if (starts[k] - start <= maxBytes) continue;
    const cut = k > 0 ? starts[k - 1] : starts[k];
    if (cut <= start) return null;
    parts.push(buf.subarray(start, cut));
    start = cut;
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts.length > 1 ? parts : null;
}

// ---------- M4A(MP4) 拆分: 重建每段 moov 的样本表 (无需 ffmpeg) ----------
const MP4_CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };
function mp4Parse(buf, start, end) {
  const list = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    let header = 8;
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    list.push({
      type, start: off, size, header, end: off + size,
      children: MP4_CONTAINERS[type] ? mp4Parse(buf, off + header, off + size) : null,
    });
    off += size;
  }
  return list;
}
const mp4Find = (list, type) => (list || []).find(n => n.type === type) || null;
function mp4FindPath(list, ...types) {
  let cur = list, node = null;
  for (const t of types) {
    node = mp4Find(cur, t);
    if (!node) return null;
    cur = node.children;
  }
  return node;
}
function mp4Box(type, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(payload.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}

// ---------- 上传前写入封面: mp3 写 ID3 APIC, m4a 写 moov/udta/meta/ilst 的 covr ----------
function id3SyncSafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function id3Frame(id, payload) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}
function id3TextFrame(id, text) {
  const t = Buffer.from(String(text), 'utf16le');
  const bom = Buffer.from([0xff, 0xfe]);
  return id3Frame(id, Buffer.concat([Buffer.from([1]), bom, t]));
}
// 生成完整 ID3v2.3 标签(标题/歌手/专辑 + APIC 封面)
function buildMp3Id3(cover, mime, meta) {
  const frames = [];
  if (meta.title) frames.push(id3TextFrame('TIT2', meta.title));
  if (meta.artist) frames.push(id3TextFrame('TPE1', meta.artist));
  if (meta.album) frames.push(id3TextFrame('TALB', meta.album));
  // APIC: 编码(0=latin1) + mime + 0 + 图片类型(3=封面) + 描述 + 0 + 图片数据
  const apic = Buffer.concat([
    Buffer.from([0]), Buffer.from(mime, 'latin1'), Buffer.from([0]),
    Buffer.from([3]), Buffer.from([0]), cover,
  ]);
  frames.push(id3Frame('APIC', apic));
  const body = Buffer.concat(frames);
  const head = Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), id3SyncSafe(body.length),
  ]);
  return Buffer.concat([head, body]);
}
// 返回已有 ID3 标签之后的音频数据起点
function id3HeaderOffset(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const flags = buf[5] || 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14)
    | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let end = 10 + size;
  if (flags & 0x10) end += 10; // 带 footer
  return end;
}
function id3AudioOffset(buf) {
  return Math.min(id3HeaderOffset(buf), buf.length);
}
function embedMp3Cover(buf, cover, mime, meta) {
  const tag = buildMp3Id3(cover, mime, meta);
  return Buffer.concat([tag, buf.subarray(id3AudioOffset(buf))]);
}
function mp4DataBox(type, payload) {
  return mp4Box('data', Buffer.concat([Buffer.from([0, 0, 0, type, 0, 0, 0, 0]), payload]));
}
function mp4TextAtom(name, text) {
  return mp4Box(name, mp4DataBox(1, Buffer.from(String(text), 'utf8')));
}
function mp4AddCover(buf, cover, mime, meta) {
  const top = mp4Parse(buf, 0, buf.length);
  const ftyp = mp4Find(top, 'ftyp');
  const moov = mp4Find(top, 'moov');
  const mdat = mp4Find(top, 'mdat');
  if (!ftyp || !moov || !mdat || !moov.children) return null;
  // 分片 MP4 的样本偏移在 moof 里, 直接插入会破坏结构, 放弃写封面
  const stbl0 = mp4FindPath(moov.children, 'trak', 'mdia', 'minf', 'stbl');
  if (!stbl0 || (!mp4Find(stbl0.children, 'stco') && !mp4Find(stbl0.children, 'co64'))) return null;

  const hdlr = mp4Box('hdlr', Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('mdir', 'latin1'), Buffer.alloc(12),
  ]));
  const items = [];
  if (meta.title) items.push(mp4TextAtom('\u00a9nam', meta.title));
  if (meta.artist) items.push(mp4TextAtom('\u00a9ART', meta.artist));
  if (meta.album) items.push(mp4TextAtom('\u00a9alb', meta.album));
  items.push(mp4Box('covr', mp4DataBox(mime === 'image/png' ? 14 : 13, cover)));
  const metaBox = mp4Box('meta', Buffer.concat([
    Buffer.from([0, 0, 0, 0]), hdlr, mp4Box('ilst', Buffer.concat(items)),
  ]));
  const udta = mp4Box('udta', metaBox);

  const kids = moov.children.filter(n => n.type !== 'udta');
  const moovPayload = Buffer.concat([...kids.map(n => buf.subarray(n.start, n.end)), udta]);
  const newMoov = mp4Box('moov', moovPayload);
  const delta = newMoov.length - moov.size;

  // moov 在 mdat 之前时, 插入内容会把音频数据整体后移, 需要同步修正 chunk 偏移
  if (delta !== 0 && mdat.start > moov.start) {
    const nodes = mp4Parse(newMoov, 0, newMoov.length);
    const stbl = mp4FindPath(nodes, 'moov', 'trak', 'mdia', 'minf', 'stbl');
    const stco = stbl && mp4Find(stbl.children, 'stco');
    if (stco) {
      const p = stco.start + stco.header;
      const n = newMoov.readUInt32BE(p + 4);
      for (let i = 0; i < n; i++) {
        const at = p + 8 + i * 4;
        newMoov.writeUInt32BE(newMoov.readUInt32BE(at) + delta, at);
      }
    }
    const co64 = stbl && mp4Find(stbl.children, 'co64');
    if (co64) {
      const p = co64.start + co64.header;
      const n = newMoov.readUInt32BE(p + 4);
      const d = BigInt(delta);
      for (let i = 0; i < n; i++) {
        const at = p + 8 + i * 8;
        newMoov.writeBigUInt64BE(newMoov.readBigUInt64BE(at) + d, at);
      }
    }
  }

  const out = [];
  for (const n of top) out.push(n.type === 'moov' ? newMoov : buf.subarray(n.start, n.end));
  return Buffer.concat(out);
}
function imageMime(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  return '';
}
function embedCover(buf, ext, cover, meta) {
  if (!cover || !cover.buffer) return buf;
  try {
    if (ext === 'mp3') return embedMp3Cover(buf, cover.buffer, cover.mime, meta);
    if (ext === 'm4a') return mp4AddCover(buf, cover.buffer, cover.mime, meta) || buf;
  } catch (e) {
    logError('cover', e);
  }
  return buf;
}

// ---------- 封面: 解析用户选的图片 / 按歌名找图 ----------
const COVER_MAX_BYTES = 5 * 1024 * 1024;
async function fetchCoverBuffer(url, referer) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('图片地址不支持');
  if (isPrivateHost(u.hostname)) throw new Error('图片地址不支持');
  const buf = await req('GET', url, {
    'User-Agent': UA, 'Referer': referer || 'https://image.baidu.com/',
  }, null, true, 20000);
  if (buf.length > COVER_MAX_BYTES) throw new Error('图片太大, 请换一张小于 5MB 的');
  if (!imageMime(buf)) throw new Error('只支持 JPG / PNG 图片');
  return buf;
}
async function resolveCover(cover) {
  if (!cover) return null;
  try {
    if (cover.dataUrl) {
      const m = String(cover.dataUrl).match(/^data:image\/(jpeg|jpg|png);base64,([\s\S]+)$/i);
      if (!m) return null;
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > COVER_MAX_BYTES) return null;
      return { buffer: buf, mime: imageMime(buf) };
    }
    if (cover.url) {
      const buf = await fetchCoverBuffer(cover.url);
      return { buffer: buf, mime: imageMime(buf) };
    }
  } catch (e) {
    logError('cover', e);
  }
  return null;
}
// 封面候选只保留当前音源自带的图, 其余由用户本地上传
async function findCovers(pic) {
  if (!pic) return [];
  return [{
    url: pic, thumb: pic, source: '当前音源',
    proxy: '/api/cover/img?url=' + encodeURIComponent(pic),
  }];
}

// 按 chunk(样本组)边界把 m4a 切段, 每段重建 stts/stsc/stsz/stco, 返回 [{build()}]
function splitM4a(buf, maxBytes) {
  const top = mp4Parse(buf, 0, buf.length);
  const ftyp = mp4Find(top, 'ftyp');
  const moov = mp4Find(top, 'moov');
  const mdat = mp4Find(top, 'mdat');
  if (!ftyp || !moov || !mdat) return null;
  const stbl = mp4FindPath(moov.children, 'trak', 'mdia', 'minf', 'stbl');
  const mvhdN = mp4Find(moov.children, 'mvhd');
  const tkhdN = mp4FindPath(moov.children, 'trak', 'tkhd');
  const mdhdN = mp4FindPath(moov.children, 'trak', 'mdia', 'mdhd');
  if (!stbl || !mvhdN || !tkhdN || !mdhdN) return null;
  const sttsN = mp4Find(stbl.children, 'stts');
  const stscN = mp4Find(stbl.children, 'stsc');
  const stszN = mp4Find(stbl.children, 'stsz');
  const stcoN = mp4Find(stbl.children, 'stco');
  if (!sttsN || !stscN || !stszN || !stcoN || mp4Find(stbl.children, 'co64')) return null;

  const u32 = (o) => buf.readUInt32BE(o);
  const pStts = sttsN.start + sttsN.header;
  const pStsc = stscN.start + stscN.header;
  const pStsz = stszN.start + stszN.header;
  const pStco = stcoN.start + stcoN.header;
  const sttsRuns = [];
  for (let i = 0, n = u32(pStts + 4); i < n; i++) sttsRuns.push({ n: u32(pStts + 8 + i * 8), d: u32(pStts + 12 + i * 8) });
  const stsc = [];
  for (let i = 0, n = u32(pStsc + 4); i < n; i++) stsc.push({ first: u32(pStsc + 8 + i * 12), spc: u32(pStsc + 12 + i * 12), desc: u32(pStsc + 16 + i * 12) });
  if (!stsc.length) return null;
  const fixedSize = u32(pStsz + 4);
  const sampleCount = u32(pStsz + 8);
  const chunkCount = u32(pStco + 4);
  if (!chunkCount || !sampleCount) return null;
  const chunkOff = [], chunkSpc = [], chunkDesc = [];
  for (let c = 0; c < chunkCount; c++) chunkOff.push(u32(pStco + 8 + c * 4));
  let si = 0;
  for (let c = 0; c < chunkCount; c++) {
    while (si + 1 < stsc.length && stsc[si + 1].first - 1 <= c) si++;
    chunkSpc.push(stsc[si].spc);
    chunkDesc.push(stsc[si].desc);
  }
  const pref = [0];
  for (let c = 0; c < chunkCount; c++) pref.push(pref[c] + chunkSpc[c]);
  if (pref[chunkCount] !== sampleCount) return null;
  for (let c = 1; c < chunkCount; c++) if (chunkOff[c] < chunkOff[c - 1]) return null;

  const mdatEnd = mdat.start + mdat.size;
  const segs = [];
  for (let c0 = 0; c0 < chunkCount;) {
    let c1 = c0 + 1;
    while (c1 < chunkCount && chunkOff[c1] - chunkOff[c0] <= maxBytes) c1++;
    // c1 是首个超出上限的边界, 回退一格才是本段可用的结束边界
    if (c1 < chunkCount && chunkOff[c1] - chunkOff[c0] > maxBytes) c1--;
    if (c1 <= c0) return null;
    const end = c1 < chunkCount ? chunkOff[c1] : mdatEnd;
    if (end - chunkOff[c0] > maxBytes) return null;
    segs.push({ c0, c1, s0: pref[c0], s1: pref[c1], dataStart: chunkOff[c0], dataEnd: end });
    c0 = c1;
  }
  if (segs.length < 2) return null;

  const mvhdV = buf[mvhdN.start + mvhdN.header];
  const mdhdV = buf[mdhdN.start + mdhdN.header];
  const movieTimescale = u32(mvhdN.start + mvhdN.header + (mvhdV === 1 ? 20 : 12));
  const mediaTimescale = u32(mdhdN.start + mdhdN.header + (mdhdV === 1 ? 20 : 12));
  if (!movieTimescale || !mediaTimescale) return null;
  const ftypBuf = Buffer.from(buf.subarray(ftyp.start, ftyp.end));

  return segs.map(seg => ({
    build() {
      // 本段时长 (媒体时间基)
      const runs = [];
      let dur = 0, pos = 0;
      for (const r of sttsRuns) {
        const a = pos, b = pos + r.n;
        pos = b;
        if (b <= seg.s0) continue;
        if (a >= seg.s1) break;
        const n = Math.min(b, seg.s1) - Math.max(a, seg.s0);
        if (n <= 0) continue;
        dur += n * r.d;
        const last = runs[runs.length - 1];
        if (last && last.d === r.d) last.n += n; else runs.push({ n, d: r.d });
      }
      const sttsPayload = Buffer.alloc(8 + runs.length * 8);
      sttsPayload.writeUInt32BE(runs.length, 4);
      runs.forEach((r, i) => { sttsPayload.writeUInt32BE(r.n, 8 + i * 8); sttsPayload.writeUInt32BE(r.d, 12 + i * 8); });

      const stscRun = [];
      for (let c = seg.c0; c < seg.c1; c++) {
        const last = stscRun[stscRun.length - 1];
        if (!last || last.spc !== chunkSpc[c] || last.desc !== chunkDesc[c]) {
          stscRun.push({ first: c - seg.c0 + 1, spc: chunkSpc[c], desc: chunkDesc[c] });
        }
      }
      const stscPayload = Buffer.alloc(8 + stscRun.length * 12);
      stscPayload.writeUInt32BE(stscRun.length, 4);
      stscRun.forEach((r, i) => {
        stscPayload.writeUInt32BE(r.first, 8 + i * 12);
        stscPayload.writeUInt32BE(r.spc, 12 + i * 12);
        stscPayload.writeUInt32BE(r.desc, 16 + i * 12);
      });

      let stszPayload;
      if (fixedSize) {
        stszPayload = Buffer.alloc(12);
        stszPayload.writeUInt32BE(fixedSize, 4);
        stszPayload.writeUInt32BE(seg.s1 - seg.s0, 8);
      } else {
        const head = Buffer.alloc(12);
        head.writeUInt32BE(seg.s1 - seg.s0, 8);
        stszPayload = Buffer.concat([head, buf.subarray(pStsz + 12 + seg.s0 * 4, pStsz + 12 + seg.s1 * 4)]);
      }

      const movieDur = Math.round(dur * movieTimescale / mediaTimescale);
      const withDuration = (node, value) => {
        const b = Buffer.from(buf.subarray(node.start, node.end));
        const v1 = buf[node.start + node.header] === 1;
        const off = node.type === 'tkhd' ? (v1 ? 36 : 20) : (v1 ? 24 : 16);
        if (v1) b.writeBigUInt64BE(BigInt(value), node.header + off);
        else b.writeUInt32BE(value, node.header + off);
        return b;
      };
      const buildNode = (n, base) => {
        if (n.type === 'stbl') {
          const kids = [];
          for (const x of n.children) {
            if (x.type === 'stts') kids.push(mp4Box('stts', sttsPayload));
            else if (x.type === 'stsc') kids.push(mp4Box('stsc', stscPayload));
            else if (x.type === 'stsz') kids.push(mp4Box('stsz', stszPayload));
            else if (x.type === 'stco') {
              const cnt = seg.c1 - seg.c0;
              const p = Buffer.alloc(8 + cnt * 4);
              p.writeUInt32BE(cnt, 4);
              for (let i = 0; i < cnt; i++) p.writeUInt32BE(base + (chunkOff[seg.c0 + i] - seg.dataStart), 8 + i * 4);
              kids.push(mp4Box('stco', p));
            } else if (x.type === 'sgpd' || x.type === 'sbgp') continue; // 与新样本范围不一致, 丢弃
            else kids.push(Buffer.from(buf.subarray(x.start, x.end)));
          }
          return mp4Box('stbl', Buffer.concat(kids));
        }
        if (!n.children) return Buffer.from(buf.subarray(n.start, n.end));
        const kids = [];
        for (const x of n.children) {
          if (x.type === 'edts') continue; // 编辑列表基于原时间轴, 丢弃
          if (x.type === 'mvhd' || x.type === 'tkhd') kids.push(withDuration(x, movieDur));
          else if (x.type === 'mdhd') kids.push(withDuration(x, dur));
          else kids.push(buildNode(x, base));
        }
        return mp4Box(n.type, Buffer.concat(kids));
      };
      const moov0 = buildNode(moov, 0);
      const dataBase = ftypBuf.length + moov0.length + 8;
      const moovBuf = buildNode(moov, dataBase);
      const data = buf.subarray(seg.dataStart, seg.dataEnd);
      const mdHead = Buffer.alloc(8);
      mdHead.writeUInt32BE(data.length + 8, 0);
      mdHead.write('mdat', 4, 'latin1');
      return Buffer.concat([ftypBuf, moovBuf, mdHead, data]);
    },
  }));
}

// 上传一段音频: 超过 200MB 时按需拆分; 未确认拆分则抛出 needSplit 供前端弹窗
async function uploadAudioAuto({ buffer, ext, filename, song, artist, album, contentType, send, split, cover }) {
  if (buffer.length <= MAX_CLOUD_BYTES) {
    const up = await uploadBuffer({ buffer, ext, filename, song, artist, album, contentType, send, cover });
    return [{ song, songId: up.songId, instant: up.instant, size: buffer.length }];
  }
  const sizeMb = (buffer.length / 1048576).toFixed(0);
  if (!split) {
    const e = new Error(`文件 ${sizeMb}MB, 超过云盘单文件 200MB 上限`);
    e.needSplit = { size: buffer.length, ext, canSplit: ext === 'mp3' || ext === 'm4a' };
    throw e;
  }
  const target = MAX_CLOUD_BYTES - 8 * 1048576;
  let builders = null;
  if (ext === 'mp3') {
    const segs = splitMp3(buffer, target);
    if (segs) builders = segs.map(s => () => s);
  } else if (ext === 'm4a') {
    const segs = splitM4a(buffer, target);
    if (segs) builders = segs.map(s => s.build);
  }
  if (!builders || builders.length < 2) {
    throw new Error(ext === 'mp3' || ext === 'm4a'
      ? '这段音频的结构无法按段切分, 请换一期试试'
      : `这段音频是 ${ext} 格式, 超过 200MB 且暂不支持拆分; 请换一期 MP3 或 M4A 音源的节目`);
  }
  send(`文件 ${sizeMb}MB 超过单曲上限, 已按音频位置拆成 ${builders.length} 段`);
  const out = [];
  for (let i = 0; i < builders.length; i++) {
    const name = `${song} (${i + 1}/${builders.length})`;
    if (i > 0) { send('为避免平台限制, 等待5秒后继续...'); await sleep(5000); }
    const part = builders[i]();
    if (part.length > MAX_CLOUD_BYTES) throw new Error(`第 ${i + 1} 段仍有 ${(part.length / 1048576).toFixed(0)}MB, 超过单文件上限`);
    send(`--- 第 ${i + 1}/${builders.length} 段 (${(part.length / 1048576).toFixed(1)}MB) ---`);
    const up = await uploadBuffer({
      buffer: part, ext, filename: name + '.' + ext,
      song: name, artist, album: album || '', contentType, send, cover,
    });
    send(`✓ 第 ${i + 1}/${builders.length} 段完成${up.instant ? ' (秒传)' : ''}`);
    out.push({ song: name, songId: up.songId, instant: up.instant, size: part.length });
  }
  return out;
}

// 把封面写进磁盘上的音频文件: MP3 流式重写标签, M4A 只在中小文件上重排
// 返回最终使用的文件与大小; temp 是需要调用方删除的中间文件
async function applyCoverFile(src, size, ext, cover, meta, send) {
  if (!cover) return { file: src, size };
  if (ext === 'mp3') {
    const dst = src + '.cover.mp3';
    await writeMp3WithCover(src, dst, cover.buffer, cover.mime, meta);
    send('已写入歌曲封面');
    return { file: dst, size: fs.statSync(dst).size, temp: dst };
  }
  if (ext === 'm4a' && size <= 64 * 1024 * 1024) {
    const buf = fs.readFileSync(src);
    const out = embedCover(buf, ext, cover, { title: meta.title, artist: meta.artist, album: meta.album });
    if (out.length === buf.length) return { file: src, size };
    const dst = src + '.cover.m4a';
    fs.writeFileSync(dst, out);
    send('已写入歌曲封面');
    return { file: dst, size: out.length, temp: dst };
  }
  if (ext === 'm4a') send('文件较大, 为保证内存稳定已跳过写入封面');
  else send('该格式暂不支持写入封面, 已跳过');
  return { file: src, size };
}

// 上传磁盘上的音频文件: 200MB 以内全程流式; 只有需要拆分时才读进内存
async function uploadAudioFileAuto({ file, size, ext, filename, song, artist, album, contentType, send, split, cover }) {
  if (size > MAX_CLOUD_BYTES) {
    if (!split) {
      const e = new Error(`文件 ${(size / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
      e.needSplit = { size, ext, canSplit: ext === 'mp3' || ext === 'm4a' };
      throw e;
    }
    // 拆分要解析音频容器结构, 这一步才需要整块读入
    return uploadAudioAuto({ buffer: fs.readFileSync(file), ext, filename, song, artist, album, contentType, send, split: true, cover });
  }
  const applied = await applyCoverFile(file, size, ext, cover, { title: song, artist, album }, send);
  try {
    const md5 = await hashFile(applied.file, 'md5');
    const up = await uploadBuffer({
      file: applied.file, size: applied.size, md5, ext, filename, song, artist, album, contentType, send,
    });
    return [{ song, songId: up.songId, instant: up.instant, size: applied.size }];
  } finally {
    if (applied.temp) try { fs.unlinkSync(applied.temp); } catch (e) {}
  }
}

// 下载音频流: baseUrl 失败自动切换 backup_url (CDN 故障转移)
async function downloadAudio(stream, headers, send) {
  const urls = [stream.baseUrl, ...(stream.backup_url || [])].filter(Boolean);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      if (urls.length > 1) send(`正在从镜像线路下载 (${i + 1}/${urls.length})...`);
      return await req('GET', urls[i], headers, null, true);
    } catch (e) {
      lastErr = e;
      send('✗ 当前线路连接失败, 自动切换备用线路...');
    }
  }
  throw new Error('所有下载源均失败: ' + (lastErr ? lastErr.message : '未知'));
}
// 流式下载到磁盘文件, 内存只保留当前数据块; 返回字节数
function downloadToTempFile(url, headers, dest, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('音频地址无效')); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('重定向地址无效')); }
        try { if (isPrivateHost(new URL(next).hostname)) return reject(new Error('已拦截内网地址')); } catch (e) {}
        return resolve(downloadToTempFile(next, headers, dest, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('音频下载失败 (HTTP ' + res.statusCode + ')'));
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      res.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => { try { resolve(fs.statSync(dest).size); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => r.destroy(new Error('请求超时 (' + Math.round(timeoutMs / 1000) + '秒无响应)')));
    r.end();
  });
}
// B站音频: 优先线路失败时换备用线路, 全程边下边落盘
async function downloadAudioFile(stream, headers, send, dest) {
  const urls = [stream.baseUrl, ...(stream.backup_url || [])].filter(Boolean);
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    try {
      if (urls.length > 1) send(`正在从镜像线路下载 (${i + 1}/${urls.length})...`);
      return await downloadToTempFile(urls[i], headers, dest);
    } catch (e) {
      lastErr = e;
      send('✗ 当前线路连接失败, 自动切换备用线路...');
    }
  }
  throw new Error('所有下载源均失败: ' + (lastErr ? lastErr.message : '未知'));
}

// ---------- ffmpeg 转码兜底 ----------
// 优先使用随程序附带的 ffmpeg (打包后在 resources/bin), 找不到再回退系统 PATH
const FFMPEG_BIN = (() => {
  for (const p of [path.join(APP_DIR, 'bin', 'ffmpeg.exe'), path.join(APP_DIR, 'ffmpeg.exe')]) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
})();
let ffmpegOk = null; // null=未检测, true/false=缓存
function checkFfmpeg() {
  return new Promise(resolve => {
    if (ffmpegOk !== null) return resolve(ffmpegOk);
    try {
      execFile(FFMPEG_BIN, ['-version'], { timeout: 5000 }, err => {
        ffmpegOk = !err;
        resolve(ffmpegOk);
      }).on('error', () => { ffmpegOk = false; resolve(false); });
    } catch (e) { ffmpegOk = false; resolve(false); }
  });
}
// m4a → mp3: 走临时文件 (MP4 容器需可寻址输入, 管道不可靠), 用后即删
function transcodeMp3(buf) {
  return new Promise((resolve, reject) => {
    const inF = path.join(os.tmpdir(), 'GraySongICU_' + Date.now() + '.m4a');
    const outF = inF.replace(/\.m4a$/, '.mp3');
    try { fs.writeFileSync(inF, buf); } catch (e) { return reject(new Error('临时文件写入失败: ' + e.message)); }
    execFile(FFMPEG_BIN, ['-y', '-i', inF, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outF], { timeout: 300000 }, (err, so, se) => {
      try {
        if (err || !fs.existsSync(outF)) {
          reject(new Error('ffmpeg 转码失败: ' + String(se || (err && err.message) || '未知').trim().split('\n').pop().slice(0, 120)));
        } else resolve(fs.readFileSync(outF));
      } finally { try { fs.unlinkSync(inF); } catch (e) {} try { fs.unlinkSync(outF); } catch (e) {} }
    });
  });
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
  s = s.replace(/^[0-9]{1,4}[.、\-\s]+/, '').replace(/[【\[].*?[】\]]/g, '')
    .replace(/[（(]\s*(?:无损音质|高音质|无损|高清|完整版|修复版|HQ|Hi-Res)\s*[)）]/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  if (!s) return null;
  // 标题里任意位置出现《歌名》都算, 例如 【4K60P】周董《轨迹》最好听的版本！无与伦比演唱会
  const anyBm = s.match(/《([^》]{1,40})》/);
  if (anyBm) {
    const song = anyBm[1].trim() || s;
    const before = s.slice(0, anyBm.index).trim().replace(/[：:、,，\-–—~·\s]+$/, '');
    let after = s.slice(anyBm.index + anyBm[0].length).trim()
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/^[\-–—~·：:、,，\s]+/, '')
      .replace(/[！!。.\s].*$/, '')
      .trim();
    // 只把像人名的短片段当歌手, 版本/演唱会之类的描述直接忽略
    const usable = t => !!t && t.length <= 12 && !/版|演唱会|现场|翻唱|纯音乐|伴奏|合集|完整|高音质|无损|live|remix|cover/i.test(t);
    const artist = usable(before) ? before : (usable(after) ? after : null);
    return { song, artist };
  }
  const m = s.match(/^([^\-–—]{1,16}?)\s*[-–—]\s*(.{1,40})$/);
  if (m && m[1].trim() && m[2].trim() && !/版|翻唱|伴奏|cover|live|remix|纯音乐|钢琴|八音盒|串烧|混剪|DJ/i.test(m[2].trim()))
    return { song: m[2].trim(), artist: m[1].trim() };
  return { song: s.replace(/(?:无损音质|高音质|无损|高清|完整版)$/, '').trim(), artist: null };
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
// 合集页链接识别: space.bilibili.com/{mid}/channel/collectiondetail?sid={season_id} (或 ?season_id=)
function parseSeason(input) {
  const sid = (input.match(/[?&](?:sid|season_id)=(\d+)/) || [])[1];
  if (!sid) return null;
  const mid = (input.match(/space\.bilibili\.com\/(\d+)/) || [])[1];
  return { sid, mid: mid || null };
}
// 输入拆分: 多任务统一用逗号分隔(兼容换行), 数组原样用
function parseInputs(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[,，\r\n]+/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}
// 播客单集: 小宇宙 https://www.xiaoyuzhoufm.com/episode/{id}
// 苹果播客 https://podcasts.apple.com/cn/podcast/.../id{collectionId}?i={episodeId}
function parsePodcast(input) {
  const s = String(input || '');
  const xy = s.match(/xiaoyuzhoufm\.com\/episode\/([0-9a-zA-Z]+)/);
  if (xy) return { kind: 'xiaoyuzhou', id: xy[1], url: 'https://www.xiaoyuzhoufm.com/episode/' + xy[1] };
  const ap = s.match(/podcasts\.apple\.com\/[^?#]*\/id(\d+)(?:[^#]*?[?&]i=(\d+))?/i);
  if (ap) return {
    kind: 'apple',
    collectionId: ap[1],
    episodeId: ap[2] || null,
    url: 'https://podcasts.apple.com/cn/podcast/id' + ap[1] + (ap[2] ? '?i=' + ap[2] : ''),
  };
  return null;
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

async function podcastUpload(input, opts, send) {
  const pc = parsePodcast(input);
  if (!pc) throw new Error('无法解析播客链接: ' + input);
  if (pc.kind === 'apple') return applePodcastUpload(pc, opts, send);
  return xiaoyuzhouUpload(pc, opts, send);
}

// 苹果播客单集: 公开接口返回音频直链, 下载后复用云盘上传链路
async function applePodcastUpload(pc, opts, send) {
  send('正在获取播客信息...');
  let ep;
  const list = await appleEpisodes(pc.collectionId);
  if (!list.length) throw new Error('这个播客暂时没有公开音频的单集');
  if (pc.episodeId) {
    ep = list.find(x => x.episodeId === pc.episodeId);
    if (!ep) throw new Error('这期播客不在公开单集里（可能已下架或为付费内容）');
  } else {
    ep = list[0];
    send('没有指定单集, 将上传最新一期: ' + ep.name);
  }
  const probe = await probeAudio(ep.url, 'https://podcasts.apple.com/');
  const ext = extFromType(probe.contentType) || ((ep.url.match(/\.(mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)/i) || [])[1] || 'm4a').toLowerCase();
  const knownSize = probe.size;
  send(`「${ep.name}」 · ${ep.show}${knownSize ? ' · ' + (knownSize / 1048576).toFixed(1) + 'MB' : ''}`);
  if (knownSize > MAX_CLOUD_BYTES && !opts.split) {
    const e = new Error(`这期 ${(knownSize / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
    e.needSplit = { size: knownSize, ext, canSplit: ext === 'mp3' || ext === 'm4a', title: ep.name, pub: ep.show };
    throw e;
  }

  send('正在下载音频...');
  const songName = sanitize(opts.song || ep.name);
  const artist = sanitize(opts.artist || ep.show || '苹果播客');
  const dlFile = path.join(os.tmpdir(), 'gsi-pod-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext);
  try {
    const size = await downloadToTempFile(ep.url, { 'User-Agent': UA, 'Referer': 'https://podcasts.apple.com/' }, dlFile);
    if (!size) throw new Error('播客音频下载为空');
    if (size > MAX_CLOUD_BYTES && !opts.split) {
      const e = new Error(`这期 ${(size / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
      e.needSplit = { size, ext, canSplit: ext === 'mp3' || ext === 'm4a', title: ep.name, pub: ep.show };
      throw e;
    }
    send(`已下载 ${(size / 1048576).toFixed(2)}MB`);

    const ups = await uploadAudioFileAuto({
      file: dlFile, size, ext, filename: songName + '.' + ext,
      song: songName, artist, album: '', contentType: contentTypeFor(ext), send, split: !!opts.split,
      cover: opts.cover,
    });
    ups.forEach(u => appendHistory({ source: '播客', url: ep.link, song: u.song, artist, songId: u.songId, size: u.size }));
    send(`✓ 上传完成${ups.every(u => u.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
    return ups.map(u => ({ input: ep.link, song: u.song, songId: u.songId, ok: true, instant: u.instant }));
  } finally {
    try { fs.unlinkSync(dlFile); } catch (e) {}
  }
}

// 小宇宙播客单集: 页面公开 og:audio 直链, 下载后复用云盘上传链路
async function xiaoyuzhouUpload(pc, opts, send) {
  send('正在获取播客信息...');
  const page = await req('GET', pc.url, { 'User-Agent': UA, 'Referer': 'https://www.xiaoyuzhoufm.com/' });
  if (page.status !== 200) throw new Error('播客页面打开失败 (' + page.status + ')');
  const html = page.text;
  const meta = {};
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)="(og:[^"]+)"[^>]*content="([^"]*)"/g)) meta[m[1]] = m[2];
  const audioUrl = meta['og:audio'];
  if (!audioUrl) throw new Error('这期单集没有公开音频 (可能是付费或私密内容)');
  const title = decodeEntities(meta['og:title'] || '播客单集');
  const showName = decodeEntities((html.match(/听《([^》]+)》上小宇宙/) || [])[1] || '小宇宙播客');
  const ext = ((audioUrl.match(/\.(mp3|m4a|aac|flac|ogg)(?:\?|$)/i) || [])[1] || 'mp3').toLowerCase();
  const contentType = ext === 'mp3' ? 'audio/mpeg' : ext === 'flac' ? 'audio/flac' : 'audio/mp4';
  const sizeMatch = html.match(/"media":\{[^}]*?"size":(\d+)/);
  const knownSize = sizeMatch ? Number(sizeMatch[1]) : 0;
  send(`「${title}」 · ${showName}${knownSize ? ' · ' + (knownSize / 1048576).toFixed(1) + 'MB' : ''}`);
  // 页面已给出体积时提前询问, 避免白下载 200MB+
  if (knownSize > MAX_CLOUD_BYTES && !opts.split) {
    const e = new Error(`这期 ${(knownSize / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
    e.needSplit = { size: knownSize, ext, canSplit: ext === 'mp3' || ext === 'm4a', title, pub: showName };
    throw e;
  }

  send('正在下载音频...');
  const songName = sanitize(opts.song || title);
  const artist = sanitize(opts.artist || showName);
  const dlFile = path.join(os.tmpdir(), 'gsi-pod-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext);
  try {
    const size = await downloadToTempFile(audioUrl, { 'User-Agent': UA, 'Referer': 'https://www.xiaoyuzhoufm.com/' }, dlFile);
    if (!size) throw new Error('播客音频下载为空');
    if (size > MAX_CLOUD_BYTES && !opts.split) {
      const e = new Error(`这期 ${(size / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
      e.needSplit = { size, ext, canSplit: ext === 'mp3' || ext === 'm4a', title, pub: showName };
      throw e;
    }
    send(`已下载 ${(size / 1048576).toFixed(2)}MB`);

    const ups = await uploadAudioFileAuto({
      file: dlFile, size, ext, filename: songName + '.' + ext,
      song: songName, artist, album: '', contentType, send, split: !!opts.split,
      cover: opts.cover,
    });
    ups.forEach(u => appendHistory({ source: '播客', url: pc.url, song: u.song, artist, songId: u.songId, size: u.size }));
    send(`✓ 上传完成${ups.every(u => u.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
    return ups.map(u => ({ input: pc.url, song: u.song, songId: u.songId, ok: true, instant: u.instant }));
  } finally {
    try { fs.unlinkSync(dlFile); } catch (e) {}
  }
}

// ---------- 通用音频直链上传: 粘贴 https://...mp3/m4a 即可 ----------
function isPrivateHost(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (s === 'localhost' || s === '0.0.0.0' || s.endsWith('.local') || s === '::1') return true;
  if (s.includes(':')) return s === '::1' || s.startsWith('::ffff:') || /^(fc|fd|fe80)/i.test(s);
  if (/^127\./.test(s) || /^10\./.test(s) || /^192\.168\./.test(s) || /^169\.254\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(s)) return true;
  const m = s.match(/^172\.(\d+)\./);
  return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}
function parseAudioUrl(input) {
  const s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  if (/bilibili\.com|b23\.tv|xiaoyuzhoufm\.com|podcasts\.apple\.com/i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (isPrivateHost(u.hostname)) return null;
  const m = u.pathname.match(/\.(mp3|m4a|aac|flac|ogg|wav)$/i);
  return m ? { url: s, ext: m[1].toLowerCase() } : null;
}
async function audioUrlUpload(a, opts, send) {
  let u;
  try { u = new URL(a.url); } catch (e) { throw new Error('音频链接格式不正确'); }
  const probe = await probeAudio(a.url);
  const ext = extFromType(probe.contentType) || a.ext;
  let title = '';
  try { title = decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\.(mp3|m4a|aac|flac|ogg|wav)$/i, '')); }
  catch (e) { title = (u.pathname.split('/').pop() || '').replace(/\.(mp3|m4a|aac|flac|ogg|wav)$/i, ''); }
  title = sanitize(title || '音频文件');
  const knownSize = probe.size;
  if (knownSize > MAX_CLOUD_BYTES && !opts.split) {
    const e = new Error(`这个文件 ${(knownSize / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
    e.needSplit = { size: knownSize, ext, canSplit: ext === 'mp3' || ext === 'm4a', title, pub: '' };
    throw e;
  }
  send(`正在下载「${title}」...`);
  const songName = sanitize(opts.song || title);
  const artist = sanitize(opts.artist || '直链音频');
  // 播客入口下的直链归入播客, 避免把播客音频送进歌词批处理
  const source = opts.type === 'pod' ? '播客' : '直链';
  const dlFile = path.join(os.tmpdir(), 'gsi-url-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext);
  try {
    const size = await downloadToTempFile(a.url, { 'User-Agent': UA }, dlFile);
    if (!size) throw new Error('音频下载为空, 请检查链接');
    if (size > MAX_CLOUD_BYTES && !opts.split) {
      const e = new Error(`这个文件 ${(size / 1048576).toFixed(0)}MB, 超过云盘单文件 200MB 上限`);
      e.needSplit = { size, ext, canSplit: ext === 'mp3' || ext === 'm4a', title, pub: '' };
      throw e;
    }
    send(`已下载 ${(size / 1048576).toFixed(2)}MB`);

    const ups = await uploadAudioFileAuto({
      file: dlFile, size, ext, filename: songName + '.' + ext,
      song: songName, artist, album: '', contentType: contentTypeFor(ext), send, split: !!opts.split,
      cover: opts.cover,
    });
    ups.forEach(x => appendHistory({ source, url: a.url, song: x.song, artist, songId: x.songId, size: x.size }));
    send(`✓ 上传完成${ups.every(x => x.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
    return ups.map(x => ({ input: a.url, song: x.song, songId: x.songId, ok: true, instant: x.instant }));
  } finally {
    try { fs.unlinkSync(dlFile); } catch (e) {}
  }
}


// 合集页链接模式: 分页拉取合集全部视频后逐个上传 (seasons_archives_list 每页100)
async function seasonUpload({ sid, mid }, opts, send) {
  if (!mid) throw new Error('合集链接缺少UP主空间地址(mid), 请粘贴完整的合集页URL');
  const H = await biliHeaders();
  let pageNum = 1, archives = [], name = '合集' + sid, total = 0;
  while (true) {
    const j = await getJSON(`https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${sid}&page_num=${pageNum}&page_size=100`, H);
    if (j.code !== 0) throw new Error('合集信息获取失败: ' + (j.message || j.code));
    const d = j.data || {};
    if (d.meta && d.meta.name) name = d.meta.name;
    if (d.meta && d.meta.total) total = d.meta.total;
    const batch = d.archives || [];
    archives = archives.concat(batch);
    send(`拉取「${name}」: ${archives.length}${total ? '/' + total : ''} 个视频`);
    if (!batch.length || (total && archives.length >= total)) break;
    pageNum++;
    await sleep(800);
  }
  if (!archives.length) throw new Error('合集为空: ' + name);
  send(`合集「${name}」共 ${archives.length} 个视频, 开始上传`);
  const results = [];
  for (let i = 0; i < archives.length; i++) {
    if (i > 0) { send('为避免平台限制, 等待5秒后继续...'); await sleep(5000); }
    const bv = archives[i].bvid;
    send(`### [合集 ${i + 1}/${archives.length}] ${archives[i].title || bv} ###`);
    try {
      results.push(...await biliUpload(bv, { ...opts, season: false, _inner: true }, send));
    } catch (e) {
      if (e.needSplit) throw e;
      logError('upload', e);
      const errMsg = friendlyError(e);
      send(`✗ ${bv} 失败: ${errMsg}`);
      results.push({ input: bv, ok: false, error: errMsg });
      if (e.authFail || /-101/.test(e.message)) { send('B站登录已过期, 请在页面右上角重新登录; 已停止剩余视频'); break; }
    }
  }
  const ok = results.filter(r => r.ok).length;
  const instant = results.filter(r => r.ok && r.instant).length;
  send(`\n===== 合集「${name}」汇总: 成功 ${ok}/${results.length}${instant ? ' (秒传 ' + instant + ')' : ''} =====`);
  return results;
}

// 多任务调度: 每项可为视频BV/链接 或 合集页链接, 单项失败不中断, 结束总汇总
async function runJobs(inputs, opts, send) {
  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    if (i > 0) {
      // 批量时先单独传完第 1 条, 其余每条之间随机等待 6~9 秒, 降低连续请求带来的风控
      const wait = 6000 + Math.floor(Math.random() * 3000);
      send(`已完成 ${i}/${inputs.length} 条, 为避免平台限制等待 ${Math.round(wait / 1000)} 秒后继续...`);
      await sleep(wait);
    }
    const season = parseSeason(item);
    const podcast = parsePodcast(item);
    const audio = parseAudioUrl(item);
    try {
      if (podcast) {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务: 播客 #####`);
        results.push(...await podcastUpload(item, opts, send));
      } else if (season) {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务: 合集 #####`);
        results.push(...await seasonUpload(season, opts, send));
      } else if (audio) {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务: 音频直链 #####`);
        results.push(...await audioUrlUpload(audio, opts, send));
      } else {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务 #####`);
        results.push(...await biliUpload(item, opts, send));
      }
    } catch (e) {
      if (e.needSplit) throw e;
      logError('job', e);
      const errMsg = friendlyError(e);
      send(`✗ 任务失败: ${errMsg}`);
      results.push({ input: item, ok: false, error: errMsg });
      if (e.authFail || /-101/.test(e.message)) { send('登录已失效, 终止剩余任务'); break; }
    }
  }
  if (inputs.length > 1) {
    const ok = results.filter(r => r.ok).length;
    const instant = results.filter(r => r.ok && r.instant).length;
    send(`\n########## 总汇总: 成功 ${ok}/${results.length}${instant ? ' (秒传 ' + instant + ')' : ''} ##########`);
  }
  return results;
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

  // 合集模式: 视频属于 ugc_season 时展开合集内全部视频依次上传 (子任务 _inner=true 防递归)
  const ugc = view.data.ugc_season;
  if (ugc && !opts._inner) {
    const eps = (ugc.sections || []).flatMap(s => s.episodes || []).map(e => e.bvid).filter(Boolean);
    if (opts.season && eps.length > 1) {
      send(`合集模式: 「${ugc.title}」共 ${eps.length} 个视频, 依次上传`);
      const sub = [];
      for (let i = 0; i < eps.length; i++) {
        if (i > 0) { send('为避免平台限制, 等待5秒后继续...'); await sleep(5000); }
        send(`### [合集 ${i + 1}/${eps.length}] ${eps[i]} ###`);
        try {
          sub.push(...await biliUpload(eps[i], { ...opts, season: false, _inner: true }, send));
        } catch (e) {
          if (e.needSplit) throw e;
          logError('upload', e);
          const errMsg = friendlyError(e);
          send(`✗ ${eps[i]} 失败: ${errMsg}`);
          sub.push({ input: eps[i], ok: false, error: errMsg });
          if (e.authFail || /-101/.test(e.message)) { send('B站登录已过期, 请在页面右上角重新登录; 已停止剩余视频'); break; }
        }
      }
      const ok = sub.filter(r => r.ok).length;
      const instant = sub.filter(r => r.ok && r.instant).length;
      send(`\n===== 合集「${ugc.title}」汇总: 成功 ${ok}/${sub.length}${instant ? ' (秒传 ' + instant + ')' : ''} =====`);
      return sub;
    }
    if (eps.length > 1) send(`[提示] 该视频属于合集「${ugc.title}」(${eps.length}个视频), 需要整体上传时勾选"整个合集"`);
  }

  // 防御: B站对未登录请求偶发截断 pages 列表 (实测: 2P视频返回1P)
  const declared = view.data.videos || pages.length;
  if (declared > pages.length) {
    send(`⚠ 该视频的段落列表获取不完整 (共${declared}段只拿到${pages.length}段), 可能漏传; 登录B站账号后可改善`);
  }

  // 目标分P: 优先 pages 数组(任意范围), 其次 allPages, 最后单P/首个
  let targets = pages;
  const wantPages = Array.isArray(opts.pages) && opts.pages.length ? opts.pages.map(Number) : null;
  if (wantPages) {
    const want = new Set(wantPages);
    targets = pages.filter(p => want.has(p.page));
    if (!targets.length) throw new Error(`指定的分P ${wantPages.join(',')} 不存在 (接口返回了 ${pages.length}P${declared > pages.length ? ', 且列表不完整' : ''})`);
  } else if (!allPages) {
    targets = page ? pages.filter(p => p.page === page) : [pages[0]];
    if (!targets.length) throw new Error(`未找到分P ${page} (接口返回了 ${pages.length}P${declared > pages.length ? ', 且列表不完整' : ''})`);
  }
  send(`「${title}」 UP: ${owner.name} | ${allPages ? '共 ' + pages.length + ' 段音频' : wantPages ? '指定 ' + targets.length + ' 段' : '第 ' + targets[0].page + ' 段'}`);

  const results = [];
  const useClean = opts.clean !== false; // 智能清洗默认开启
  for (let i = 0; i < targets.length; i++) {
    const pg = targets[i];
    // 命名优先级: 手动指定 > (清洗开启时)清洗分P名 > 原始分P名 > 视频标题
    // 分P名是纯数字(UP主拿ID当分P名)时不采用, 回退到视频标题
    const partName = String(pg.part || '').trim();
    const usablePart = partName && !/^\d{5,}$/.test(partName);
    const rawName = usablePart && partName !== title ? partName : title;
    let songName, artist;
    if (opts.song) {
      songName = sanitize(opts.song);
      artist = sanitize(opts.artist || owner.name);
    } else {
      const cleaned = useClean ? cleanSongName(rawName) : null;
      songName = sanitize((cleaned && cleaned.song) || rawName);
      artist = sanitize(opts.artist || (cleaned && cleaned.artist) || owner.name);
    }
    if (i > 0) { send('为避免平台限制, 等待5秒后继续...'); await sleep(5000); }
    send(`\n=== [${i + 1}/${targets.length}] ${pg.part} ===`);

    // 单P失败不中断批量, 最后汇总; 登录失效类错误则提前终止
    try {
      const prev = readHistory().find(h => h.bvid === bvid && h.page === pg.page);
      if (prev) send(`[提示] 这段内容曾于 ${prev.time} 上传过, 云盘会自动秒传, 不重复占用空间`);

      send('正在获取音频 (最高音质)...');
      const play = await getJSON(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${pg.cid}&fnval=16&fnver=0&qn=0`, H);
      if (play.code === -101) throw new Error('B站登录已失效(-101): SESSDATA 过期或无效, 请在页面设置中更新或清空');
      if (play.code !== 0 || !play.data.dash) throw new Error('playurl失败: ' + (play.message || '无DASH流'));
      const { a, downgraded } = pickAudio(play.data.dash, quality);
      if (!a) throw new Error('无音频流');
      if (downgraded) send(`该视频最高只有 ${Math.round(a.bandwidth / 1000)}k 音质, 已自动选择`);
      else send(`音质: ${Math.round(a.bandwidth / 1000)}k`);
      if (!readBiliCookie() && a.id <= QUALITY_IDS['64k']) send('[提示] 未登录B站账号, 音质受限; 在页面右上角登录后音质更高');

      // 30251=Hi-Res(FLAC), 其余为 AAC(m4a); 专辑不写(留空给网易云/后续手动匹配)
      const ext = a.id === 30251 ? 'flac' : 'm4a';
      const dlFile = path.join(os.tmpdir(), 'gsi-bili-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext);
      let ups, size = 0;
      try {
        send('下载音频中...');
        size = await downloadAudioFile(a, H, send, dlFile);
        if (!size) throw new Error('音频下载为空, 请换一个音源试试');
        send(`已下载 ${(size / 1048576).toFixed(2)}MB`);
        try {
          ups = await uploadAudioFileAuto({
            file: dlFile, size, ext, filename: songName + '.' + ext,
            song: songName, artist, album: '', contentType: ext === 'flac' ? 'audio/flac' : 'audio/mp4', send, split: !!opts.split,
            cover: opts.cover,
          });
        } catch (e) {
          // m4a 被云盘拒绝时的转码兜底 (登录失效/需确认拆分时不重试; flac 原生支持无需兜底)
          if (ext !== 'm4a' || e.authFail || e.needSplit) throw e;
          if (!(await checkFfmpeg())) { send('[提示] 未检测到格式转换工具(ffmpeg), 无法自动转码'); throw e; }
          send('云盘不接收此格式, 正在转换格式后重试...');
          const mp3 = await transcodeMp3(fs.readFileSync(dlFile));
          const up = await uploadBuffer({
            buffer: mp3, ext: 'mp3', filename: songName + '.mp3',
            song: songName, artist, album: '', contentType: 'audio/mpeg', send, cover: opts.cover,
          });
          ups = [{ song: songName, songId: up.songId, instant: up.instant, size: mp3.length }];
        }
      } finally {
        try { fs.unlinkSync(dlFile); } catch (e) {}
      }
      ups.forEach(up => {
        results.push({ page: pg.page, song: up.song, songId: up.songId, ok: true, instant: up.instant });
        appendHistory({ bvid, page: pg.page, song: up.song, artist, songId: up.songId, size: up.size || size });
      });
      // 优先用B站自带字幕(与音源同源), 没有或对不上再联网匹配
      if (ups.length === 1 && pg.duration > 0) await attachBiliLyric(bvid, pg, songName, artist, send);
      send(`✓ 上传完成${ups.every(up => up.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
    } catch (e) {
      if (e.needSplit) throw e;
      logError('upload', e);
      const errMsg = friendlyError(e);
      send(`✗ 这一段失败: ${errMsg}`);
      results.push({ page: pg.page, song: songName, ok: false, error: errMsg });
      // 登录失效: 后续每P必然同样失败, 提前终止
      if (e.authFail || /-101/.test(e.message)) { send('B站登录已过期, 请在页面右上角重新登录; 已停止剩余段落'); break; }
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const instantCount = results.filter(r => r.ok && r.instant).length;
  // 内层任务(合集展开/多任务队列)不打印自身汇总, 由外层统一汇总
  if (!opts._inner) {
    send(`\n===== 汇总: 成功 ${okCount}/${targets.length}${instantCount ? ' (秒传 ' + instantCount + ')' : ''} =====`);
  }
  return results;
}

// ---------- 实时歌词: 系统媒体会话(SMTC) + 网易云歌词 ----------
// 只调用 Windows 公开 API(SMTC)读取歌名/歌手/播放状态, 不注入客户端、不读进程内存。
// 网易云不上报 TimelineProperties, 因此真实进度由前端"锚点+计时"推算。
let smProc = null, smKillTimer = null, smLastUse = 0;
let smState = { playing: false, title: '', artist: '', status: 'none' };
let pushState = null;
let pushLogged = false;
function pushFresh() { return !!pushState && Date.now() - pushState.atMs < 5000; }
function pushLivePos(now) {
  // 用单调锚点: 插件每秒都会推一次, 但真正的进度事件可能不触发(推上来的 pos 原地踏步),
  // 这时不能让 pos 每秒被重置回 0, 否则歌词永远停在第一句之前
  const base = Number(pushState.monoPos != null ? pushState.monoPos : pushState.pos) || 0;
  if (pushState.status === 'Paused') return base;
  let p = base + Math.max(0, now - (Number(pushState.monoAt) || now));
  if (pushState.dur > 0) p = Math.min(p, pushState.dur);
  return p;
}

const SM_PS = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$n = 'IAsyncOperation' + [char]96 + '1'",
  '$g = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $n })[0]',
  'function Await($op, $t) { $task = $g.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }',
  'while ($true) {',
  "  $line = '{\"playing\":false,\"title\":\"\",\"artist\":\"\",\"status\":\"none\"}'",
  '  $got = $false',
  '  try {',
  '    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '    foreach ($s in $mgr.GetSessions()) {',
  "      if ($s.SourceAppUserModelId -notmatch 'cloudmusic') { continue }",
  '      $pr = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
  '      $st = [string]$s.GetPlaybackInfo().PlaybackStatus',
  '      $pos = -1',
  '      $dur = 0',
  '      try { $pos = $s.GetTimelineProperties().Position.TotalSeconds; $dur = $s.GetTimelineProperties().EndTime.TotalSeconds } catch { }',
  "      $line = (@{ playing = ($st -eq 'Playing'); title = [string]$pr.Title; artist = [string]$pr.Artist; status = $st; src = 'smtc'; pos = $pos; dur = $dur } | ConvertTo-Json -Compress)",
  '      $got = $true',
  '      break',
  '    }',
  '  } catch { }',
  '  # fallback: when no SMTC session is found, read the main window title (Song - Artist)',
  '  if (-not $got) {',
  '    $p = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1',
  '    if ($p) {',
  '      $wt = [string]$p.MainWindowTitle',
  '      if ($wt) {',
  "        $parts = @($wt -split ' - ')",
  '        if ($parts.Count -ge 2) {',
  "          $line = (@{ playing = $true; title = $parts[0]; artist = $parts[1]; status = 'Playing'; src = 'title' } | ConvertTo-Json -Compress)",
  '        }',
  '      }',
  '    }',
  '  }',
  '  Write-Output $line',
  '  Start-Sleep -Milliseconds 500',
  '}',
].join('\r\n');

function ensureSmWatcher() {
  smLastUse = Date.now();
  if (pushFresh()) return; // 插件已在推送真实进度, 不必再拉起 PowerShell 轮询
  if (smProc) return;
  const p = path.join(os.tmpdir(), 'graysongicu_smtc.ps1');
  try { fs.writeFileSync(p, SM_PS, 'utf8'); } catch (e) { return; }
  try {
    smProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], { windowsHide: true });
  } catch (e) { smProc = null; return; }
  let buf = '';
  smProc.stdout.on('data', d => {
    buf += d.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const ln of parts) {
      const t = ln.trim();
      if (!t.startsWith('{')) continue;
      try {
        const o = JSON.parse(t);
        smState = {
          playing: !!o.playing, title: String(o.title || ''), artist: String(o.artist || ''),
          status: String(o.status || 'none'), src: String(o.src || ''),
          pos: Number.isFinite(o.pos) && o.pos >= 0 ? Number(o.pos) : -1,
          dur: Number.isFinite(o.dur) && o.dur > 0 ? Number(o.dur) : 0,
          posAt: Date.now() / 1000,
        };
      } catch (e) {}
    }
  });
  smProc.stderr.on('data', () => {});
  smProc.on('exit', () => { smProc = null; });
  if (!smKillTimer) {
    smKillTimer = setInterval(() => {
      if (smProc && Date.now() - smLastUse > 90 * 1000) {
        try { smProc.kill(); } catch (e) {}
        smProc = null;
      }
    }, 15000);
    if (smKillTimer.unref) smKillTimer.unref();
  }
}


// ---------- 桥接插件: 源码内嵌, 一键写入 BetterNCM 插件目录 ----------
const BRIDGE_MANIFEST = "{\n  \"$schema\": \"https://raw.githubusercontent.com/BetterNCM/BetterNCM-Plugins/refs/heads/master/manifest-schema.json\",\n  \"manifest_version\": 1,\n  \"name\": \"ICU Bridge\",\n  \"version\": \"1.0.0\",\n  \"author\": \"bili2ncm\",\n  \"ncm3-compatible\": true,\n  \"description\": \"把网易云当前歌曲与播放进度推送到本地 bili2ncm（实时歌词桥）\",\n  \"betterncm_version\": \">=1.0.0\",\n  \"injects\": {\n    \"Main\": [\n      {\n        \"file\": \"main.js\"\n      }\n    ]\n  }\n}";
const BRIDGE_JS_B64 = 'LyogSUNVIEJyaWRnZSDigJQg572R5piT5LqRIOKGkiBHcmF5U29uZ0lDVSDmnKzlnLDmrYzor43moaUKICoKICog5Y6f55CGKOenu+akjeiHqiBJbmZMaW5rLXJzIOWJjeerr+mDqOWIhiwg5pegIFJ1c3Qg5L6d6LWWKToKICogICAxLiDnlKggd2VicGFja0pzb25wIOazqOWFpeWBh+aooeWdlywg5ou/5Yiw572R5piT5LqR5YaF6YOo55qEIHdlYnBhY2sgcmVxdWlyZTsKICogICAyLiDlnKjmqKHlnZfnvJPlrZjph4zmib7liLDnp4HmnInnmoQgQnJpZGdlKE9ycGhldXNDb21tYW5kKSDlrp7kvos7CiAqICAgMy4g5LulICJhdWRpb3BsYXllciIg5ZG95ZCN56m66Ze05ZCRIEJyaWRnZSDov73liqAgUGxheVByb2dyZXNzIC8gUGxheVN0YXRlIC8gU2VlayDlm57osIMsCiAqICAgICAg6L+Z5qC35pei5ou/5Yiw55yf5a6e5pKt5pS+6L+b5bqmLCDlj4jkuI3kvJrpobbmjonlrqLmiLfnq6/oh6rlt7HnmoTov5vluqbmnaHnm5HlkKw7CiAqICAgNC4g5om+5YiwIGR2YSDnmoQgUmVkdXggc3RvcmUsIOS7jiBzdGF0ZS5wbGF5aW5nIOivu+WPlueyvuehruWFg+aVsOaNrijmrYzlkI0v5q2M5omLL+S4k+i+kS/mrYzmm7JJRC/ml7bplb8pOwogKiAgIDUuIOS7peavj+enkuS4jei2hei/hyAxIOasoeeahOmikeeOhyBQT1NUIOWIsCBodHRwOi8vMTI3LjAuMC4xOjMyMTAvYXBpL3B1c2jjgIIKICovCihmdW5jdGlvbiAoKSB7CglpZiAod2luZG93Ll9faWN1QnJpZGdlTG9hZGVkKSByZXR1cm47Cgl3aW5kb3cuX19pY3VCcmlkZ2VMb2FkZWQgPSB0cnVlOwoKCXZhciBUQUcgPSAnW0lDVS1CcmlkZ2VdJzsKCXZhciBQVVNIID0gJ2h0dHA6Ly8xMjcuMC4wLjE6MzIxMC9hcGkvcHVzaCc7Cgl2YXIgTlMgPSAnYXVkaW9wbGF5ZXInOwoKCWZ1bmN0aW9uIGxvZygpIHsKCQl0cnkgewoJCQljb25zb2xlLmxvZy5hcHBseShjb25zb2xlLCBbVEFHXS5jb25jYXQoW10uc2xpY2UuY2FsbChhcmd1bWVudHMpKSk7CgkJfSBjYXRjaCAoZSkge30KCX0KCgl2YXIgUyA9IHsKCQl0aXRsZTogJycsCgkJYXJ0aXN0OiAnJywKCQlhbGJ1bTogJycsCgkJbmNtSWQ6IDAsCgkJZHVyOiAwLAoJCXBvczogMCwKCQlwbGF5aW5nOiBmYWxzZSwKCQlrbm93bjogZmFsc2UsCgkJdHJhY2tJZDogJycKCX07Cgl2YXIgc3RvcmUgPSBudWxsOwoJdmFyIGxhc3RTZW50ID0gMDsKCXZhciBtaXNzTWV0YSA9IDA7CgoJLy8gLS0tLS0tLS0tLSB3ZWJwYWNrIC0tLS0tLS0tLS0KCWZ1bmN0aW9uIGdldFJlcXVpcmUoKSB7CgkJcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlKSB7CgkJCXZhciBpZCA9ICdfX2ljdWJyaWRnZV9fJyArIERhdGUubm93KCk7CgkJCXZhciB0cmllcyA9IDA7CgkJCXZhciBtb2QgPSB7fTsKCQkJbW9kW2lkXSA9IGZ1bmN0aW9uIChtLCBlLCByKSB7CgkJCQlyZXNvbHZlKHIpOwoJCQl9OwoJCQkoZnVuY3Rpb24gcG9sbCgpIHsKCQkJCXZhciB3ID0gd2luZG93LndlYnBhY2tKc29ucDsKCQkJCWlmICh3ICYmIHR5cGVvZiB3LnB1c2ggPT09ICdmdW5jdGlvbicpIHsKCQkJCQl0cnkgewoJCQkJCQlpZiAod1swXSAmJiBBcnJheS5pc0FycmF5KHdbMF0pKSB7CgkJCQkJCQl3LnB1c2goW1tpZF0sIG1vZCwgW1tpZF1dXSk7CgkJCQkJCX0gZWxzZSB7CgkJCQkJCQl3LnB1c2goW1tpZF0sIG1vZF0pOwoJCQkJCQl9CgkJCQkJCXJldHVybjsKCQkJCQl9IGNhdGNoIChlKSB7CgkJCQkJCWxvZygn5rOo5YWl5YGH5qih5Z2X5aSx6LSlJywgZSk7CgkJCQkJfQoJCQkJfQoJCQkJaWYgKCsrdHJpZXMgPiAyNDApIHsKCQkJCQlsb2coJ3dlYnBhY2tKc29ucCDkuI3lj6/nlKgsIOahpeaOpeacquWQr+WKqCcpOwoJCQkJCXJldHVybiByZXNvbHZlKG51bGwpOwoJCQkJfQoJCQkJc2V0VGltZW91dChwb2xsLCAyNTApOwoJCQl9KSgpOwoJCX0pOwoJfQoKCWZ1bmN0aW9uIGZpbmQocmVxLCB0ZXN0KSB7CgkJaWYgKCFyZXEgfHwgIXJlcS5jKSByZXR1cm4gbnVsbDsKCQlmb3IgKHZhciBrIGluIHJlcS5jKSB7CgkJCXZhciBtID0gcmVxLmNba107CgkJCWlmICghbSB8fCAhbS5leHBvcnRzKSBjb250aW51ZTsKCQkJdmFyIHJhdyA9IG0uZXhwb3J0czsKCQkJdmFyIGV4ID0gcmF3ICYmIHJhdy5kZWZhdWx0ID8gcmF3LmRlZmF1bHQgOiByYXc7CgkJCWlmIChleCAmJiB0ZXN0KGV4KSkgcmV0dXJuIGV4OwoJCX0KCQlyZXR1cm4gbnVsbDsKCX0KCglmdW5jdGlvbiBmaW5kQnJpZGdlKHJlcSkgewoJCS8vIOe9keaYk+S6keWGhemDqOacieWFqOWxgCBsZWdhY3lOYXRpdmVDbWRlciDkuI7np4HmnIkgQnJpZGdlIOS4pOS7veWunuS+izsKCQkvLyDlv4XpobvnlKjnp4HmnIkgQnJpZGdlLCDms6jlhozliLDlhajlsYDkvJropobnm5blrqLmiLfnq6/oh6rlt7HnmoTnm5HlkKzlr7zoh7Tov5vluqbmnaHpnZnmraIKCQl2YXIgZXggPSBmaW5kKHJlcSwgZnVuY3Rpb24gKG0pIHsKCQkJcmV0dXJuICEhKG0uQnJpZGdlICYmIHR5cGVvZiBtLkJyaWRnZS5hcHBlbmRSZWdpc3RlckNhbGwgPT09ICdmdW5jdGlvbicgJiYgdHlwZW9mIG0uQnJpZGdlLmNhbGwgPT09ICdmdW5jdGlvbicpOwoJCX0pOwoJCXJldHVybiBleCA/IGV4LkJyaWRnZSA6IG51bGw7Cgl9CgoJZnVuY3Rpb24gZmluZFN0b3JlKHJlcSkgewoJCXZhciBleCA9IGZpbmQocmVxLCBmdW5jdGlvbiAobSkgewoJCQlyZXR1cm4gISEobS5hICYmIHR5cGVvZiBtLmEgPT09ICdvYmplY3QnICYmIHR5cGVvZiBtLmEuZ2V0U3RvcmUgPT09ICdmdW5jdGlvbicpOwoJCX0pOwoJCWlmICghZXgpIHJldHVybiBudWxsOwoJCXZhciBhcHAgPSBleC5hLmFwcDsKCQlpZiAoYXBwICYmIGFwcC5fc3RvcmUgJiYgdHlwZW9mIGFwcC5fc3RvcmUuZ2V0U3RhdGUgPT09ICdmdW5jdGlvbicpIHJldHVybiBhcHAuX3N0b3JlOwoJCXRyeSB7CgkJCXZhciBzdCA9IGV4LmEuZ2V0U3RvcmUoKTsKCQkJaWYgKHN0ICYmIHR5cGVvZiBzdC5nZXRTdGF0ZSA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHN0OwoJCX0gY2F0Y2ggKGUpIHt9CgkJcmV0dXJuIG51bGw7Cgl9CgoJLy8gLS0tLS0tLS0tLSDlhYPmlbDmja4gLS0tLS0tLS0tLQoJZnVuY3Rpb24gcHVsbE1ldGEoKSB7CgkJaWYgKCFzdG9yZSkgcmV0dXJuOwoJCXRyeSB7CgkJCXZhciBzdCA9IHN0b3JlLmdldFN0YXRlKCkgfHwge307CgkJCXZhciBwID0gc3QucGxheWluZyB8fCB7fTsKCQkJdmFyIHRpZCA9IHAucmVzb3VyY2VUcmFja0lkID8gU3RyaW5nKHAucmVzb3VyY2VUcmFja0lkKSA6ICcnOwoJCQlpZiAoIXRpZCkgewoJCQkJLy8g6L+e57utIDEwIOenkumDveayoeacieW9k+WJjeabsuebriDihpIg6KeG5Li65YGc5q2i5pKt5pS+LCDkuLvliqjmuIXnqbosIOWFjeW+l+acjeWKoeerr+S4gOebtOaYvuekuuaXp+atjAoJCQkJbWlzc01ldGErKzsKCQkJCWlmIChTLmtub3duICYmIG1pc3NNZXRhID49IDEwKSB7CgkJCQkJUy5rbm93biA9IGZhbHNlOyBTLnRpdGxlID0gJyc7IFMuYXJ0aXN0ID0gJyc7IFMuYWxidW0gPSAnJzsKCQkJCQlTLm5jbUlkID0gMDsgUy50cmFja0lkID0gJyc7IFMucG9zID0gMDsgUy5kdXIgPSAwOwoJCQkJCXBvc3QoSlNPTi5zdHJpbmdpZnkoeyB0aXRsZTogJycsIGFydGlzdDogJycsIGFsYnVtOiAnJywgbmNtSWQ6IDAsIHBvczogMCwgZHVyOiAwLCBzdGF0dXM6ICdub25lJywgdDogRGF0ZS5ub3coKSB9KSk7CgkJCQl9CgkJCQlyZXR1cm47CgkJCX0KCQkJbWlzc01ldGEgPSAwOwoKCQkJdmFyIGFydGlzdHMgPSBBcnJheS5pc0FycmF5KHAucmVzb3VyY2VBcnRpc3RzKSA/IHAucmVzb3VyY2VBcnRpc3RzIDogW107CgkJCXZhciBuYW1lID0gU3RyaW5nKHAucmVzb3VyY2VOYW1lIHx8ICcnKTsKCQkJdmFyIGFydGlzdCA9IGFydGlzdHMubWFwKGZ1bmN0aW9uIChhKSB7IHJldHVybiBhICYmIGEubmFtZSA/IGEubmFtZSA6ICcnOyB9KS5maWx0ZXIoQm9vbGVhbikuam9pbignIC8gJyk7CgkJCXZhciBhbGJ1bSA9ICcnOwoJCQl2YXIgY3VyID0gcC5jdXJUcmFjayB8fCBudWxsOwoJCQlpZiAoY3VyICYmIGN1ci5hbGJ1bSkgYWxidW0gPSBTdHJpbmcoY3VyLmFsYnVtLmFsYnVtTmFtZSB8fCBjdXIuYWxidW0ubmFtZSB8fCAnJyk7CgkJCWlmICghYWxidW0pIGFsYnVtID0gU3RyaW5nKHAucmVzb3VyY2VBbGJ1bU5hbWUgfHwgJycpOwoJCQl2YXIgZHVyTXMgPSBjdXIgJiYgdHlwZW9mIGN1ci5kdXJhdGlvbiA9PT0gJ251bWJlcicgPyBjdXIuZHVyYXRpb24gOiAwOwoKCQkJaWYgKHRpZCAhPT0gUy50cmFja0lkKSB7CgkJCQlTLnRyYWNrSWQgPSB0aWQ7CgkJCQlTLnBvcyA9IDA7CgkJCX0KCQkJdmFyIG9ubGluZSA9IHAub25saW5lUmVzb3VyY2VJZCA/IFN0cmluZyhwLm9ubGluZVJlc291cmNlSWQpIDogdGlkOwoJCQl2YXIgZGlnaXRzID0gb25saW5lLm1hdGNoKC9cZCsvKTsKCQkJUy50aXRsZSA9IG5hbWUgfHwgUy50aXRsZTsKCQkJUy5hcnRpc3QgPSBhcnRpc3QgfHwgUy5hcnRpc3Q7CgkJCVMuYWxidW0gPSBhbGJ1bTsKCQkJUy5uY21JZCA9IGRpZ2l0cyA/IHBhcnNlSW50KGRpZ2l0c1swXSwgMTApIDogMDsKCQkJaWYgKGR1ck1zID4gMCkgUy5kdXIgPSBkdXJNcyAvIDEwMDA7CgkJCVMua25vd24gPSB0cnVlOwoJCQlTLnBsYXlpbmcgPSBwLnBsYXlpbmdTdGF0ZSA9PT0gMjsKCQl9IGNhdGNoIChlKSB7CgkJCWxvZygn6K+75Y+WIFJlZHV4IOWFg+aVsOaNruWksei0pScsIGUpOwoJCX0KCX0KCgkvLyAtLS0tLS0tLS0tIOi/m+W6puS6i+S7tiAtLS0tLS0tLS0tCglmdW5jdGlvbiBpc0N1cnJlbnQocGxheUlkKSB7CgkJaWYgKCFwbGF5SWQpIHJldHVybiB0cnVlOwoJCWlmICghUy50cmFja0lkKSByZXR1cm4gdHJ1ZTsKCQlwbGF5SWQgPSBTdHJpbmcocGxheUlkKTsKCQl2YXIgc2VwID0gcGxheUlkLnNlYXJjaCgvW198XS8pOwoJCXZhciBldklkID0gc2VwID49IDAgPyBwbGF5SWQuc2xpY2UoMCwgc2VwKSA6IHBsYXlJZDsKCQlpZiAoZXZJZC50b0xvd2VyQ2FzZSgpID09PSBTLnRyYWNrSWQudG9Mb3dlckNhc2UoKSkgcmV0dXJuIHRydWU7CgkJaWYgKHBsYXlJZC50b0xvd2VyQ2FzZSgpLmluZGV4T2YoUy50cmFja0lkLnRvTG93ZXJDYXNlKCkgKyAnXycpID09PSAwKSByZXR1cm4gdHJ1ZTsKCQlpZiAoUy5uY21JZCAmJiBldklkID09PSBTdHJpbmcoUy5uY21JZCkpIHJldHVybiB0cnVlOwoJCXJldHVybiBmYWxzZTsKCX0KCgkvLyDljp/nlJ/ovb3ojbc6IFtwbGF5SWQsIHJlc3VtZU9yUGF1c2VJZCwgc3RhdGVdICBzdGF0ZSAxPeaSreaUviAyPeaaguWBnCAzPemUmeivryAwLzQ95YGc5q2iCglmdW5jdGlvbiBvblBsYXlTdGF0ZShwbGF5SWQsIHJlc3VtZU9yUGF1c2VJZCwgc3RhdGUpIHsKCQlpZiAoc3RhdGUgPT09IDMpIHJldHVybjsKCQl2YXIgcGxheWluZzsKCQlpZiAoc3RhdGUgPT09IDEpIHBsYXlpbmcgPSB0cnVlOwoJCWVsc2UgaWYgKHN0YXRlID09PSAwIHx8IHN0YXRlID09PSAyIHx8IHN0YXRlID09PSA0KSBwbGF5aW5nID0gZmFsc2U7CgkJZWxzZSByZXR1cm47CgkJaWYgKFMucGxheWluZyAhPT0gcGxheWluZykgewoJCQlTLnBsYXlpbmcgPSBwbGF5aW5nOwoJCQlwdWxsTWV0YSgpOwoJCQlzZW5kKHRydWUpOwoJCX0KCX0KCgkvLyBbcGxheUlkLCBjdXJyZW50U2Vjb25kcywgY2FjaGVQcm9ncmVzcywgZm9yY2VdCglmdW5jdGlvbiBvblByb2dyZXNzKHBsYXlJZCwgY3VycmVudFNlY29uZHMpIHsKCQlpZiAoIWlzQ3VycmVudChwbGF5SWQpKSByZXR1cm47CgkJdmFyIHNlYyA9IE51bWJlcihjdXJyZW50U2Vjb25kcyk7CgkJaWYgKCFpc0Zpbml0ZShzZWMpIHx8IHNlYyA8IDApIHJldHVybjsKCQlTLnBvcyA9IHNlYzsKCQlzZW5kKGZhbHNlKTsKCX0KCgkvLyBbcGxheUlkLCBzZWVrSWQsIGNvZGUsIHBvc2l0aW9uU2Vjb25kc10KCWZ1bmN0aW9uIG9uU2VlayhwbGF5SWQsIHNlZWtJZCwgY29kZSwgcG9zaXRpb24pIHsKCQlpZiAoIWlzQ3VycmVudChwbGF5SWQpKSByZXR1cm47CgkJdmFyIHNlYyA9IE51bWJlcihwb3NpdGlvbik7CgkJaWYgKCFpc0Zpbml0ZShzZWMpIHx8IHNlYyA8IDApIHJldHVybjsKCQlTLnBvcyA9IHNlYzsKCQlzZW5kKHRydWUpOwoJfQoKCS8vIOWFnOW6lTog55SoIEF1ZGlvUGxheWVyIOeahOmrmOe6p+iuoumYheaOpeWPoyjkuI3norAgQnJpZGdlKQoJZnVuY3Rpb24gYmluZEF1ZGlvUGxheWVyKHJlcSkgewoJCXZhciBleCA9IGZpbmQocmVxLCBmdW5jdGlvbiAobSkgewoJCQlyZXR1cm4gISEobS5BdWRpb1BsYXllciAmJiB0eXBlb2YgbS5BdWRpb1BsYXllci5zdWJzY3JpYmVQbGF5U3RhdHVzID09PSAnZnVuY3Rpb24nKTsKCQl9KTsKCQlpZiAoIWV4KSByZXR1cm4gZmFsc2U7CgkJdmFyIFAgPSBleC5BdWRpb1BsYXllcjsKCQl0cnkgewoJCQlQLnN1YnNjcmliZVBsYXlTdGF0dXMoewoJCQkJdHlwZTogJ3BsYXlwcm9ncmVzcycsCgkJCQljYWxsYmFjazogZnVuY3Rpb24gKGkpIHsKCQkJCQlpZiAoaSAmJiBpc0N1cnJlbnQoaS5wbGF5SWQpKSB7CgkJCQkJCVMucG9zID0gTnVtYmVyKGkuY3VycmVudCkgfHwgMDsKCQkJCQkJc2VuZChmYWxzZSk7CgkJCQkJfQoJCQkJfQoJCQl9KTsKCQkJUC5zdWJzY3JpYmVQbGF5U3RhdHVzKHsKCQkJCXR5cGU6ICdwbGF5c3RhdGUnLAoJCQkJY2FsbGJhY2s6IGZ1bmN0aW9uIChpKSB7CgkJCQkJaWYgKCFpKSByZXR1cm47CgkJCQkJdmFyIHN0ID0gU3RyaW5nKGkuc3RhdGUgfHwgJycpOwoJCQkJCWlmIChzdCA9PT0gJ3BsYXknIHx8IHN0ID09PSAncmVzdW1lJykgUy5wbGF5aW5nID0gdHJ1ZTsKCQkJCQllbHNlIGlmIChzdCA9PT0gJ3BhdXNlJyB8fCBzdCA9PT0gJ2VuZCcpIFMucGxheWluZyA9IGZhbHNlOwoJCQkJCXNlbmQodHJ1ZSk7CgkJCQl9CgkJCX0pOwoJCQlQLnN1YnNjcmliZVBsYXlTdGF0dXMoewoJCQkJdHlwZTogJ3NlZWsnLAoJCQkJY2FsbGJhY2s6IGZ1bmN0aW9uIChpKSB7CgkJCQkJaWYgKGkgJiYgaXNDdXJyZW50KGkucGxheUlkKSkgewoJCQkJCQlTLnBvcyA9IE51bWJlcihpLnBvc2l0aW9uKSB8fCAwOwoJCQkJCQlzZW5kKHRydWUpOwoJCQkJCX0KCQkJCX0KCQkJfSk7CgkJCXJldHVybiB0cnVlOwoJCX0gY2F0Y2ggKGUpIHsKCQkJbG9nKCdBdWRpb1BsYXllciDorqLpmIXlpLHotKUnLCBlKTsKCQkJcmV0dXJuIGZhbHNlOwoJCX0KCX0KCgkvLyAtLS0tLS0tLS0tIOS4iuaKpSAtLS0tLS0tLS0tCglmdW5jdGlvbiBwb3N0KGJvZHkpIHsKCQl0cnkgewoJCQlpZiAodHlwZW9mIGZldGNoID09PSAnZnVuY3Rpb24nKSB7CgkJCQkvLyBuby1jb3JzICsgdGV4dC9wbGFpbjog566A5Y2V6K+35rGCLCDkuI3op6blj5HpooTmo4AKCQkJCWZldGNoKFBVU0gsIHsKCQkJCQltZXRob2Q6ICdQT1NUJywKCQkJCQltb2RlOiAnbm8tY29ycycsCgkJCQkJaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ3RleHQvcGxhaW4nIH0sCgkJCQkJYm9keTogYm9keQoJCQkJfSkuY2F0Y2goZnVuY3Rpb24gKCkge30pOwoJCQkJcmV0dXJuOwoJCQl9CgkJfSBjYXRjaCAoZSkge30KCQl0cnkgewoJCQl2YXIgeCA9IG5ldyBYTUxIdHRwUmVxdWVzdCgpOwoJCQl4Lm9wZW4oJ1BPU1QnLCBQVVNILCB0cnVlKTsKCQkJeC5zZXRSZXF1ZXN0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAndGV4dC9wbGFpbicpOwoJCQl4LnNlbmQoYm9keSk7CgkJfSBjYXRjaCAoZSkgewoJCQlsb2coJ+S4iuaKpeWksei0pScsIGUpOwoJCX0KCX0KCglmdW5jdGlvbiBzZW5kKGZvcmNlKSB7CgkJdmFyIG5vdyA9IERhdGUubm93KCk7CgkJaWYgKCFmb3JjZSAmJiBub3cgLSBsYXN0U2VudCA8IDQwMCkgcmV0dXJuOwoJCWlmICghUy5rbm93bikgcmV0dXJuOwoJCWxhc3RTZW50ID0gbm93OwoJCXBvc3QoSlNPTi5zdHJpbmdpZnkoewoJCQl0aXRsZTogUy50aXRsZSwKCQkJYXJ0aXN0OiBTLmFydGlzdCwKCQkJYWxidW06IFMuYWxidW0sCgkJCW5jbUlkOiBTLm5jbUlkLAoJCQlwb3M6IE1hdGgucm91bmQoUy5wb3MgKiAxMDApIC8gMTAwLAoJCQlkdXI6IE1hdGgucm91bmQoUy5kdXIgKiAxMDApIC8gMTAwLAoJCQlzdGF0dXM6IFMucGxheWluZyA/ICdQbGF5aW5nJyA6ICdQYXVzZWQnLAoJCQl0OiBub3cKCQl9KSk7Cgl9CgoJLy8gLS0tLS0tLS0tLSDlkK/liqggLS0tLS0tLS0tLQoJZ2V0UmVxdWlyZSgpLnRoZW4oZnVuY3Rpb24gKHJlcSkgewoJCWlmICghcmVxKSByZXR1cm47CgkJc3RvcmUgPSBmaW5kU3RvcmUocmVxKTsKCQlpZiAoc3RvcmUpIGxvZygn5bey6L+e5o6l572R5piT5LqRIFJlZHV4IHN0b3JlJyk7CgoJCXZhciBicmlkZ2UgPSBmaW5kQnJpZGdlKHJlcSk7CgkJaWYgKGJyaWRnZSkgewoJCQl0cnkgewoJCQkJYnJpZGdlLmFwcGVuZFJlZ2lzdGVyQ2FsbCgnUGxheVN0YXRlJywgTlMsIG9uUGxheVN0YXRlKTsKCQkJCWJyaWRnZS5hcHBlbmRSZWdpc3RlckNhbGwoJ1BsYXlQcm9ncmVzcycsIE5TLCBvblByb2dyZXNzKTsKCQkJCWJyaWRnZS5hcHBlbmRSZWdpc3RlckNhbGwoJ1NlZWsnLCBOUywgb25TZWVrKTsKCQkJCWxvZygn5bey5oyC5o6l5YaF6YOoIEJyaWRnZSDmkq3mlL7kuovku7YnKTsKCQkJfSBjYXRjaCAoZSkgewoJCQkJbG9nKCfms6jlhowgQnJpZGdlIOS6i+S7tuWksei0pScsIGUpOwoJCQkJYnJpZGdlID0gbnVsbDsKCQkJfQoJCX0KCQlpZiAoIWJyaWRnZSAmJiAhYmluZEF1ZGlvUGxheWVyKHJlcSkpIHsKCQkJbG9nKCfml6Dms5XorqLpmIXmkq3mlL7kuovku7YsIOS7heS4iuaKpeWFg+aVsOaNricpOwoJCX0KCgkJcHVsbE1ldGEoKTsKCQlzZW5kKHRydWUpOwoJCXNldEludGVydmFsKGZ1bmN0aW9uICgpIHsKCQkJaWYgKCFzdG9yZSkgc3RvcmUgPSBmaW5kU3RvcmUocmVxKTsKCQkJcHVsbE1ldGEoKTsKCQkJLy8g5pKt5pS+5Lit5q+P56eS6KGl5LiA5qyhKOi/m+W6puS6i+S7tuWBtuWPkee8uuWkseaXtuWFnOW6lSksIOaaguWBnOaXtuWPquS/nea0uwoJCQlzZW5kKHRydWUpOwoJCX0sIDEwMDApOwoJfSk7Cn0pKCk7Cg==';
const BRIDGE_PLUGIN_DIR = 'C:\\betterncm\\plugins';
const BRIDGE_PLUGIN_PATH = path.join(BRIDGE_PLUGIN_DIR, 'icu-bridge.plugin');

// ---------- 网易云 CDP 直连: 不用 BetterNCM 插件也能拿到真实进度 ----------
// DevTools 端口只能在进程启动那一刻打开, 所以网易云必须带 --remote-debugging-port 启动;
// 这里负责"注入同一段桥接代码 + 需要时重启网易云", 没端口时自动回退插件 / SMTC
const NCM_DEBUG_PORT = Number(process.env.ICU_NCM_PORT) || 9222;
const NCM_PAGE_PATH = '/orpheus/pub/app.html';
let cdpInjectedAt = 0, cdpErr = '', cdpBusy = false, cdpLastTry = 0, cdpLogOnce = false;
let cdpLastPushAt = 0, ncmAutoAt = 0;

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rq = http.get(url, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('返回格式异常')); } });
    });
    rq.setTimeout(timeoutMs || 1500, () => { try { rq.destroy(); } catch (e) {} reject(new Error('连接超时')); });
    rq.on('error', reject);
  });
}
function cdpTargets() {
  return httpGetJson('http://127.0.0.1:' + NCM_DEBUG_PORT + '/json', 1500);
}
// 在网易云渲染进程里执行一段表达式并拿到结果
function cdpEval(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch (e) {} reject(new Error('CDP 超时')); } }, timeoutMs || 6000);
    ws.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('CDP 连接失败')); } };
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      } catch (e) {}
    };
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (m.id === 2 && !done) {
          done = true; clearTimeout(timer); try { ws.close(); } catch (e) {}
          if (m.result && m.result.exceptionDetails) return reject(new Error('注入异常: ' + (m.result.exceptionDetails.text || '')));
          resolve(m.result && m.result.result);
        }
      } catch (e) {}
    };
  });
}
// 注入的就是内嵌插件源码, 只是多打一个 src:'cdp' 标记, 服务端据此优先采用
function bridgeSrcForCdp() {
  return Buffer.from(BRIDGE_JS_B64, 'base64').toString('utf8')
    .replace(/__icuBridgeLoaded/g, '__icuBridgeCdp')
    .replace(
      "status: S.playing ? 'Playing' : 'Paused',",
      "status: S.playing ? 'Playing' : 'Paused', src: 'cdp',"
    )
    // 网易云内部路由切换后模块缓存会换掉, 旧的 require 找不到 store 就再也拿不到元数据,
    // 这里定时重新取一次 require/store, 避免桥接"假死"后再也不上报
    .replace(
      'if (!store) store = findStore(req);',
      'if (!store && Date.now() - (window.__icuRetryAt || 0) > 4000) { window.__icuRetryAt = Date.now(); getRequire().then(function (r2) { if (r2) { req = r2; store = findStore(r2); } }); }'
    )
    // 心跳: 只有真正上报成功才刷新, 长时间没上报才允许再注入一份新实例
    .replace(
      'if (!S.known) return;',
      'if (!S.known) return;\n\t\twindow.__icuBridgeCdpAt = Date.now();'
    )
    .replace(
      'if (window.__icuBridgeCdp) return;',
      'if (window.__icuBridgeCdp && Date.now() - (window.__icuBridgeCdpAt || 0) < 20000) return;'
    );
}
async function ensureCdp() {
  if (cdpBusy || Date.now() - cdpLastTry < 3000) return;
  cdpBusy = true; cdpLastTry = Date.now();
  try {
    const list = await cdpTargets();
    const t = (list || []).filter(x => x.type === 'page' && String(x.url).indexOf(NCM_PAGE_PATH) >= 0)[0];
    if (!t) throw new Error('没找到网易云页面 (调试端口未开启?)');
    await cdpEval(t.webSocketDebuggerUrl, bridgeSrcForCdp(), 6000);
    cdpInjectedAt = Date.now(); cdpErr = '';
    if (!cdpLogOnce) { cdpLogOnce = true; console.log('[cdp] 已注入网易云渲染进程, 直连播放进度'); }
  } catch (e) { cdpErr = e.message; }
  cdpBusy = false;
}
function cdpFresh() { return Date.now() - cdpLastPushAt < 5000; }

// ---------- 网易云进程管理(找路径 / 是否运行 / 带参数重启) ----------
const NCM_REG_PS = "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\cloudmusic.exe' -ErrorAction SilentlyContinue).'(default)'";
function psRun(cmd, timeoutMs, extraEnv) {
  return new Promise(resolve => {
    const pre = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', pre + cmd],
      { timeout: timeoutMs || 20000, windowsHide: true, env: Object.assign({}, process.env, extraEnv || {}) },
      (err, stdout, stderr) => {
        resolve({ err: err ? err.message : '', out: String(stdout || '').trim(), errOut: String(stderr || '').trim() });
      });
  });
}
async function ncmExePath() {
  const cmds = [
    "if ($p = Get-Process cloudmusic -ErrorAction SilentlyContinue | Select-Object -First 1) { $p.Path }",
    NCM_REG_PS,
  ];
  for (const c of cmds) {
    const r = await psRun(c, 8000);
    const p = (r.out.split(/\r?\n/)[0] || '').trim();
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}
async function ncmRunning() {
  const r = await psRun("if (Get-Process cloudmusic -ErrorAction SilentlyContinue) { 'ON' } else { 'OFF' }", 8000);
  return r.out.indexOf('ON') >= 0;
}
// 读网易云进程的命令行, 判断这次是不是带 --remote-debugging-port 启动的
let ncmLaunch = { at: 0, running: false, withPort: false, port: 0, cmdline: '' };
async function ncmLaunchInfo(force) {
  if (!force && Date.now() - ncmLaunch.at < 15000) return ncmLaunch;
  const q = "$p = Get-CimInstance Win32_Process -Filter \"Name='cloudmusic.exe'\" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.CommandLine }";
  const r = await psRun(q, 10000);
  const line = (String(r.out || '').split(/\r?\n/)[0] || '').trim();
  const m = line.match(/--remote-debugging-port=(\d+)/i);
  ncmLaunch = { at: Date.now(), running: !!line, withPort: !!m, port: m ? Number(m[1]) : 0, cmdline: line };
  return ncmLaunch;
}
// 杀掉没带参数的网易云, 再用 WMI 创建一个脱离本进程的带参数实例(否则本命令一结束它就被回收)
async function ncmRelaunch() {
  const exe0 = await ncmExePath();
  if (!exe0) throw new Error('找不到网易云安装路径 (注册表里没有 App Paths)');
  const stop = await psRun("try { Stop-Process -Name cloudmusic -Force -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }", 15000);
  if (stop.out.indexOf('OK') < 0) throw new Error('无法结束网易云: ' + (stop.out || stop.errOut || '权限不足'));
  await new Promise(r => setTimeout(r, 2500));
  const argLine = '"' + exe0 + '" --remote-debugging-port=' + NCM_DEBUG_PORT;
  const cmd = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:ICU_NCM_CMD } | Select-Object -ExpandProperty ReturnValue';
  const r = await psRun(cmd, 15000, { ICU_NCM_CMD: argLine });
  if (r.out.indexOf('0') !== 0 && r.out !== '0') throw new Error('启动失败: ' + (r.out || r.errOut || r.err));
  let list = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r2 => setTimeout(r2, 1000));
    try { list = await cdpTargets(); if (list && list.length) break; } catch (e) {}
  }
  if (!list || !list.length) throw new Error('已启动, 但调试端口没起来(客户端可能忽略该参数)');
  ncmLaunch = { at: Date.now(), running: true, withPort: true, port: NCM_DEBUG_PORT, cmdline: argLine };
  await ensureCdp();
  return { exe: exe0, port: NCM_DEBUG_PORT };
}
// 每 6 秒: 端口在就注入; 都没有且没插件推送时, 自动带参数重启一次(60 秒内不重复)
async function ncmWatchdog() {
  if (cdpFresh()) return;
  await ensureCdp();
  if (pushFresh() || cdpFresh() || Date.now() - ncmAutoAt < 60000) return;
  if (!(await ncmRunning())) { await ncmLaunchInfo(true); return; }
  // 每次都验一次“是否带参数启动”: 带参数但仍注入失败就不再盲目重启, 只记录原因
  const li = await ncmLaunchInfo(true);
  if (li.withPort) {
    if (!cdpErr) cdpErr = '调试端口已开(' + li.port + ')但注入失败';
    return;
  }
  ncmAutoAt = Date.now();
  console.log('[cdp] 网易云未带 --remote-debugging-port 启动, 自动重启以启用直连…');
  try { await ncmRelaunch(); console.log('[cdp] 直连已启用'); }
  catch (e) { console.log('[cdp] 自动重启失败: ' + e.message); }
}


let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
// 最小 ZIP 写入(仅存储不压缩): .plugin 就是含 manifest.json + main.js 的 zip
function bridgeZip() {
  const files = [
    { name: 'manifest.json', data: Buffer.from(BRIDGE_MANIFEST, 'utf8') },
    { name: 'main.js', data: Buffer.from(BRIDGE_JS_B64, 'base64') },
  ];
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(parts), cd, eocd]);
}
function bridgePluginInstalled() {
  try { return fs.existsSync(BRIDGE_PLUGIN_PATH); } catch (e) { return false; }
}
function installBridgePlugin() {
  if (!fs.existsSync(BRIDGE_PLUGIN_DIR)) {
    throw new Error('没找到 ' + BRIDGE_PLUGIN_DIR + '，请先安装 BetterNCM');
  }
  fs.writeFileSync(BRIDGE_PLUGIN_PATH, bridgeZip());
  return BRIDGE_PLUGIN_PATH;
}

const LYRIC_CACHE = new Map();

// ---------- 歌词索引: 歌名|歌手 → 选定的网易云版本(按时长匹配) + 手动偏移 ----------
// 零依赖: 就是一个 JSON 文件, 比"每次重新猜版本"稳定得多
const LYRIDX_PATH = path.join(DIR, 'lyrics.json');
let lyridx = null, lyridxSaveTimer = null, lyridxAudited = false;
function lyridxLoad() {
  if (lyridx) return lyridx;
  try {
    const j = JSON.parse(fs.readFileSync(LYRIDX_PATH, 'utf8').replace(/^\uFEFF/, ''));
    lyridx = j && j.items ? j : { version: 1, items: {} };
  } catch (e) {
    lyridx = { version: 1, items: {} };
  }
  if (!lyridxAudited) auditLyridx();
  return lyridx;
}
// 装载时对磁盘缓存做一次二次校验: 边开发边测试留下的脏歌词不能一直沿用
function auditLyridx() {
  lyridxAudited = true;
  const items = lyridx.items || {};
  let dropped = 0;
  const samples = [];
  for (const k of Object.keys(items)) {
    const it = items[k];
    if (!it || !it.lrc) continue;
    const durSec = (Number(it.audioDurMs) || Number(it.durMs) || 0) / 1000;
    const v = lrcAudit(it.lrc, { durSec, minLines: 3 });
    if (!v.ok) {
      delete items[k];
      dropped++;
      if (samples.length < 5) samples.push((it.name || k) + '(' + v.reason + ')');
    }
  }
  // 修复历史遗留的坏 key: 空歌手键与记录字段不一致、重复项、测试/乱码条目
  for (const k of Object.keys(items)) {
    const it = items[k];
    if (!it) continue;
    const name = String(it.name || '').trim();
    if (!name || /^[?？]+$/.test(name) || /zztest/i.test(k)) { delete items[k]; dropped++; continue; }
    // 只有空歌手键才可能是 key 与记录不一致; 正常键以查询时的歌名/歌手为准, 不能按记录改
    if (!k.endsWith('|')) continue;
    const nk = lyricKey(name, it.artist);
    if (nk === k) continue;
    if (!items[nk]) items[nk] = it;
    delete items[k];
    dropped++;
  }
  if (!dropped) return;
  try {
    fs.writeFileSync(LYRIDX_PATH, JSON.stringify(lyridx, null, 2), 'utf8');
    console.log('[歌词] 启动校验清理/修正歌词索引 ' + dropped + ' 条: ' + samples.join('、'));
  } catch (e) { console.log('[歌词] 启动校验清理失败: ' + e.message); }
}
function lyricKey(title, artist) { return normTitle(title) + '|' + normTitle(artist); }
function lyrIdxGet(title, artist) {
  const it = lyridxLoad().items;
  return it[lyricKey(title, artist)] || null;
}
function lyrIdxSaveSoon() {
  if (lyridxSaveTimer) return;
  lyridxSaveTimer = setTimeout(() => {
    lyridxSaveTimer = null;
    try {
      const it = lyridxLoad().items;
      const keys = Object.keys(it);
      if (keys.length > 500) {
        // 超上限时淘汰最久没动过的记录
        keys.sort((a, b) => (it[a].updatedAt || 0) - (it[b].updatedAt || 0));
        for (const k of keys.slice(0, keys.length - 500)) delete it[k];
      }
      fs.writeFileSync(LYRIDX_PATH, JSON.stringify(lyridx, null, 2), 'utf8');
    } catch (e) {}
  }, 400);
}
function lyrIdxPut(title, artist, patch) {
  if (!title) return null;
  // 写入前二次校验: 脏歌词宁可不存, 也不能污染索引后被反复读出来
  if (patch && patch.lrc) {
    const durSec = (Number(patch.audioDurMs) || Number(patch.durMs) || 0) / 1000;
    const v = lrcAudit(patch.lrc, { durSec, minLines: 3 });
    if (!v.ok) {
      console.log('[歌词] 拒绝写入脏数据: ' + title + ' (' + v.reason + ')');
      return null;
    }
  }
  const it = lyridxLoad().items;
  const k = lyricKey(title, artist);
  const rec = it[k] || { name: title, artist: artist || '', offset: 0 };
  Object.assign(rec, patch, { updatedAt: Date.now() });
  it[k] = rec;
  lyrIdxSaveSoon();
  return rec;
}
function lyrIdxDrop(title, artist) {
  const it = lyridxLoad().items;
  const k = lyricKey(title, artist);
  if (it[k]) { delete it[k]; lyrIdxSaveSoon(); }
}
function lyrIdxOffset(title, artist) {
  const r = lyrIdxGet(title, artist);
  return r && typeof r.offset === 'number' ? r.offset : 0;
}
async function lyricBySongId(id) {
  const j = await ncmReq('/api/song/lyric', { id, lv: -1, tv: -1, kv: -1 });
  return { lrc: ((j || {}).lrc || {}).lyric || '', tlrc: ((j || {}).tlyric || {}).lyric || '' };
}
// 已知真实音频时长时, 优先选时长最接近的候选(同名不同版本是歌词错位的根源)
function pickCands(cands, durSec) {
  // 同名优先: 时长再接近, 也不能挑到另一首歌的歌词
  const sameTitle = c => (c.ts === 4 ? 0 : 1);
  return cands.slice().sort((a, b) => {
    const ta = sameTitle(a), tb = sameTitle(b);
    if (ta !== tb) return ta - tb;
    if (!(durSec > 0)) return b.sc - a.sc;
    const da = Math.abs((a.song.dt || 0) / 1000 - durSec);
    const db = Math.abs((b.song.dt || 0) / 1000 - durSec);
    if (Math.abs(da - db) > 0.5) return da - db;
    return b.sc - a.sc;
  });
}
// 导入时预先关联歌词版本: 此刻能拿到 B 站音频的精确时长
async function indexLyricForSong(title, artist, durSec, send) {
  try {
    const old = lyrIdxGet(title, artist);
    if (old && old.manual) { if (send) send('[歌词] 已保留手动校准的版本'); return; }
    const cands = pickCands(await ncmSongCands(title, artist), durSec);
    if (!cands.length) { if (send) send('[歌词] 没找到可匹配的版本, 播放时会再试'); return; }
    for (const c of cands.slice(0, 6)) {
      const r = await lyricBySongId(c.song.id);
      const v = lrcAudit(r.lrc, { durSec, minLines: 5 });
      if (!v.ok) continue;
      const rec = lyrIdxPut(title, artist, {
        songId: String(c.song.id), name: c.song.name || title, artist: c.artist,
        durMs: c.song.dt || 0, audioDurMs: Math.round((durSec || 0) * 1000),
        lrc: r.lrc, tlrc: r.tlrc,
      });
      if (!rec) continue;
      if (send) send('[歌词] 已关联「' + (c.song.name || title) + '」 ' + Math.round((c.song.dt || 0) / 1000) + 's (本段 ' + Math.round(durSec || 0) + 's)');
      return;
    }
    if (send) send('[歌词] 找到的版本没有可用歌词');
  } catch (e) {
    logError('lyric', e);
    if (send) send('[歌词] 关联失败: ' + friendlyError(e));
  }
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_·・.。,，!？!?'"“”‘’()（）\[\]【】]/g, '');
}

// ---------- B站字幕 → LRC (方案3: 导入时把与音源同源的字幕时间轴存进本地) ----------
// 注意: B站的 AI 字幕经常是解说词/剧情对白, 不是歌词, 必须和网易云歌词做文本比对才敢落库
async function biliSubtitle(bvid, cid, H) {
  const j = await getJSON(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, H);
  if (j.code !== 0 || !j.data || !j.data.subtitle) return null;
  const subs = (j.data.subtitle.subtitles || []).filter(s => s && s.subtitle_url);
  if (!subs.length) return null;
  // 人工中文字幕优先, AI 中文其次, 其余最后
  const rank = s => (/^ai/i.test(String(s.lan || '')) ? 1 : 0);
  subs.sort((a, b) => rank(a) - rank(b));
  const s0 = subs[0];
  let u = String(s0.subtitle_url);
  if (u.startsWith('//')) u = 'https:' + u;
  const sj = await getJSON(u, { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' });
  const body = Array.isArray(sj && sj.body) ? sj.body : [];
  if (!body.length) return null;
  return { lan: String(s0.lan || ''), lanDoc: String(s0.lan_doc || ''), body };
}
function lrcTime(s) {
  const t = Math.max(0, Number(s) || 0);
  const m = Math.floor(t / 60), sec = t - m * 60;
  return '[' + String(m).padStart(2, '0') + ':' + (sec < 10 ? '0' : '') + sec.toFixed(2) + ']';
}
function subtitleToLrc(body) {
  const out = [];
  for (const it of body) {
    // 歌词视频常用 ♪ 装饰首尾, 去掉后再入库, 免得歌词窗里都是音符
    const t = String(it.content || '').replace(/\s+/g, ' ').replace(/^[♪♫\s]+|[♪♫\s]+$/g, '').trim();
    const from = Number(it.from);
    if (!t || !isFinite(from) || from < 0 || from > 21600) continue;
    out.push(lrcTime(from) + t);
  }
  return out.join('\n');
}
// 字幕至少要像"一句一句的短句", 解说词那种长句/口水话在这里先筛掉一轮
function looksLikeLyrics(body) {
  const lines = body.map(x => String(x.content || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const lens = lines.map(s => s.length).sort((a, b) => a - b);
  const mid = lens[Math.floor(lens.length / 2)] || 0;
  return mid <= 30;
}
// 搜不到网易云参考歌词时的严格启发式: 行数/行长/句末标点/解说词特征/时间覆盖都要像歌词
function lyricLikeSubtitle(body, durSec) {
  const lines = body.map(x => String(x.content || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length < 10) return false;
  const lens = lines.map(s => s.length).sort((a, b) => a - b);
  const mid = lens[Math.floor(lens.length / 2)] || 0;
  if (mid < 4 || mid > 26) return false;
  // 解说词句末常带句号/感叹号, 歌词很少逐句带标点
  const punct = lines.filter(s => /[。！？；]$/.test(s)).length / lines.length;
  if (punct > 0.35) return false;
  const narr = /^(大家好|欢迎(来到|收看)|本期|这期|下期|记得(点赞|关注)|一键三连|字幕(由|组)|可以看到|接下来|镜头|画面|剧情|解说)/;
  if (lines.some(s => narr.test(s))) return false;
  if (durSec > 0) {
    let from = Infinity, to = -1;
    for (const it of body) {
      const f = Number(it.from), t = Number(it.to);
      if (isFinite(f)) from = Math.min(from, f);
      if (isFinite(t)) to = Math.max(to, t);
    }
    if (!(to > from)) return false;
    if (from > durSec * 0.3) return false;
    if (to < durSec * 0.6) return false;
  }
  return true;
}
// 字符二元组覆盖率: 歌词 ASR 文本和官方歌词会有同音误差, 但不会像"解说词"那样几乎不沾边
function textOverlap(a, b) {
  const grams = s => {
    const set = new Set();
    const t = String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}
function lrcPlain(lrc) {
  return String(lrc || '').split('\n').map(l => l.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '')).join(' ');
}
// 只尝试B站自带字幕: 人工CC直接信任; AI字幕先和网易云参考比对, 搜不到再走严格启发式
async function tryBiliSubtitle(bvid, pg, songName, artist, send) {
  try {
    const sub = await biliSubtitle(bvid, pg.cid, await biliHeaders());
    if (!(sub && looksLikeLyrics(sub.body))) {
      if (send) send('[歌词] B站没有可用字幕');
      return false;
    }
    const lrc = subtitleToLrc(sub.body);
    const humanCc = !/^ai/i.test(sub.lan);
    let ok = humanCc;
    let ov = 0;
    let verify = humanCc ? 'human' : 'matched';
    let refFound = false;
    if (!ok) {
      // AI 字幕: 优先和网易云歌词比对; 搜不到参考时再用严格启发式(标记未校对)
      const ref = await lyricFor(songName, artist, pg.duration).catch(() => null);
      refFound = !!(ref && ref.ok);
      if (refFound) {
        ov = textOverlap(lrc, ref.lrc);
        ok = ov >= 0.18;
      } else {
        ok = lyricLikeSubtitle(sub.body, pg.duration);
        if (ok) verify = 'none';
      }
    }
    if (ok) {
      const v = lrcAudit(lrc, { durSec: pg.duration, minLines: 5 });
      if (v.ok) {
        const rec = lyrIdxPut(songName, artist, {
          name: songName, artist, songId: '',
          durMs: Math.round((pg.duration || 0) * 1000), audioDurMs: Math.round((pg.duration || 0) * 1000),
          lrc, tlrc: '', manual: true, source: 'bilibili', verify,
          bvid, cid: pg.cid, biliLan: sub.lanDoc || sub.lan,
        });
        if (rec) {
          LYRIC_CACHE.delete(songName + '|' + artist);
          const tag = verify === 'none' ? '(未校对, 播放时会提示)' : '与音源同源';
          if (send) send('[歌词] 已保存B站字幕(' + (sub.lanDoc || sub.lan || '字幕') + ' · ' + v.lines + ' 句, ' + tag + ')');
          return true;
        }
      }
    } else if (send) {
      send(refFound
        ? '[歌词] B站字幕和歌词对不上(重合 ' + Math.round(ov * 100) + '%)'
        : '[歌词] B站字幕不像歌词');
    }
  } catch (e) {
    logError('lyric', e);
    if (send) send('[歌词] B站字幕读取失败: ' + friendlyError(e));
  }
  return false;
}
// 导入一段音频后: 先尝试 B站自带字幕, 通过校验就落库; 否则回退到联网匹配
async function attachBiliLyric(bvid, pg, songName, artist, send) {
  if (await tryBiliSubtitle(bvid, pg, songName, artist, send)) return true;
  await indexLyricForSong(songName, artist, pg.duration, send);
  return false;
}

// ---------- 手动离线预转: 用本地 whisper 听一遍 B站音频, 为没有时间轴的歌生成时间戳 ----------
// 只在用户点「补时间轴」时跑单首, 不排队不自动; 结果标记 verify:'none', 播放时会提示未校对
let sttBusy = false;
let sttChild = null, sttStopping = false;
function findHistoryBySong(title, artist, anySource) {
  const list = readHistory();
  const nt = normTitle(title), na = normTitle(artist);
  if (!nt) return null;
  const byTitle = [];
  for (const h of list) {
    if (!h) continue;
    if (!anySource && (!h.bvid || !h.page)) continue;
    const hs = normTitle(h.song);
    if (!hs) continue;
    if (!(hs === nt || hs.includes(nt) || nt.includes(hs))) continue;
    byTitle.push(h);
    const ha = normTitle(h.artist || '');
    if (!na || !ha || ha === na || ha.includes(na) || na.includes(ha)) return h;
  }
  return byTitle[0] || null;
}
// whisper 的 segment 是"按停顿/标点切开的句子", 直接当歌词会一行太长, 长句按标点拆开并按字数分摊时间
// 单字重复很多次的"寂寂寂…"是 whisper 在纯音乐段的典型幻觉, 直接丢掉
function segmentsToLrc(segments) {
  const out = [];
  for (const s of segments || []) {
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^(谢谢观看|字幕由|请订阅|感谢观看|字幕组|未经授权)/.test(text)) continue;
    if (/^(.)\1{7,}$/.test(text)) continue;                 // 整行单字重复≥8次的幻觉
    const counts = {};
    let top = 0;
    for (const ch of text) { counts[ch] = (counts[ch] || 0) + 1; if (counts[ch] > top) top = counts[ch]; }
    if (text.length > 10 && top / text.length > 0.7) continue; // 同一个字占了整行七成以上
    const st = Math.max(0, Number(s.start) || 0);
    const en = Math.max(st + 0.1, Number(s.end) || st + 1);
    if (text.length <= 30 || !/[，,。；;！？!?、]/.test(text)) {
      out.push({ t: st, text });
      continue;
    }
    const parts = text.split(/[，,。；;！？!?、]+/).map(x => x.trim()).filter(x => x.length >= 2);
    if (parts.length < 2) { out.push({ t: st, text }); continue; }
    const total = parts.reduce((n, x) => n + x.length, 0) || 1;
    let cur = st;
    for (const p of parts) {
      out.push({ t: cur, text: p });
      cur += (en - st) * (p.length / total);
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out.map(x => lrcTime(x.t) + x.text).join('\n');
}
function parseEarResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  let lastErr = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (!l.startsWith('{')) continue;
    let o = null;
    try { o = JSON.parse(l); } catch (e) { continue; }
    if (o && o.type === 'error') lastErr = o.message || '识别失败';
    if (o && o.type === 'result') return o;
  }
  return lastErr ? { type: 'error', message: lastErr } : null;
}
async function biliPageInfo(bvid, page) {
  const H = await biliHeaders();
  const view = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, H);
  if (view.code !== 0) throw new Error('B站视频信息获取失败: ' + view.message);
  const pages = (view.data && view.data.pages) || [];
  const pg = pages.find(p => Number(p.page) === Number(page)) || pages[0];
  if (!pg) throw new Error('B站视频里找不到这段音频');
  return { pg, title: (view.data && view.data.title) || '' };
}
// whisper.cpp 直接读 flac/mp3/ogg/wav, 输出 JSON 到 <prefix>.json
function runCppAsr(a, file, send) {
  return new Promise((resolve, reject) => {
    const prefix = file + '.out';
    const outJson = prefix + '.json';
    try { fs.unlinkSync(outJson); } catch (e) {}
    const threads = Math.max(2, Math.min(8, (os.cpus() || []).length || 4));
    const args = ['-m', a.model, '-f', file, '-l', 'zh', '-t', String(threads), '-oj', '-of', prefix, '-np'];
    sttStopping = false;
    sttChild = execFile(a.cli, args,
      { cwd: path.dirname(a.cli), timeout: 900000, maxBuffer: 32 * 1048576, windowsHide: true },
      (err, so, se) => {
        sttChild = null;
        let raw = '';
        try { raw = fs.readFileSync(outJson, 'utf8'); } catch (e) {}
        try { fs.unlinkSync(outJson); } catch (e) {}
        if (err && !raw) {
          if (sttStopping) return reject(new Error('__canceled__'));
          const tail = String(se || err.message || '').trim().split(/\r?\n/).pop();
          return reject(new Error('本地识别失败: ' + (tail || err.message).slice(0, 160)));
        }
        let j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        if (!j) return reject(new Error('本地识别失败: 没有返回结果'));
        const segs = (j.transcription || []).map(x => ({
          start: (Number(x.offsets && x.offsets.from) || 0) / 1000,
          end: (Number(x.offsets && x.offsets.to) || 0) / 1000,
          text: String(x.text || '').trim(),
        })).filter(x => x.text);
        if (!segs.length) return reject(new Error('本地识别失败: 没有听清这段音频'));
        resolve(segs);
      });
  });
}
// whisper 转写一个本地音频文件, 通过校验后写入歌词索引
async function whisperFileToLyric(tmp, durSec, title, artist, send, extra) {
  let timer = null;
  const started = Date.now();
  if (sttBusy) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error('本地识别正在忙, 请稍后再试'); }
  const a = asrReady();
  if (!a.ready) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error('还没有安装语音识别组件, 请点右上角「歌词」→ 底部「补时间轴」下载'); }
  sttBusy = true;
  try {
    let segments = null;
    timer = setInterval(() => {
      send('[补时间轴] 识别中… 已等待 ' + Math.round((Date.now() - started) / 1000) + 's');
    }, 10000);
    if (timer.unref) timer.unref();
    if (a.backend === 'cpp') {
      segments = await runCppAsr(a, tmp, send);
    } else {
      const stdout = await new Promise((resolve, reject) => {
        sttStopping = false;
        sttChild = execFile(ASR_PY, [ASR_SCRIPT, '--model', 'base', '--file', tmp],
          { timeout: 900000, maxBuffer: 32 * 1048576, windowsHide: true },
          (err, so, se) => {
            sttChild = null;
            if (err && !String(so || '').trim()) {
              if (sttStopping) return reject(new Error('__canceled__'));
              const tail = String(se || err.message || '').trim().split(/\r?\n/).pop();
              return reject(new Error('本地识别失败: ' + (tail || err.message).slice(0, 160)));
            }
            resolve(String(so || ''));
          });
      });
      const o = parseEarResult(stdout);
      if (!o || o.type === 'error') throw new Error('本地识别失败: ' + ((o && o.message) || '没有返回结果'));
      segments = o.segments;
    }
    const lrc = segmentsToLrc(segments);
    const v = lrcAudit(lrc, { durSec, minLines: 5 });
    if (!v.ok) throw new Error('识别结果不像完整歌词(' + v.reason + '), 没有保存');
    const rec = lyrIdxPut(title, artist, {
      name: title, artist, songId: extra.songId || '',
      durMs: Math.round(durSec * 1000), audioDurMs: Math.round(durSec * 1000),
      lrc, tlrc: '', manual: true, source: 'whisper', verify: 'none',
      bvid: extra.bvid || '', cid: extra.cid || '',
    });
    if (!rec) throw new Error('识别结果没通过校验, 没有保存');
    appendLyricHistory({ song: title, artist, lines: v.lines, source: '离线识别' });
    LYRIC_CACHE.delete(title + '|' + artist);
    if (live.title === title && live.artist === artist) {
      liveLoad(live.key, live.title, live.artist, pushFresh() ? pushState.dur : 0);
    }
    send('[补时间轴] 完成: ' + v.lines + ' 句已保存, 来源为语音转写(未校对)');
    return { lines: v.lines, duration: Math.round(durSec), bvid: extra.bvid || '', page: extra.page || 1 };
  } finally {
    sttBusy = false;
    if (timer) clearInterval(timer);
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}
async function sttLyricForSong(title, artist, send, pre) {
  const asr = asrReady();
  if (!asr.ready) throw new Error('还没有安装语音识别组件, 请点右上角「歌词」→ 底部「补时间轴」下载');
  // 拆分上传的分段只有一段音频, 拿整首时间轴会错位, 直接拒绝, 不写脏数据
  if (/[（(]\d+\s*\/\s*\d+[）)]/.test(title)) {
    throw new Error('这是超过 200MB 拆分上传的分段，时间轴无法可靠对齐，暂不支持补时间轴；请用完整的那一首');
  }
  if (sttBusy) throw new Error('本地识别正在忙, 请稍后再试');
  const h = (pre && pre.h) || findHistoryBySong(title, artist, true);
  if (!h) throw new Error('上传历史里找不到这首歌, 无法取回音频; 请先确认它是由本工具上传的');
  // whisper.cpp 读不了 m4a: 优先从云盘取回整首 flac/mp3
  if (asr.backend === 'cpp' && h.songId) return sttLyricFromCloud(title, artist, send, h);
  // 没有B站音源(非播客的其他来源): 改用网易云云盘里自己上传的那份音频
  if (!h.bvid || !h.page) return sttLyricFromCloud(title, artist, send, h);
  send('[补时间轴] 找到音源: ' + h.bvid + ' 第' + h.page + '段 (' + (h.time || '') + ')');
  let info = (pre && pre.pg) ? pre : null;
  if (!info) {
    send('[补时间轴] 读取B站视频信息…');
    info = await biliPageInfo(h.bvid, h.page);
  }
  const pg = info.pg;
  const H = await biliHeaders();
  if (!(pg.duration > 0)) throw new Error('这段音频时长未知, 无法生成时间轴');
  // 播客/长音频不做自动转写: 一首要跑很久, 且时间轴对播客没有意义
  if (pg.duration > 1800) throw new Error('这段音频超过 30 分钟，不自动补时间轴（播客这类长音频不适用）');
  send('[补时间轴] 取音频: ' + (pg.part || info.title || '') + ' · ' + Math.round(pg.duration) + 's');
  const play = await getJSON(`https://api.bilibili.com/x/player/playurl?bvid=${h.bvid}&cid=${pg.cid}&fnval=16&fnver=0&qn=0`, H);
  if (play.code === -101) throw new Error('B站登录已失效(-101), 请先更新B站cookie');
  if (play.code !== 0 || !play.data.dash) throw new Error('playurl失败: ' + (play.message || '无DASH流'));
  const picked = pickAudio(play.data.dash, 'best');
  if (!picked || !picked.a) throw new Error('这段音频没有可下载的音频流');
  if (asr.backend === 'cpp' && picked.a.id !== 30251) {
    throw new Error('这段 B 站音源是 m4a 格式，本地识别组件读不了；请先把这首歌传到云盘后再补时间轴');
  }
  const buf = await downloadAudio(picked.a, H, send);
  send('[补时间轴] 已取到音频 ' + (buf.length / 1048576).toFixed(2) + 'MB, 开始本地识别(可能要几分钟, 请不要关闭页面)');
  const ext = picked.a.id === 30251 ? '.flac' : '.m4a';
  const tmp = path.join(os.tmpdir(), 'graysongicu_stt_' + Date.now() + ext);
  try { fs.writeFileSync(tmp, buf); }
  catch (e) { throw new Error('临时文件写入失败: ' + e.message); }
  return await whisperFileToLyric(tmp, pg.duration, title, artist, send, { bvid: h.bvid, cid: pg.cid });
}
// 从网易云云盘取回自己上传的那份音频再转写(适合没有B站音源的歌)
async function sttLyricFromCloud(title, artist, send, h0) {
  const a = asrReady();
  if (!a.ready) throw new Error('本地转写不可用(' + a.reason + ')');
  const h = h0 || findHistoryBySong(title, artist, true);
  if (!h) throw new Error('上传历史里找不到这首歌, 无法取回音频');
  if (!h.songId) throw new Error('上传历史里没有网易云 songId, 无法取回音频');
  send('[补时间轴] 从网易云云盘取回音频…');
  const r = await ncmReq('/api/song/enhance/player/url/v1', { ids: '[' + Number(h.songId) + ']', level: 'standard', encodeType: 'flac' });
  const d = (r && r.data && r.data[0]) || null;
  if (r.code !== 200 || !d || !d.url) throw new Error('网易云取音频失败(' + ((r && r.code) || '无播放地址') + ')');
  const send2 = m => send(m);
  send2('[补时间轴] 已获取播放地址, 开始下载…');
  const buf = await req('GET', d.url, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }, null, true);
  const dur = Number(d.time) > 0 ? Number(d.time) / 1000 : 0;
  if (dur > 1800) throw new Error('这段音频超过 30 分钟，不自动补时间轴');
  send2('[补时间轴] 已取到音频 ' + (buf.length / 1048576).toFixed(2) + 'MB, 开始本地识别(可能要几分钟, 请不要关闭页面)');
  const ty = String(d.type || '');
  const ext = /flac/i.test(ty) ? '.flac' : /mp3|mpeg/i.test(ty) ? '.mp3' : /m4a|mp4|aac/i.test(ty) ? '.m4a' : '.mp3';
  if (a.backend === 'cpp' && ext === '.m4a') throw new Error('这首歌的云盘音频是 m4a 格式，本地识别组件读不了；换一首试试');
  const tmp = path.join(os.tmpdir(), 'graysongicu_stt_' + Date.now() + ext);
  try { fs.writeFileSync(tmp, buf); }
  catch (e) { throw new Error('临时文件写入失败: ' + e.message); }
  return await whisperFileToLyric(tmp, dur, title, artist, send, { songId: h.songId });
}

// ---------- 批量补歌词: 点「歌词」按钮后自动跑, 补上传历史里本机缺歌词的歌 ----------
// 顺序: 先抓B站同源字幕(时间轴最准) → 再找网易云歌词(秒级) → 都没有才用 whisper 听B站音源; 全程可停止
let LYR_BATCH = { running: false, canceled: false, total: 0, done: 0, okBili: 0, okNet: 0, okStt: 0, failed: 0, skipped: 0, current: '', lastSaved: '', log: [], startedAt: 0, finishedAt: 0, asrReady: true, asrReason: '' };
function lyrBatchCandidates() {
  const seen = new Set();
  const out = [];
  for (const h of readHistory()) {
    const title = String((h && h.song) || '').trim();
    const artist = String((h && h.artist) || '').trim();
    if (!title) continue;
    const key = lyricKey(title, artist);
    if (seen.has(key)) continue;
    seen.add(key);
    // 播客不做本地转写; 其他没有B站音源的歌仍可从网易云云盘取回音频转写
    const isPod = (h.source === '播客') || /xiaoyuzhoufm\.com/i.test(String(h.url || ''));
    if (isPod) continue;
    if (/[（(]\d+\s*\/\s*\d+[）)]/.test(title)) { out.push({ title, artist, skip: '拆分上传的分段' }); continue; }
    const idx = lyrIdxGet(title, artist);
    if (idx && idx.lrc) {
      const v = lrcAudit(idx.lrc, { durSec: Number(idx.audioDurMs || idx.durMs || 0) / 1000, minLines: 3 });
      if (v.ok) continue; // 本机已有可用歌词
    }
    out.push({ title, artist });
  }
  return out;
}
function lyrBatchSnap() {
  return {
    running: LYR_BATCH.running, canceled: LYR_BATCH.canceled,
    total: LYR_BATCH.total, done: LYR_BATCH.done,
    online: LYR_BATCH.okNet, stt: LYR_BATCH.okStt, bili: LYR_BATCH.okBili,
    failed: LYR_BATCH.failed, skipped: LYR_BATCH.skipped,
    current: LYR_BATCH.current, lastSaved: LYR_BATCH.lastSaved, startedAt: LYR_BATCH.startedAt, finishedAt: LYR_BATCH.finishedAt,
    asrReady: LYR_BATCH.asrReady, asrReason: LYR_BATCH.asrReason,
    log: LYR_BATCH.log.slice(-15),
  };
}
function lyrBatchLog(m) {
  LYR_BATCH.log.push(m);
  if (LYR_BATCH.log.length > 200) LYR_BATCH.log.splice(0, LYR_BATCH.log.length - 200);
  console.log('[批量歌词] ' + m);
}
async function lyrBatchRun(list) {
  const asr = asrReady();
  LYR_BATCH = { running: true, canceled: false, total: list.length, done: 0, okBili: 0, okNet: 0, okStt: 0, failed: 0, skipped: 0, current: '', lastSaved: '', log: [], startedAt: Date.now(), finishedAt: 0, asrReady: asr.ready, asrReason: asr.reason };
  lyrBatchLog('开始批量补歌词: ' + list.length + ' 首');
  if (!asr.ready) lyrBatchLog('本地转写不可用(' + asr.reason + '), 只补 B站字幕和网易云歌词');
  for (const it of list) {
    if (LYR_BATCH.canceled) break;
    LYR_BATCH.current = it.title + (it.artist ? ' · ' + it.artist : '');
    if (it.skip) {
      LYR_BATCH.skipped++; LYR_BATCH.done++;
      lyrBatchLog('[' + LYR_BATCH.done + '/' + LYR_BATCH.total + '] 跳过「' + it.title + '」: ' + it.skip);
      continue;
    }
    try {
      const h = findHistoryBySong(it.title, it.artist, true);
      if (!h) throw new Error('上传历史里找不到音源记录');
      let pre = null, dur = 0, hasBili = !!(h.bvid && h.page);
      if (hasBili) {
        const info = await biliPageInfo(h.bvid, h.page);
        pre = { h, pg: info.pg, title: info.title };
        if (!(info.pg.duration > 0)) throw new Error('音频时长未知');
        if (info.pg.duration > 1800) {
          LYR_BATCH.skipped++; LYR_BATCH.done++;
          lyrBatchLog('[' + LYR_BATCH.done + '/' + LYR_BATCH.total + '] 跳过「' + it.title + '」: 超过 30 分钟的音频');
          continue;
        }
        dur = info.pg.duration;
        // 1) B站自带字幕: 与音源同源, 时间轴最准
        lyrBatchLog('[' + (LYR_BATCH.done + 1) + '/' + LYR_BATCH.total + '] 先找B站字幕「' + it.title + '」…');
        if (await tryBiliSubtitle(h.bvid, info.pg, it.title, it.artist, m => lyrBatchLog('  ' + m))) {
          LYR_BATCH.okBili++;
          LYR_BATCH.lastSaved = it.title + '|' + it.artist;
          LYR_BATCH.done++;
          lyrBatchLog('  B站字幕已保存');
          if (!LYR_BATCH.canceled) await new Promise(r => setTimeout(r, 1200));
          continue;
        }
      } else {
        lyrBatchLog('[' + (LYR_BATCH.done + 1) + '/' + LYR_BATCH.total + '] 「' + it.title + '」没有B站音源, 先找网易云歌词…');
      }
      // 2) 网易云歌词匹配
      lyrBatchLog('  找网易云歌词…');
      const r = await lyricFor(it.title, it.artist, dur);
      if (r && r.ok) {
        LYR_BATCH.okNet++;
        LYR_BATCH.lastSaved = it.title + '|' + it.artist;
        lyrBatchLog('  网易云歌词已保存(' + r.lines + ' 句' + (r.warn ? ' · ' + r.warn : '') + ')');
      } else if (!asr.ready) {
        // 没有 Python 环境: 跳过本地转写, 不计入失败
        LYR_BATCH.skipped++; LYR_BATCH.done++;
        lyrBatchLog('  网易云也没有歌词, 本地转写不可用(' + asr.reason + '), 跳过');
        if (!LYR_BATCH.canceled) await new Promise(r => setTimeout(r, 1200));
        continue;
      } else {
        // 3) 都没有才用本地 whisper 听音频
        lyrBatchLog('  网易云没有可用歌词(' + ((r && (r.error || r.reason)) || '未知原因') + '), 最后用本地转写…');
        const s = await sttLyricForSong(it.title, it.artist, m => lyrBatchLog('  ' + m), pre);
        LYR_BATCH.okStt++;
        LYR_BATCH.lastSaved = it.title + '|' + it.artist;
        lyrBatchLog('  本地转写已保存(' + s.lines + ' 句, 未校对)');
      }
      LYR_BATCH.done++;
    } catch (e) {
      if (e.message === '__canceled__') { LYR_BATCH.canceled = true; break; }
      LYR_BATCH.failed++; LYR_BATCH.done++;
      logError('lyric-batch', e);
      lyrBatchLog('  失败: ' + friendlyError(e));
    }
    if (!LYR_BATCH.canceled) await new Promise(r => setTimeout(r, 1200));
  }
  LYR_BATCH.current = '';
  LYR_BATCH.running = false;
  LYR_BATCH.finishedAt = Date.now();
  lyrBatchLog('批量补歌词结束: B站字幕 ' + LYR_BATCH.okBili + ' · 网易云 ' + LYR_BATCH.okNet + ' · 本地 ' + LYR_BATCH.okStt + ' · 失败 ' + LYR_BATCH.failed + ' · 跳过 ' + LYR_BATCH.skipped + (LYR_BATCH.canceled ? ' (已停止)' : ''));
}
function lyrBatchStart() {
  if (LYR_BATCH.running) return { started: false, running: true, total: LYR_BATCH.total };
  const list = lyrBatchCandidates();
  if (!list.length) return { started: false, running: false, total: 0 };
  lyrBatchRun(list);
  return { started: true, running: true, total: list.length };
}
function lyrBatchStop() {
  if (!LYR_BATCH.running) return false;
  LYR_BATCH.canceled = true;
  sttStopping = true;
  if (sttChild) { try { sttChild.kill(); } catch (e) {} }
  return true;
}

// 一次性校准: 截图网易云窗口 → 系统 OCR 读播放条时间 → 返回真实进度(秒)
// 旁挂读取, 不注入客户端; 窗口最小化或被完全遮挡时会失败并如实报错
const OCR_PS = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinScan {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@`,
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ("IAsyncOperation" + [char]96 + "1") })[0]',
  'function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }',
  '$p = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
  'if (-not $p) { @{ok=$false;error="网易云没在运行或窗口收进了托盘"} | ConvertTo-Json -Compress; exit }',
  '$h = [IntPtr]$p.MainWindowHandle',
  '$r = New-Object WinScan+RECT',
  '[void][WinScan]::GetWindowRect($h, [ref]$r)',
  '$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top',
  'if ($w -lt 200 -or $ht -lt 120) { @{ok=$false;error="网易云窗口被最小化了，请先点开网易云窗口再校准"} | ConvertTo-Json -Compress; exit }',
  '$bmp = New-Object System.Drawing.Bitmap($w, $ht)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$hdc = $g.GetHdc()',
  '$ok = [WinScan]::PrintWindow($h, $hdc, 2)',
  '$g.ReleaseHdc($hdc)',
  'if (-not $ok) { $g2 = [System.Drawing.Graphics]::FromImage($bmp); $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size); $g2.Dispose() }',
  '$g.Dispose()',
  '$png = Join-Path $env:TEMP "graysongicu_pos.png"',
  '$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()',
  '$file = Await ([Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$eng = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()',
  '$res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])',
  '$stream.Dispose()',
  '$pick = $null; $pickY = -1',
  'foreach ($ln in $res.Lines) { $s = ($ln.Text -replace "\\s", ""); $m = [regex]::Matches($s, "(\\d{1,2})[:：.．](\\d{2})"); if ($m.Count -gt 0) { $y = 0; if ($ln.Words.Count -gt 0) { $y = $ln.Words[0].BoundingRect.Y }; if ($y -ge $pickY) { $pickY = $y; $pick = $m[0] } } }',
  'if (-not $pick) { @{ok=$false;error="没读到播放时间，把网易云窗口露出来再试"} | ConvertTo-Json -Compress; exit }',
  '$pos = [int]$pick.Groups[1].Value * 60 + [int]$pick.Groups[2].Value',
  '$obj = @{ ok = $true; pos = $pos; text = ($pick.Groups[1].Value + ":" + $pick.Groups[2].Value) } | ConvertTo-Json -Compress',
  'Write-Output $obj',
].join('\r\n');
async function ncmSongCands(title, artist) {
  const kw = [title, artist].filter(Boolean).join(' ');
  const j = await ncmReq('/api/cloudsearch/pc', { s: kw, type: 1, limit: 20, offset: 0, total: true });
  const songs = (((j || {}).result || {}).songs) || [];
  const nt = normTitle(title);
  const out = songs.map(s => {
    const sn = normTitle(s.name);
    let ts = 0;
    if (sn === nt) ts = 4;
    else if (nt && (sn.includes(nt) || nt.includes(sn))) ts = 1.5;
    const ars = (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join('/');
    const am = !!(artist && ars.includes(artist));
    // 歌名完全相同 > 包含；艺人加分只在完全相同时才生效；时长过短(<60s)多为剪辑版, 降权
    const long = (s.dt || 0) >= 60000;
    const sc = ts + (ts === 4 && am ? 2 : 0) + (long ? 1 : 0);
    return { song: s, sc, am, artist: ars, ts };
  });
  out.sort((a, b) => b.sc - a.sc);
  return out;
}
async function findNcmSong(title, artist) {
  const c = await ncmSongCands(title, artist);
  return c.length ? c[0].song : null;
}
async function lyricFor(title, artist, durSec) {
  const key = title + '|' + artist;
  const hit = LYRIC_CACHE.get(key);
  if (hit) {
    if (hit.v && hit.v.ok) {
      // 内存缓存也要复核: 不能因为"这次存过"就直接信
      const v = lrcAudit(hit.v.lrc, { durSec, minLines: 3 });
      if (v.ok) return hit.v;
      console.log('[歌词] 内存缓存二次校验未通过: ' + title + ' (' + v.reason + ')');
      LYRIC_CACHE.delete(key);
    } else if (hit.v && hit.v.ok === false && Date.now() - (hit.at || 0) < 60e3) {
      return hit.v; // 失败结果只留 60 秒, 避免临时故障被永久记住
    } else {
      LYRIC_CACHE.delete(key);
    }
  }
  let out = null;
  try {
    const idx = lyrIdxGet(title, artist);
    // 1) 本地已保存歌词: 直接用, 不再联网(网络那份可能是别的版本/会下架/会变)
    if (idx && idx.lrc) {
      const v = lrcAudit(idx.lrc, { durSec, minLines: 3 });
      if (v.ok && !idxStale(idx, durSec)) {
        out = {
          ok: true, songId: String(idx.songId || ''), name: idx.name || title,
          artist: idx.artist || artist, durMs: idx.durMs || 0,
          lrc: idx.lrc, tlrc: idx.tlrc || '', lines: v.lines, fromIndex: true, local: true,
          verify: idx.verify || '', source: idx.source || (idx.bvid ? '' : 'netease'),
        };
        if (v.warn) out.warn = v.warn;
      } else {
        console.log('[歌词] 索引缓存二次校验未通过: ' + title + ' (' + (v.ok ? '音源时长不匹配' : v.reason) + ')');
        lyrIdxDrop(title, artist);
      }
    }
    // 2) 只有 songId 的老记录: 按 id 取一次, 并把歌词全文回存
    if (!out && idx && idx.songId) {
      const r = await lyricBySongId(idx.songId);
      const v = lrcAudit(r.lrc, { durSec, minLines: 3 });
      if (v.ok) {
        const rec = lyrIdxPut(title, artist, {
          lrc: r.lrc, tlrc: r.tlrc,
          audioDurMs: durSec > 0 ? Math.round(durSec * 1000) : (idx.audioDurMs || 0),
        });
        if (rec) {
          out = {
            ok: true, songId: String(idx.songId), name: idx.name || title,
            artist: idx.artist || artist, durMs: idx.durMs || 0,
            lrc: r.lrc, tlrc: r.tlrc, lines: v.lines, fromIndex: true,
            verify: idx.verify || '', source: idx.source || 'netease',
          };
          if (v.warn) out.warn = v.warn;
        }
      } else {
        lyrIdxDrop(title, artist); // 版本已失效(下架/无版权/脏数据)
      }
    }
    // 3) 完全没有: 搜索候选(按时长优先), 选中后把歌词全文存进索引
    if (!out) {
      const cands = pickCands(await ncmSongCands(title, artist), durSec);
      if (!cands.length) {
        out = { ok: false, error: '没找到这首歌' };
      } else {
        let first = null;
        for (const c of cands.slice(0, 6)) {
          const song = c.song;
          const j = await ncmReq('/api/song/lyric', { id: song.id, lv: -1, tv: -1, kv: -1 });
          const lrc = ((j || {}).lrc || {}).lyric || '';
          const tlrc = ((j || {}).tlyric || {}).lyric || '';
          const v = lrcAudit(lrc, { durSec, minLines: 3 });
          if (!v.ok) continue;
          const cand = {
            ok: true, songId: String(song.id), name: song.name || title,
            artist: (song.ar || song.artists || []).map(a => a.name).filter(Boolean).join('/'),
            durMs: song.dt || 0, lrc, tlrc, lines: v.lines,
          };
          if (v.warn) cand.warn = v.warn;
          if (!first) first = cand;
          if (cand.lines >= 5) { first = cand; break; }
        }
        out = first || { ok: false, error: '网易云只有纯音乐/伴奏版本, 没有可用歌词' };
        if (out.ok) {
          out.source = 'netease';
          lyrIdxPut(title, artist, {
            songId: out.songId, name: out.name, artist: out.artist,
            durMs: out.durMs, audioDurMs: durSec > 0 ? Math.round(durSec * 1000) : 0,
            offset: lyrIdxOffset(title, artist), lrc: out.lrc, tlrc: out.tlrc,
            source: 'netease',
          });
        }
      }
    }
  } catch (e) {
    logError('lyric', e);
    out = { ok: false, error: friendlyError(e) };
  }
  // 未校对的转写: 播放时明确提示, 避免用户把它当官方歌词
  if (out && out.ok && out.fromIndex && out.verify === 'none') {
    const why = out.source === 'whisper' ? '语音转写未校对' : '字幕转写未校对';
    out.warn = (out.warn ? out.warn + ' · ' : '') + why;
  }
  if (LYRIC_CACHE.size > 200) LYRIC_CACHE.delete(LYRIC_CACHE.keys().next().value);
  LYRIC_CACHE.set(key, { v: out, at: Date.now() });
  return out;
}

// ---------- 桌面歌词: 服务端统一算进度, 独立歌词窗只负责显示 ----------
function lrcLines(txt) {
  const out = [];
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const m = raw.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    for (const x of m[1].matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)) {
      const t = parseInt(x[1], 10) * 60 + parseFloat(String(x[2]).replace(':', '.'));
      out.push({ t: Math.round(t * 10) / 10, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
// 纯音乐/占位歌词不算歌词(网易云常把伴奏/翻唱上传成同名歌曲, 歌词只有一句"纯音乐，请欣赏")
const LRC_JUNK_RE = /纯音乐|请欣赏|暂无歌词|无歌词|没有歌词|該歌曲|该歌曲|instrumental|演奏版|伴奏/i;
function isJunkLyric(txt, parsed) {
  const lines = parsed || lrcLines(txt);
  if (lines.length < 3) return true;
  const real = lines.filter(x => !LRC_JUNK_RE.test(x.text));
  return real.length < 3;
}
// 元信息型 LRC(Type Beat / 伴奏Demo): 大半行是 BPM、KEY、风格、乐手名, 不是真歌词
function isMetaLrc(txt, parsed) {
  const lines = parsed || lrcLines(txt);
  if (!lines.length) return true;
  // 大多数行挤在同一秒(通常 00:00): 是歌曲信息/授权文案, 不是逐句歌词
  const t0 = lines[0].t;
  const same = lines.filter(x => Math.abs(x.t - t0) < 1.5).length;
  if (same >= Math.max(3, Math.ceil(lines.length * 0.6))) return true;
  const meta = /^(BPM|KEY|-?音名|-?调号|-?调式|风格|曲风|时长|作词|作曲|编曲|制作|混音|母带|录音|和声|吉他|贝斯|鼓|弦乐|钢琴|演唱|人声|采样|标签|Beat|Prod|授权)\s*[:：]/i;
  const bad = lines.filter(x => meta.test(x.text.trim())).length;
  return bad >= Math.max(2, Math.ceil(lines.length * 0.6));
}
// 歌词统一的二次校验: 写入索引、读取缓存、播放展示前都过这一道
// 只做"能不能信"的硬判断, 时长和音源差太多只给提示, 不直接否决(剪辑片段也能用前段歌词)
function lrcAudit(txt, opts) {
  opts = opts || {};
  const minLines = Math.max(2, Number(opts.minLines) || 3);
  const lines = opts.lines || lrcLines(txt);
  if (!lines.length) return { ok: false, reason: '空歌词', lines: 0 };
  if (lines.length < minLines) return { ok: false, reason: '歌词行数太少(' + lines.length + ')', lines: lines.length };
  if (isJunkLyric(txt, lines)) return { ok: false, reason: '纯音乐或占位歌词', lines: lines.length };
  if (isMetaLrc(txt, lines)) return { ok: false, reason: '歌曲信息不是歌词', lines: lines.length };
  // 时间轴体检: 负数或超过 6 小时基本是解析/脏数据
  if (lines.some(x => !(Number.isFinite(x.t) && x.t >= 0 && x.t <= 21600))) {
    return { ok: false, reason: '时间轴异常', lines: lines.length };
  }
  // 内容体检: 至少要有对应行数的有效文字, 排除纯符号/乱码行
  const real = lines.filter(x => /[\p{L}\p{N}]/u.test(x.text)).length;
  if (real < minLines) return { ok: false, reason: '歌词内容无效', lines: lines.length };
  const last = lines[lines.length - 1].t;
  let warn = '';
  const dur = Number(opts.durSec) || 0;
  if (dur >= 60) {
    if (last > dur + Math.max(60, dur * 0.6)) warn = '歌词时长比音源长很多';
    else if (dur >= 120 && last < dur * 0.35) warn = '歌词可能只覆盖了前段';
  }
  return { ok: true, lines: lines.length, last, warn: warn, reason: '' };
}
// 索引里的歌词版本和真实音源时长差太多(翻唱/剪辑/别的歌)时判定过期
function idxStale(idx, durSec) {
  const ms = Number(durSec) > 0 ? Number(durSec) * 1000 : 0;
  if (!idx || idx.manual || !ms) return false;
  const ref = Number(idx.durMs) || Number(idx.audioDurMs) || 0;
  if (!ref) return false;
  return Math.abs(ref - ms) > 3000;
}
// 歌词实际取自哪个版本: 和当前播放的同名同歌手就不提示, 否则给出「歌名 - 歌手」
function lyricVersionLabel(idx, title, artist) {
  if (!idx || !idx.name) return '';
  const name = String(idx.name), ar = String(idx.artist || '');
  if (normTitle(name) === normTitle(title) && (!ar || normTitle(ar) === normTitle(artist))) return '';
  return ar ? name + ' - ' + ar : name;
}

// 读网易云窗口播放条时间(OCR), 用于把歌词对齐到真实进度
async function ocrPlayPos() {
  const p = path.join(os.tmpdir(), 'graysongicu_pos.ps1');
  fs.writeFileSync(p, '\uFEFF' + OCR_PS, 'utf8');
  const out = await new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p],
      { timeout: 8000, windowsHide: true, maxBuffer: 1048576 }, (err, stdout) => {
        if (err && !String(stdout || '').trim()) return reject(new Error(err.killed ? '校准超时' : '校准失败'));
        resolve(String(stdout || ''));
      });
  });
  const line = out.split(/\r?\n/).map(x => x.trim()).filter(x => x.startsWith('{')).pop();
  if (!line) throw new Error('没读到播放时间，请把网易云窗口露出来再试');
  let j;
  try { j = JSON.parse(line); } catch (e) { throw new Error('校准返回格式异常'); }
  return j;
}

let live = { key: '', title: '', artist: '', lines: [], dur: 0, anchor: 0, at: 0, paused: false, loading: false, error: '', off: 0, rechecked: false };

function liveLoad(key, title, artist, durSec) {
  live.loading = true;
  lyricFor(title, artist, durSec).then(j => {
    if (live.key !== key) return;
    if (j && j.ok) {
      // 展示前最后一道复核: 即使服务端缓存判定通过, 也不把明显异常的数据推给歌词窗
      const v = lrcAudit(j.lrc, { durSec: Number(durSec) || (Number(j.durMs) || 0) / 1000, minLines: 3 });
      if (!v.ok) {
        live.lines = []; live.dur = 0; live.auditWarn = '';
        live.lyrSrc = ''; live.lyrVerify = '';
        live.error = '歌词数据异常(' + v.reason + ')';
        live.loading = false;
        return;
      }
      const ls = lrcLines(j.lrc).filter(l => {
        const t = l.text.trim();
        // 过滤封面/翻唱版 LRC 常见的元信息行(词曲编曲等)与“歌名 - 歌手”标题行
        if (/^(作?词|作?曲|编曲|混音|制作人|制作|演唱|原唱|监制|出品|录音|母带|和声|吉他|贝斯|弦乐|词|曲)\s*[:：]/.test(t)) return false;
        return !(t.split(/\s*[-–—]\s*/)[0].trim() === title.trim() && t.includes(' - '));
      });
      live.lines = ls;
      live.dur = (j.durMs || 0) / 1000;
      live.lyrSrc = j.source || 'netease';
      live.lyrVerify = j.verify || '';
      live.auditWarn = [v.warn, j.warn].filter(Boolean).join(' · ');
      live.error = ls.length >= 2 ? '' : '这首歌没有歌词';
    } else {
      live.lines = []; live.dur = 0; live.lyrSrc = ''; live.lyrVerify = ''; live.auditWarn = '';
      live.error = (j && j.error) || '没找到歌词';
    }
    live.loading = false;
  }).catch(() => { if (live.key === key) live.loading = false; });
}

function autoCalibrate(key, src) {
  setTimeout(() => {
    if (live.key !== key) return;
    ocrPlayPos().then(j => {
      if (live.key !== key) return;
      if (j && j.ok && typeof j.pos === 'number') liveSeek(j.pos);
    }).catch(() => {});
  }, src === 'smtc' ? 2500 : 1500);
}

// 有真实播放进度时(InfLink-rs 上报 SMTC timeline), 歌词直接跟随真实位置, 不再靠计时推算
function pushTrackStillCurrent() {
  // 暂停时网易云的窗口标题会短暂变空, 这时也要认为推送仍对应当前曲目
  return !!pushState && (!smState.title || sameTrackKey(pushState.title, pushState.artist, smState.title, smState.artist));
}
function smHasPos() {
  if (pushState && typeof pushState.monoPos === 'number' && pushState.monoPos >= 0) {
    if (pushFresh()) return true;
    // 暂停后桥接可能停止上报, 但冻结的位置仍然有效, 必须继续用,
    // 否则会退回"只有窗口标题"的兜底状态, 歌词从第一句重新开始
    if (pushState.status === 'Paused' && pushTrackStillCurrent()) return true;
  }
  return smState.src === 'smtc' && typeof smState.pos === 'number' && smState.pos >= 0;
}
function sameTrackKey(t1, a1, t2, a2) {
  return trackKey(t1, a1) === trackKey(t2, a2);
}
function trackKey(t, a) {
  const n = s => String(s || '').replace(/[\s　·•\-—_]/g, '').toLowerCase();
  return n(t) + '|' + n(a);
}
function smLivePos(now) {
  if (pushFresh()) return pushLivePos(now);
  // 暂停后停止上报: 用最后一次推送冻结的位置, 不能让兜底标题状态把进度归零
  if (pushState && pushState.status === 'Paused' && pushTrackStillCurrent()) {
    return pushLivePos(now);
  }
  const base = Number(smState.pos) || 0;
  if (smState.status === 'Paused') return base;
  return base + Math.max(0, now - (Number(smState.posAt) || now));
}

function liveTickState() {
  ensureSmWatcher();
  const now = Date.now() / 1000;
  const pushed = pushFresh();
  const smtcReal = smState.src === 'smtc' && typeof smState.pos === 'number' && smState.pos >= 0;
  // 只剩窗口标题时只能拿到歌名, 既没有进度也判断不了暂停:
  // 不能把它当成"正在播放", 否则真暂停后歌词会继续往前走, 重启后又从第一句开始
  // 暂停时窗口标题有时会短暂变空, 这种情况下也必须沿用它之前的推送状态, 不能清空重来
  const stalePush = !pushed && !smtcReal && pushState
    && (!smState.title || sameTrackKey(pushState.title, pushState.artist, smState.title, smState.artist));
  const srcState = pushed ? pushState : (smtcReal ? smState : (stalePush ? pushState : smState));
  const title = srcState.title || '', artist = srcState.artist || '';
  const pausedNow = srcState === pushState ? srcState.status === 'Paused' : (smtcReal ? srcState.status === 'Paused' : true);
  if (!title) {
    live = { key: '', title: '', artist: '', lines: [], dur: 0, anchor: 0, at: now, paused: false, loading: false, error: '', off: 0, warn: '', auditWarn: '', lyrSrc: '', lyrVerify: '' };
    return { ok: true, title: '', playing: false, paused: false, pos: 0, dur: 0, lines: [] };
  }
  // 用归一化 key 判断是否换歌: 推送里歌名/歌手偶尔带空格或分隔符差异,
  // 直接字符串比较会误判成换歌, 把进度重置到 0(表现就是暂停后跳回第一句)
  const key = trackKey(title, artist);
  if (key !== live.key) {
    // 换歌: 偏移直接取索引里记住的值, 不再每次清零重调
    live = { key, title, artist, lines: [], dur: 0, anchor: 0, at: now, paused: pausedNow, loading: false, error: '', off: lyrIdxOffset(title, artist), rechecked: false, warn: '', auditWarn: '', lyrSrc: '', lyrVerify: '' };
    liveLoad(key, title, artist, pushed ? pushState.dur : 0);
    // 换歌自动校准一次: 从 0 开始的计时无法知道前奏/拖进度, 用 OCR 读播放条对齐
    if (!smHasPos()) autoCalibrate(key, smState.src);
  }
  // 用插件上报的真实音频时长复核歌词版本: 偏差超过 3 秒说明不是同一个版本, 换一份重试一次
  // (同一版本一般 <2 秒; 以前按 10% 算, 长歌要到 30 秒才触发, 太松)
  if (pushed && pushState.dur > 0 && live.lines.length && live.dur > 0 && !live.rechecked
    && Math.abs(live.dur - pushState.dur) > 3 && !(lyrIdxGet(title, artist) || {}).manual) {
    live.rechecked = true;
    lyrIdxDrop(title, artist);
    LYRIC_CACHE.delete(key);
    liveLoad(key, title, artist, pushState.dur);
  }
  // 换完还是差得多(live/翻唱版): 明确告诉用户, 不要装作同步
  live.warn = live.auditWarn || '';
  if (!pushed && !smtcReal && !stalePush) {
    // 连窗口标题都是兜底来源, 没有任何进度信息: 位置只能停在原处, 提示用户校准
    live.warn = '没连上播放进度，歌词位置可能不准，可点歌词或输入时间校准';
  }
  if (live.lines.length && live.dur > 0 && pushed && pushState.dur > 0) {
    const dDiff = Math.abs(live.dur - pushState.dur);
    const idx = lyrIdxGet(title, artist) || {};
    if (dDiff > 3 && !idx.manual) {
      const ver = lyricVersionLabel(idx, title, artist);
      live.warn = '没找到同版本歌词(歌词 ' + Math.round(live.dur) + 's / 音源 ' + Math.round(pushState.dur) + 's, 差 ' + Math.round(dDiff) + 's)'
        + (ver ? ', 这段用「' + ver + '」' : '') + ', 可手动微调';
    }
  }
  if (pausedNow && !live.paused) { live.anchor = live.anchor + (now - live.at); live.paused = true; }
  if (!pausedNow && live.paused) { live.paused = false; live.at = now; }
  const anchorPos = Math.max(0, live.paused ? live.anchor : live.anchor + (now - live.at));
  const pos = Math.max(0, (smHasPos() ? smLivePos(now) : anchorPos) + (live.off || 0));
  return {
    ok: true, title: live.title, artist: live.artist,
    playing: !live.paused, paused: live.paused,
    pos: Math.round(pos * 10) / 10, dur: live.dur || (pushed && pushState.dur > 0 ? pushState.dur : 0),
    audioDur: pushed && pushState.dur > 0 ? pushState.dur : 0,
    lines: live.lines, error: live.lines.length ? '' : live.error, warn: live.warn || '',
    src: live.lyrSrc || '', verify: live.lyrVerify || '',
  };
}

function liveNudge(sec) {
  const now = Date.now() / 1000;
  if (smHasPos()) {
    live.off = (live.off || 0) + sec;
    lyrIdxPut(live.title, live.artist, { offset: live.off }); // 记住手动偏移
    return;
  }
  const cur = live.paused ? live.anchor : live.anchor + (now - live.at);
  live.anchor = Math.max(0, cur + sec);
  live.at = now;
}

// 直接对齐到某个时间点(服务重启/中途开启歌词窗时用)
function liveSeek(sec) {
  const now = Date.now() / 1000;
  if (smHasPos()) {
    live.off = (Number(sec) || 0) - smLivePos(now);
    lyrIdxPut(live.title, live.artist, { offset: live.off }); // 记住对齐结果
    return;
  }
  live.anchor = Math.max(0, Number(sec) || 0);
  live.at = now;
}

// ---------- 桌面歌词独立窗口 (Electron): 由服务端按需拉起 ----------
const DESKTOP_DIR = path.join(APP_DIR, 'desktop');
let lyricProc = null, lyricInstalling = false, lyricHookRunning = false;
function lyricWindowRunning() { return lyricHookRunning || !!lyricProc; }
// 打包版: 歌词窗由 Electron 主进程负责, 服务端通过本机钩子请求开/关
// 钩子必须带本次启动的随机 token, 否则主进程一律 403
function hookPost(pathname, payload) {
  if (!COOKIE_HOOK) return Promise.resolve(null);
  return new Promise(resolve => {
    let u;
    try { u = new URL(pathname, COOKIE_HOOK); } catch (e) { return resolve(null); }
    const body = payload ? JSON.stringify(payload) : '';
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        'x-gsi-hook-token': HOOK_TOKEN,
        ...(body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, res => {
      let t = '';
      res.on('data', d => t += d);
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(3000, () => { r.destroy(); resolve(null); });
    if (body) r.write(body);
    r.end();
  });
}
function lyricHook(action) { return hookPost('/lyric/' + action); }
async function lyricWindowState() {
  const hooked = await lyricHook('state');
  if (hooked) lyricHookRunning = !!hooked.running;
  return { running: lyricWindowRunning(), installing: lyricInstalling };
}
function electronBinPath() {
  try {
    const p = require(path.join(DESKTOP_DIR, 'node_modules', 'electron'));
    return typeof p === 'string' ? p : null;
  } catch (e) { return null; }
}
function startLyricProc(bin) {
  try {
    lyricProc = spawn(bin, ['.'], { cwd: DESKTOP_DIR, stdio: 'ignore' });
    lyricProc.on('exit', () => { lyricProc = null; });
    lyricProc.on('error', () => { lyricProc = null; });
  } catch (e) {
    lyricProc = null;
    logError('desktop-lyric', e);
    return { ok: false, error: '桌面歌词启动失败, 请确认桌面歌词程序已安装后重试。' };
  }
  return { ok: true, running: true };
}
// 按需自动安装桌面歌词组件(换新电脑/新克隆时 desktop/node_modules 不存在)
function installElectron() {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true; lyricInstalling = false; resolve(ok);
    };
    try {
      const p = spawn('npm install --no-audit --no-fund', {
        cwd: DESKTOP_DIR, stdio: 'ignore', shell: true,
        env: { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/' },
      });
      p.on('exit', code => finish(code === 0));
      p.on('error', () => finish(false));
      setTimeout(() => finish(false), 300000);
    } catch (e) { finish(false); }
  });
}
async function openLyricWindow() {
  const hooked = await lyricHook('open');
  if (hooked) { lyricHookRunning = !!hooked.running; return hooked; }
  if (lyricProc) return { ok: true, running: true };
  const bin = electronBinPath();
  if (!bin) {
    if (lyricInstalling) return { ok: true, installing: true };
    lyricInstalling = true;
    installElectron().then(ok => {
      const b = ok ? electronBinPath() : null;
      if (b && !lyricProc) startLyricProc(b);
    });
    return { ok: true, installing: true };
  }
  return startLyricProc(bin);
}
async function closeLyricWindow() {
  const hooked = await lyricHook('close');
  if (hooked) { lyricHookRunning = false; return hooked; }
  if (lyricProc) { try { lyricProc.kill(); } catch (e) {} lyricProc = null; }
  return { ok: true, running: false };
}

// ---------- 本地转写: 优先用可下载的 whisper.cpp 组件, 开发机也可用 faster-whisper ----------
const ASR_SCRIPT = path.join(APP_DIR, 'asr', 'transcribe.py');
const ASR_VENV_PY = path.join(APP_DIR, 'asr', '.venv', 'Scripts', 'python.exe');
const ASR_PY = fs.existsSync(ASR_VENV_PY) ? ASR_VENV_PY : 'python';
// 组件默认装在数据目录; 桌面版可指定装到程序文件夹, 用户删整个文件夹就能清干净
const ASR_PACK_DIR = process.env.GRAYSONGICU_ASR_DIR || path.join(DIR, 'asr-pack');
const ASR_LEGACY_DIR = path.join(DIR, 'asr-pack');
const ASR_CPP_DIR = path.join(ASR_PACK_DIR, 'whisper');
const ASR_CPP_CLI = path.join(ASR_CPP_DIR, 'whisper-cli.exe');
const ASR_CPP_MODEL = path.join(ASR_PACK_DIR, 'ggml-base.bin');

function asrFindPack() {
  const dirs = ASR_PACK_DIR === ASR_LEGACY_DIR ? [ASR_PACK_DIR] : [ASR_PACK_DIR, ASR_LEGACY_DIR];
  for (const d of dirs) {
    const cli = path.join(d, 'whisper', 'whisper-cli.exe');
    const model = path.join(d, 'ggml-base.bin');
    if (fs.existsSync(cli) && fs.existsSync(model)) return { dir: d, cli, model };
  }
  return null;
}
const ASR_WHISPER_URLS = [
  'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  'https://ghproxy.net/https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  'https://gh-proxy.com/https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
];
const ASR_MODEL_URLS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
];
const ASR_PACK_BYTES = 150 * 1024 * 1024;
// 固定版本的组件哈希, 下载后必须完全一致, 防止镜像/网络被替换成恶意文件
// whisper.cpp b5454 whisper-bin-x64.zip / ggml-base.bin (sha256)
const ASR_WHISPER_SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
const ASR_MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
function hashFile(file, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const rs = fs.createReadStream(file);
    rs.on('data', d => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}
let ASR_INSTALL = { running: false, step: '', loaded: 0, total: 0, error: '', startedAt: 0, finishedAt: 0 };

// 本机没有 Python / 模型时, 只是失去本地转写能力, B站字幕与网易云歌词照常可用
function asrReady() {
  const pack = asrFindPack();
  if (pack) return { ready: true, backend: 'cpp', reason: '', cli: pack.cli, model: pack.model };
  if (!fs.existsSync(ASR_SCRIPT)) return { ready: false, backend: 'none', reason: '未安装语音识别组件' };
  if (!fs.existsSync(ASR_VENV_PY)) return { ready: false, backend: 'none', reason: '未安装语音识别组件' };
  if (!fs.existsSync(path.join(APP_DIR, 'asr', 'models', 'faster-whisper-base'))) return { ready: false, backend: 'none', reason: '未安装语音识别组件' };
  return { ready: true, backend: 'python', reason: '' };
}
function asrStatus() {
  const a = asrReady();
  return {
    ok: true, ready: a.ready, backend: a.backend, reason: a.reason,
    installing: ASR_INSTALL.running, step: ASR_INSTALL.step,
    loaded: ASR_INSTALL.loaded, total: ASR_INSTALL.total, error: ASR_INSTALL.error || '',
  };
}
// 流式下载到文件, 支持重定向, 避免把 140MB 模型读进内存
function downloadToFile(url, dest, onProgress, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const go = (target, redirects) => {
      let u;
      try { u = new URL(target); } catch (e) { return reject(new Error('下载地址无效')); }
      const lib = u.protocol === 'https:' ? https : http;
      const r = lib.get(target, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, timeout: timeoutMs }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('下载重定向次数过多'));
          return go(new URL(res.headers.location, target).toString(), redirects - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载失败 (HTTP ' + res.statusCode + ')'));
        }
        const total = Number(res.headers['content-length'] || 0);
        let loaded = 0;
        const part = dest + '.part';
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
        const ws = fs.createWriteStream(part);
        res.on('data', d => { loaded += d.length; onProgress(loaded, total); });
        res.on('error', e => { try { ws.destroy(); } catch (_) {} reject(e); });
        ws.on('error', reject);
        ws.on('finish', () => {
          fs.rename(part, dest, err => err ? reject(err) : resolve({ size: loaded, total }));
        });
        res.pipe(ws);
      });
      r.on('error', reject);
      r.on('timeout', () => r.destroy(new Error('下载超时')));
    };
    go(url, 5);
  });
}
function expandZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const q = s => "'" + String(s).replace(/'/g, "''") + "'";
    const script = 'Expand-Archive -LiteralPath ' + q(zip) + ' -DestinationPath ' + q(dest) + ' -Force';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 180000, windowsHide: true },
      (err, so, se) => err ? reject(new Error('解压识别组件失败: ' + String(se || err.message).split(/\r?\n/).pop())) : resolve());
  });
}
async function installAsrPack() {
  if (ASR_INSTALL.running) return { ok: true, started: false, running: true };
  if (asrReady().ready) return { ok: true, started: false, ready: true };
  if (sttBusy) return { ok: false, error: '正在补时间轴，请识别结束后再安装组件' };
  const tmp = path.join(ASR_PACK_DIR, '_install');
  ASR_INSTALL = { running: true, step: '准备下载', loaded: 0, total: 0, error: '', startedAt: Date.now(), finishedAt: 0 };
  (async () => {
    try {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      fs.mkdirSync(tmp, { recursive: true });
      const zip = path.join(tmp, 'whisper.zip');
      let zipped = false, zipErr = null;
      for (const url of ASR_WHISPER_URLS) {
        try {
          ASR_INSTALL.step = '下载识别程序';
          ASR_INSTALL.loaded = 0; ASR_INSTALL.total = 0;
          await downloadToFile(url, zip, (n, t) => { ASR_INSTALL.loaded = n; ASR_INSTALL.total = t; });
          if (fs.statSync(zip).size < 3 * 1024 * 1024) throw new Error('识别程序文件不完整');
          ASR_INSTALL.step = '校验识别程序';
          if (await hashFile(zip) !== ASR_WHISPER_SHA256) throw new Error('识别程序哈希校验未通过, 已丢弃这个下载源');
          zipped = true;
          break;
        } catch (e) {
          zipErr = e;
          try { fs.unlinkSync(zip); } catch (_) {}
          try { fs.unlinkSync(zip + '.part'); } catch (_) {}
        }
      }
      if (!zipped) throw zipErr || new Error('识别程序下载失败');
      ASR_INSTALL.step = '解压识别程序';
      ASR_INSTALL.loaded = 0; ASR_INSTALL.total = 0;
      await expandZip(zip, tmp);
      const rel = ['Release', 'release', 'bin'].map(x => path.join(tmp, x)).find(p => fs.existsSync(p));
      const src = rel || tmp;
      fs.mkdirSync(ASR_CPP_DIR, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        if (!/\.(exe|dll)$/i.test(f)) continue;
        if (!/^(whisper-cli|whisper|ggml|llama|SDL2)/i.test(f)) continue;
        fs.copyFileSync(path.join(src, f), path.join(ASR_CPP_DIR, f));
      }
      if (!fs.existsSync(ASR_CPP_CLI)) throw new Error('识别程序解压后缺少 whisper-cli.exe');
      const part = path.join(ASR_PACK_DIR, 'ggml-base.bin.part');
      let downloaded = false;
      let lastErr = null;
      for (const url of ASR_MODEL_URLS) {
        try {
          ASR_INSTALL.step = '下载中文模型';
          ASR_INSTALL.loaded = 0; ASR_INSTALL.total = 0;
          await downloadToFile(url, part, (n, t) => { ASR_INSTALL.loaded = n; ASR_INSTALL.total = t; });
          const sz = fs.statSync(part).size;
          if (sz < 100 * 1024 * 1024) throw new Error('模型文件不完整');
          ASR_INSTALL.step = '校验中文模型';
          ASR_INSTALL.loaded = sz; ASR_INSTALL.total = sz;
          if (await hashFile(part) !== ASR_MODEL_SHA256) throw new Error('模型哈希校验未通过, 已丢弃这个下载源');
          downloaded = true;
          break;
        } catch (e) { lastErr = e; try { fs.unlinkSync(part); } catch (_) {} }
      }
      if (!downloaded) throw lastErr || new Error('模型下载失败');
      fs.renameSync(part, ASR_CPP_MODEL);
      try {
        fs.writeFileSync(path.join(ASR_PACK_DIR, 'README.txt'),
          'GraySongICU 可选语音识别组件\n\n' +
          'whisper.cpp (MIT License): https://github.com/ggml-org/whisper.cpp\n' +
          'Model ggml-base.bin: https://huggingface.co/ggerganov/whisper.cpp\n\n' +
          '只在补时间轴时本机离线运行, 不联网上传音频。\n');
      } catch (e) {}
      ASR_INSTALL.step = '完成';
      ASR_INSTALL.finishedAt = Date.now();
    } catch (e) {
      ASR_INSTALL.error = friendlyError(e);
      logError('asr-install', e);
    } finally {
      ASR_INSTALL.running = false;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  })();
  return { ok: true, started: true, running: true };
}

// ---------- 页面 ----------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GraySongICU</title>
<style>
  :root{ --red:#ec4141; --red-dark:#d63a3a; --bg:#f6f6f8; --card:#fff; --line:#ebebef; --line-soft:#f2f2f5; --t1:#1f1f22; --t2:#6b6b72; --t3:#9b9ba2; --ok:#2bb673; --bad:#d5453c; }
  *{margin:0;padding:0;box-sizing:border-box}
  [hidden]{display:none !important}
  html{scrollbar-gutter:stable}
  body{background:var(--bg);color:var(--t1);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  input,select,button{font-family:inherit}
  :focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:4px}

  .top{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
  .top-in{max-width:1080px;margin:0 auto;height:56px;padding:0 16px;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:15px;font-weight:600;letter-spacing:.2px}
  .tabs{display:flex;gap:2px;background:#f1f1f4;border-radius:9px;padding:3px}
  .tab{height:32px;padding:0 18px;border:none;border-radius:7px;background:transparent;color:var(--t2);font-size:13px;cursor:pointer;transition:background .15s,color .15s}
  .tab:hover{color:var(--t1)}
  .tab.on{background:#fff;color:var(--red);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .seg{display:inline-flex;gap:2px;background:#f1f1f4;border-radius:9px;padding:3px;margin-bottom:14px}
  .seg-btn{height:28px;padding:0 16px;border:none;border-radius:7px;background:transparent;color:var(--t2);font-size:12.5px;cursor:pointer;transition:background .15s,color .15s;display:inline-flex;align-items:center;gap:5px}
  .seg-btn .ico{width:14px;height:14px;flex:none}
  .seg-btn.on{background:#fff;color:var(--red);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .account{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--t2)}
  .dot{width:7px;height:7px;border-radius:50%;background:#c9c9cf}
  .dot.on{background:var(--ok)} .dot.off{background:var(--bad)}
  .account b{color:var(--t1);font-weight:500}
  .link{background:none;border:none;color:var(--t3);font-size:13px;cursor:pointer;padding:10px 4px}
  .link:hover{color:var(--red)}

  main{max-width:1080px;margin:0 auto;padding:20px 16px 40px}
  main > .card,main > .progress,main > .hist,main > .foot,main > .compare:not(.split){max-width:688px;margin-left:auto;margin-right:auto}
  main > #uploadCard,main > #compare,main > .hist,main > .progress,main > .foot{max-width:none}
  .fix-wrap{display:grid;grid-template-columns:minmax(0,820px) minmax(0,1fr);gap:16px;align-items:stretch;max-width:1048px;margin:0 auto}
  #fixCard{display:flex;flex-direction:column}
  #grayList{flex:1;min-height:0;display:flex;flex-direction:column}
  #grayList > .empty{margin:auto 0}
  .side{padding:16px 16px 12px;position:sticky;top:72px;max-height:calc(100vh - 92px);overflow:auto}
  .side-h{font-size:12.5px;font-weight:600;color:var(--t2)}
  .side-note{font-weight:400;font-size:11px;color:var(--t3);margin-left:5px}
  .side-sec{margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)}
  .side-item{padding:7px 0;border-top:1px dashed var(--line-soft)}
  #sideLiked .side-item:first-child,#sideRec .side-item:first-child{border-top:0}
  .side-name{font-size:12.5px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .side-sub{font-size:11.5px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .side-empty{font-size:12px;color:var(--t3);padding:6px 0}
  .side-line{display:flex;align-items:center;gap:6px}
  .side-line .side-name{flex:1;min-width:0}
  .stamp{flex:none;font-size:9.5px;font-weight:600;line-height:1;letter-spacing:.3px;color:var(--red);border:1px solid rgba(236,65,65,.55);box-shadow:inset 0 0 0 .5px rgba(236,65,65,.2);border-radius:3px;padding:2px 3px 1px;transform:rotate(-5deg);opacity:.85}
  .rec-nav{display:flex;align-items:flex-end;justify-content:space-between;margin-top:8px;height:26px}
  .rec-nav .fold{position:relative;width:26px;height:26px;padding:0;border:0;background:transparent;cursor:pointer;transition:transform .18s,filter .18s,opacity .18s}
  .rec-nav .fold::before{content:'';position:absolute;inset:0}
  .rec-nav .fold-next::before{background:linear-gradient(225deg,#fbfbfe 0%,#eeeef4 45%,#dcdce4 100%);clip-path:polygon(100% 0,100% 100%,0 100%)}
  .rec-nav .fold-prev::before{background:linear-gradient(135deg,#fbfbfe 0%,#eeeef4 45%,#dcdce4 100%);clip-path:polygon(0 0,100% 100%,0 100%)}
  .rec-nav .fold-next{filter:drop-shadow(-2px -2px 3px rgba(18,18,26,.2)) drop-shadow(-1px -1px 1px rgba(18,18,26,.12))}
  .rec-nav .fold-prev{filter:drop-shadow(2px -2px 3px rgba(18,18,26,.2)) drop-shadow(1px -1px 1px rgba(18,18,26,.12))}
  .rec-nav .fold-next:hover:not(:disabled){transform:translate(-1px,-1px);filter:drop-shadow(-3px -3px 5px rgba(18,18,26,.24)) drop-shadow(-1px -1px 1px rgba(18,18,26,.14))}
  .rec-nav .fold-prev:hover:not(:disabled){transform:translate(1px,-1px);filter:drop-shadow(3px -3px 5px rgba(18,18,26,.24)) drop-shadow(1px -1px 1px rgba(18,18,26,.14))}
  .rec-nav .fold:disabled{opacity:.35;filter:none;cursor:default}
  .lyr-btn{display:flex;align-items:center;gap:6px}
  .lyr-btn .lyr-ico{font-size:13px;line-height:1;color:var(--t3);transition:color .16s}
  .lyr-btn.on{color:var(--red);border-color:#f3c9c9}
  .lyr-btn.on .lyr-ico{color:var(--red)}
  @media (max-width:900px){.fix-wrap{grid-template-columns:1fr}.side{position:static;max-height:none}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
  .card h2{font-size:15px;font-weight:600}

  .upload{display:flex;gap:10px}
  .upload input[type=text],.upload textarea{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid #e3e3e9;border-radius:8px;background:#fff;font-size:14px;color:var(--t1);outline:none;transition:border-color .15s}
  .upload textarea{resize:none;padding-top:11px;line-height:1.4}
  .upload input::placeholder,.upload textarea::placeholder{color:#b0b0b8}
  .upload input:focus,.upload textarea:focus{border-color:var(--red)}
  .clip{height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--t2);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
  .clip:hover{background:#f7f7fa;color:var(--t1)}
  .upload select{width:126px;height:44px;padding:0 10px;border:1px solid #e3e3e9;border-radius:8px;background:#fff;font-size:13px;color:var(--t1);outline:none;cursor:pointer}
  .btn{height:44px;padding:0 26px;border:none;border-radius:8px;background:var(--red);color:#fff;font-size:14px;font-weight:500;cursor:pointer;transition:background .15s}
  .btn:hover{background:var(--red-dark)}
  .btn:disabled{background:#f0b3b3;cursor:default}

  .sub{margin-top:12px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .sub input[type=text]{width:170px;height:40px;padding:0 10px;border:1px solid #e3e3e9;border-radius:7px;background:#fff;font-size:13px;color:var(--t1);outline:none}
  .sub input[type=text]:focus{border-color:var(--red)}
  .chk{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--t2);cursor:pointer;user-select:none;padding:10px 0}
  .chk input{width:15px;height:15px;accent-color:var(--red);cursor:pointer}
  .more{display:none;margin-top:10px;gap:10px;flex-wrap:wrap}
  .more.open{display:flex}
  .more input{flex:1;min-width:140px;height:40px;padding:0 10px;border:1px solid #e3e3e9;border-radius:7px;font-size:13px;outline:none}
  .more input:focus{border-color:var(--red)}
  .hint{margin-top:8px;font-size:12.5px;color:var(--t3);line-height:1.6}
  .split-p{font-size:13px;color:var(--t2);line-height:1.8;margin:8px 0 18px}
  .split-act{display:flex;gap:10px;justify-content:flex-end}
  .mini.primary{background:var(--red);border-color:var(--red);color:#fff}
  .mini.primary:hover{background:var(--red-dark);border-color:var(--red-dark);color:#fff}

  .acct-modal{position:fixed;inset:0;z-index:60;background:rgba(24,24,28,.32);display:flex;align-items:center;justify-content:center;padding:16px}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:80;background:rgba(31,31,34,.92);color:#fff;font-size:13px;padding:10px 18px;border-radius:9px;box-shadow:0 6px 24px rgba(0,0,0,.18);animation:toastIn .18s ease}
  @keyframes toastIn{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
  .acct-card{background:#fff;border-radius:14px;padding:18px 20px 16px;width:min(440px,100%);max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.16)}
  .acct-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:15px;font-weight:600;color:var(--t1)}
  .acct-card .crow{display:flex;gap:10px}
  .acct-card input{flex:1;min-width:0;height:40px;padding:0 10px;border:1px solid #e3e3e9;border-radius:7px;font-size:13px;outline:none}
  .acct-card input:focus{border-color:var(--red)}
  .mini{background:#fff;border:1px solid var(--line);border-radius:7px;padding:9px 14px;font-size:12.5px;color:var(--t2);cursor:pointer}
  .mini.ready{color:var(--red);border-color:#f0c6c6}
  .mini.ready:hover{background:#fff5f5;border-color:var(--red)}
  .mini:hover{color:var(--red);border-color:#f3c9c9}
  .mini:disabled{background:#fafafc;color:var(--t3);border-color:var(--line-soft);cursor:default}
  .acct-btn{background:#fff;border:1px solid var(--line);border-radius:20px;padding:7px 14px;cursor:pointer}
  .acct-btn:hover{border-color:#f3c9c9;color:var(--red)}
  .top-right{display:flex;align-items:center;gap:8px}
  .guide-btn{display:flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--line);border-radius:20px;padding:7px 12px;font-size:12.5px;color:var(--t2);cursor:pointer}
  .guide-btn:hover{border-color:#f3c9c9;color:var(--red)}
  .guide-btn .q{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#f1f1f4;font-size:11px;font-weight:600;flex:none}
  .guide-step{display:flex;gap:10px;padding:10px 0;font-size:13px;line-height:1.75;color:var(--t2)}
  .guide-step + .guide-step{border-top:1px solid var(--line-soft)}
  .guide-num{flex:none;width:20px;height:20px;border-radius:50%;background:var(--red);color:#fff;font-size:11.5px;display:flex;align-items:center;justify-content:center;margin-top:1px}
  .guide-tip{margin-top:10px;padding:10px 12px;background:#fafafa;border-radius:8px;font-size:12px;color:var(--t3);line-height:1.7}
  .acc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 12px;border-bottom:1px solid var(--line-soft);font-size:13px;color:var(--t2)}
  .acc-row:last-of-type{border-bottom:none;padding-bottom:2px}
  .acc-info{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
  .acc-info b{color:var(--t1);font-weight:500}
  .acc-info .mini{flex:none}
  .manual{margin-top:2px}
  #manualBox{margin-top:8px;display:flex;flex-direction:column;gap:10px}

  .bp{position:fixed;inset:0;z-index:50;background:var(--bg);display:flex;flex-direction:column}
  .bp-bar{flex:none;display:flex;align-items:center;gap:12px;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line)}
  .bp-t{font-size:13px;font-weight:500;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
  .bp-hint{font-size:12px;color:var(--t3);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bpFrame{flex:1;width:100%;border:0;background:#fff}
  @media (max-width:560px){.bp-hint{display:none}}

  .progress{margin-top:14px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px}
  .p-top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
  .p-title{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .p-count{font-size:13px;color:var(--t2);font-variant-numeric:tabular-nums;flex:none;margin-left:12px}
  .bar{height:4px;background:#f1f1f4;border-radius:2px;overflow:hidden}
  .bar i{display:block;height:100%;width:0;background:var(--red);border-radius:2px;transition:width .35s ease}
  .p-now{margin-top:12px;font-size:13px;color:var(--t2)}
  .p-now b{color:var(--t1);font-weight:500}
  .p-errs{margin-top:10px;font-size:12.5px;color:var(--bad);line-height:1.7;white-space:pre-wrap}
  .p-done{display:flex;align-items:center;justify-content:space-between}
  .p-done p{font-size:13px;color:var(--t1)}
  .p-done p span{color:var(--t3);font-size:12px;margin-left:6px}
  details.rawlog{margin-top:10px}
  details.rawlog summary{font-size:12px;color:var(--t3);cursor:pointer}
  details.rawlog pre{margin-top:8px;background:#fafafc;border:1px solid var(--line-soft);border-radius:8px;padding:10px;font:12px/1.7 Consolas,monospace;color:var(--t2);max-height:180px;overflow:auto;white-space:pre-wrap}

  .cloud{margin-top:14px}
  .compare{margin-top:14px}
  .compare .cloud{margin-top:0}
  .compare.split{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:16px;align-items:stretch}
  .compare.split > .card{display:flex;flex-direction:column;height:calc(100vh - 250px);min-height:440px;padding:18px 22px}
  .compare.split > .card.cloud{background:#fbfbfd}
  .compare.split #sres,.compare.split #list{flex:1;min-height:0;overflow:auto;padding-right:6px;scrollbar-width:thin;scrollbar-color:#dedee4 transparent}
  .compare.split #sres{margin-top:12px}
  .compare.split #sres::-webkit-scrollbar,.compare.split #list::-webkit-scrollbar{width:6px}
  .compare.split #sres::-webkit-scrollbar-track,.compare.split #list::-webkit-scrollbar-track{background:transparent}
  .compare.split #sres::-webkit-scrollbar-thumb,.compare.split #list::-webkit-scrollbar-thumb{background:#e2e2e8;border-radius:3px}
  .compare.split .sr-head{position:sticky;top:0;z-index:1;background:#fff;padding:6px 0 9px}
  .compare.split .sr,.compare.split .song{padding:13px 0}
  .compare.split .song{grid-template-columns:1fr 1fr 92px 82px;gap:10px}
  @media (max-width:900px){
    .compare.split{display:block}
    .compare.split > .card{height:auto;min-height:0}
    .compare.split #sres,.compare.split #list{overflow:visible}
  }

  .cloud-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:12px}
  .cloud-title{display:flex;flex-direction:column;gap:3px;min-width:0}
  .cloud-title h2{white-space:nowrap}
  .cloud-right{display:flex;align-items:center;gap:8px;flex:none}
  .ico-btn{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:7px}
  .cloud-meta{font-size:11.5px;color:var(--t3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .batch-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 10px;font-size:12px;color:var(--t3)}
  .batch-chk{width:14px;height:14px;margin-right:7px;vertical-align:-2px;accent-color:var(--red);cursor:pointer}
  .song{display:grid;grid-template-columns:1fr 1fr 108px 88px;grid-template-areas:"name artist meta acts";align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line-soft);font-size:13px}
  .s-name{grid-area:name;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-artist{grid-area:artist;min-width:0;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-meta{grid-area:meta;color:var(--t3);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .s-acts{grid-area:acts;display:flex;align-items:center;justify-content:flex-end;gap:2px}
  .s-del,.s-fav{background:none;border:none;font-size:13px;color:var(--t3);cursor:pointer;padding:8px 0}
  .s-del:hover,.s-fav:hover{color:var(--red)}
  .empty{padding:34px 0 30px;text-align:center;color:var(--t3);font-size:13px;border-top:1px solid var(--line-soft)}
  .empty button{background:none;border:none;color:var(--red);font-size:13px;cursor:pointer;padding:8px}
  #sres{margin-top:4px}
  .search-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--t3);font-size:13px}
  .sr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0 8px;border-top:1px solid var(--line-soft);font-size:12.5px;color:var(--t3);flex-wrap:wrap}
  .sr-btns{display:flex;gap:8px;flex-wrap:wrap}
  .sr-head .chk{padding:2px 0}
  .badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:#fdeeee;color:var(--red);font-size:11px;font-weight:400;vertical-align:1px}
  .qtag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;border:1px solid;font-size:11px;font-weight:500;vertical-align:1px}
  .qtag.loading{color:#aaa;background:#f7f7f8;border-color:#ececf0;font-weight:400}
  .qtag.hires{color:#7a4a00;background:#fff7e6;border-color:#f0d9a8}
  .qtag.q192{color:#0b7a4b;background:#e9f8f1;border-color:#bfe8d5}
  .qtag.q132{color:#2456a6;background:#eaf1fc;border-color:#c9dcf7}
  .qtag.q64{color:#777;background:#f3f3f5;border-color:#e2e2e6}
  .sr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid var(--line-soft);font-size:13px}
  .sr-l{min-width:0}
  .sr-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sr-m{margin-top:2px;color:var(--t3);font-size:12px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sr-a{display:flex;gap:8px;flex-shrink:0}
  #listenModal,#srcModal{align-items:flex-end;padding:0;background:rgba(24,24,28,.1);backdrop-filter:blur(1.5px)}
  #listenModal{z-index:62}
  #srcModal{z-index:61}
  .src-list{max-height:52vh;overflow:auto;margin:10px 0 12px;padding-right:4px;border-top:1px solid var(--line-soft)}
  .listen-card{width:min(760px,100%);max-height:92vh;overflow:auto;background:#fff;border:1px solid #ececf0;border-bottom:0;border-radius:16px 16px 0 0;padding:10px 18px 18px;box-shadow:0 -8px 24px rgba(20,20,24,.07);animation:sheetIn .22s ease}
  @keyframes sheetIn{from{opacity:.55;transform:translateY(16px)}to{opacity:1;transform:none}}
  .listen-grip{width:36px;height:4px;border-radius:2px;background:#e2e2e6;margin:0 auto 10px}
  .listen-title{font-size:14px;font-weight:600;color:var(--t1);word-break:break-all}
  .listen-sub{font-size:11.5px;color:var(--t3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .listen-video{margin:10px 0 12px;aspect-ratio:16/9;background:#101012;border-radius:9px;overflow:hidden}
  .listen-video iframe{width:100%;height:100%;border:0;display:block}
  .listen-acts{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .mini-note{font-size:11px;color:var(--t3)}
  #lyricModal{align-items:flex-end;padding:0;background:rgba(24,24,28,.1);backdrop-filter:blur(1.5px);z-index:63}
  .lyr-box{position:relative;height:158px;overflow:hidden;margin:12px 0 6px;mask-image:linear-gradient(180deg,transparent,#000 18%,#000 82%,transparent)}
  .lyr-list{position:absolute;left:0;right:0;top:0;transition:transform .26s ease}
  .lyr-line{padding:7px 0;text-align:center;font-size:13px;color:#b6b6be;transition:color .2s,font-size .2s,opacity .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
  .lyr-line:hover{color:var(--t2)}
  .lyr-line.cur{color:var(--red);font-size:19px;font-weight:600}
  .lyr-empty{padding:34px 0;text-align:center;color:var(--t3);font-size:12px}
  .lyr-seek{width:100%;margin:4px 0 10px;accent-color:var(--red)}
  .lyr-time{display:flex;justify-content:space-between;font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums;margin:-6px 0 10px}
  .listen-go{animation:goBreathe 2.1s ease-in-out infinite}
  @keyframes goBreathe{0%,100%{box-shadow:0 0 0 0 rgba(236,65,65,.22)}55%{box-shadow:0 0 0 7px rgba(236,65,65,0)}}
  .fix-pick select{flex:1;width:auto;min-width:0}
  .gq{border-top:1px solid var(--line-soft);padding:2px 0}
  .gq:first-of-type{border-top:none}
  .gq-row{display:flex;align-items:center;gap:10px;padding:11px 0;font-size:13px}
  .gq-l{flex:1;min-width:0}
  .gq-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gq-m{margin-top:2px;color:var(--t3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gq-a{flex:none}
  .gq.filled .gq-t{color:var(--t3)}
  .badge.ok{background:#e8f7ef;color:var(--ok)}
  .cand-empty{padding:8px 0 12px;font-size:12.5px;color:var(--t3)}
  .cand-empty button{margin-left:6px}
  .cand{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:9px 0;border-top:1px dashed var(--line)}
  .cand:first-child{border-top:none}
  .cand-l{flex:1;min-width:0}
  .cand-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
  .cand-m{margin-top:2px;color:var(--t3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cand-a{display:flex;gap:8px;flex:none}
  .cover-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;max-height:300px;overflow:auto;margin:10px 0 12px;padding-right:2px}
  .cover-item{position:relative;aspect-ratio:1;border:2px solid transparent;border-radius:8px;overflow:hidden;background:#f3f3f6;cursor:pointer}
  .cover-item img{width:100%;height:100%;object-fit:cover;display:block}
  .cover-item:hover{border-color:#d9d9e0}
  .cover-item.sel{border-color:var(--red);box-shadow:0 0 0 2px rgba(236,65,65,.15)}
  .cover-tag{position:absolute;left:3px;bottom:3px;max-width:calc(100% - 6px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:1.5;padding:0 5px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff}
  .cover-empty{grid-column:1/-1;padding:24px 0;text-align:center;font-size:12.5px;color:var(--t3)}
  .cover-custom{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--t3)}
  .cover-custom img{width:42px;height:42px;border-radius:6px;object-fit:cover}
  .cover-custom span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cover-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .cover-acts .spacer{flex:1}
  .cover-up{display:inline-flex;align-items:center;cursor:pointer}
  .local-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:28px 18px;margin-top:14px;border:1.5px dashed #dadae2;border-radius:12px;background:#fafafc;cursor:pointer;text-align:center;transition:border-color .15s,background .15s}
  .local-drop.on,.local-drop:hover{border-color:var(--red);background:#fff7f8}
  .local-ico{font-size:24px;line-height:1;color:var(--red);opacity:.85}
  .local-drop b{font-size:13.5px;font-weight:600;color:var(--t1);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .local-drop span{font-size:12px;color:var(--t3);line-height:1.6}
  @media (max-width:640px){.cover-grid{grid-template-columns:repeat(3,minmax(0,1fr));max-height:260px}}
  .fix-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .grp{margin-top:14px;border-top:1px solid var(--line-soft)}
  .grp summary{display:flex;align-items:center;justify-content:space-between;padding:12px 0;font-size:12.5px;color:var(--t2);cursor:pointer;user-select:none}
  .grp summary:hover{color:var(--red)}
  .sum-l{display:flex;align-items:center;gap:8px}
  .sum-r{display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--t3)}
  .dot-red{width:7px;height:7px;border-radius:50%;background:var(--red);flex:none}
  .cta-breathe{color:var(--red);font-size:11.5px;font-weight:500;animation:breathe 2.2s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.45}50%{opacity:1}}
  .pick-sub{font-size:12.5px;color:var(--t3);line-height:1.7;margin:4px 0 6px}
  #favPl{width:100%;height:38px;border:1px solid var(--line);border-radius:8px;padding:0 10px;background:#fff;color:var(--t1);font-size:13px;margin:6px 0 4px}
  .pick-all{border-top:1px solid var(--line-soft);padding:8px 0}
  #pickList{max-height:42vh;overflow:auto;border-top:1px solid var(--line-soft)}
  .pick-row{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--line-soft);font-size:13px;cursor:pointer}
  .pick-row input{width:15px;height:15px;accent-color:var(--red);flex:none;cursor:pointer}
  .pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pick-artist{flex:none;color:var(--t3);font-size:12px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #qrbox{text-align:center;padding:14px 0 6px;border-top:1px solid var(--line-soft);margin-top:12px}
  #qrimg img{width:200px;height:200px;border:1px solid var(--line-soft);border-radius:8px;background:#fff}
  #qrstate{margin:8px 0 4px;font-size:13px;color:var(--t2)}
  .privacy{margin-top:12px;padding-top:10px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--t3)}

  .hist{margin-top:14px}
  .hist summary{font-size:13px;color:var(--t2);cursor:pointer;padding:12px 0}
  .h-row{display:flex;gap:12px;padding:9px 0;border-top:1px solid var(--line-soft);font-size:12.5px;color:var(--t2);align-items:baseline}
  .h-time{flex:none;color:var(--t3);font-variant-numeric:tabular-nums}
  .h-name{flex:1;min-width:0;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .h-size{flex:none;color:var(--t3)}

  .foot{margin-top:18px;text-align:center;font-size:12px;color:#b6b6bd;line-height:1.8}

  @media (max-width:560px){ .brand{display:none} .guide-btn .guide-label{display:none} .guide-btn{padding:7px 10px} }
  @media (max-width:400px){ .tab{padding:0 12px} .acct-btn{padding:7px 10px} }
  @media (max-width:560px){
    .upload{flex-wrap:wrap}
    .upload input[type=text],.upload textarea{flex:1 1 100%}
    .upload select{flex:1;width:auto}
    .btn{flex:none;padding:0 22px}
    .song{grid-template-columns:1fr auto;grid-template-areas:"name acts" "artist acts";row-gap:2px}
    .s-meta{display:none}
    .acct-card .crow{flex-wrap:wrap}
    .acct-card input{flex:1 1 100%}
  }
</style>
</head>
<body>

<div class="top">
  <div class="top-in">
    <div class="brand">网易云ICU</div>
    <div class="tabs" role="tablist">
      <button class="tab on" data-tab="fix" onclick="switchTab('fix')">补歌</button>
      <button class="tab" data-tab="up" onclick="switchTab('up')">上传</button>
      <button class="tab" data-tab="local" onclick="switchTab('local')">留声机</button>
    </div>
    <div class="top-right">
      <button class="acct-btn lyr-btn" id="lyrBtn" onclick="toggleLyric()" title="桌面歌词（置顶字幕，跟随网易云播放）" aria-pressed="false"><span class="lyr-ico" aria-hidden="true">♪</span><span class="lyr-label" id="lyrLabel">歌词</span></button>
      <button class="account acct-btn" id="account" onclick="openAccount()" title="账号登录"><span class="dot"></span><span id="acctText">账号</span></button>
      <button class="guide-btn" id="updBtn" onclick="checkUpdate()" title="检查更新"><span class="q">↑</span><span class="guide-label">检查更新</span></button>
      <button class="guide-btn" onclick="openGuide()" title="快速上手"><span class="q">?</span><span class="guide-label">快速上手</span></button>
    </div>
  </div>
</div>

<main>
  <div class="fix-wrap">
    <section class="card" id="fixCard">
      <div class="fix-head">
        <h2>歌单诊断</h2>
      </div>
      <div class="upload fix-pick" style="margin-top:14px">
        <select id="plSel" aria-label="选择歌单"><option value="">正在读取歌单…</option></select>
        <button class="btn" id="scanBtn" onclick="scanGray()">开始扫描</button>
      </div>
      <div id="grayList" style="margin-top:12px"><div class="empty">选择歌单后点击「开始扫描」</div></div>
    </section>
    <aside class="card side" id="fixSide">
      <div class="side-h">我的喜欢<span class="side-note">按播放次数</span></div>
      <div id="sideLiked"><div class="side-empty">加载中…</div></div>
      <div class="side-sec">
        <div class="side-h">推荐歌曲<span class="side-note">每日更新</span></div>
        <div id="sideRec"><div class="side-empty">加载中…</div></div>
        <div class="rec-nav" id="recPager" hidden>
          <button class="fold fold-prev" id="recPrev" onclick="flipRec(-1)" aria-label="上一页"></button>
          <button class="fold fold-next" id="recNext" onclick="flipRec(1)" aria-label="下一页"></button>
        </div>
      </div>
    </aside>
  </div>

  <section class="card" id="uploadCard" hidden>
    <div class="seg" role="tablist" aria-label="上传类型">
      <button class="seg-btn on" data-type="music" onclick="switchType('music')"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" fill="none" stroke="#fb7299" stroke-width="1.9"/><path d="M7 2.8l3.1 3.2M17 2.8l-3.1 3.2" fill="none" stroke="#fb7299" stroke-width="1.9"/><circle cx="8.6" cy="12.6" r="1.5" fill="#fb7299"/><circle cx="15.4" cy="12.6" r="1.5" fill="#fb7299"/></svg>音乐</button>
      <button class="seg-btn" data-type="pod" onclick="switchType('pod')"><svg class="ico" viewBox="0 0 384 512" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.7-74.2 20.7-94.5 20.7-19.4 0-51.1-20.7-79.4-20.7-43.6 0-84.1 25.3-106.6 64.1-45.9 79.8-11.4 197.7 32.9 262.6 21.9 32.5 47.2 69 80.9 70.2h.8c31.6 0 49.5-20.3 92.9-20.3 32.4 0 49.4 18.1 77.7 18.1h.8c35.1 0 61.7-32.1 84.4-69.6 24.3-39.7 34.4-77.6 35.1-79.6-1.6-.7-63.3-26.1-63.9-78.4zM233 97.6c17-20.6 28.2-49.2 25.1-77.6-23.5 1-51.8 15.6-68.7 35.4-15.7 18.4-29.5 48.4-25.5 76.5 25.6 2 53.2-14.7 69.1-34.3z" fill="#333"/></svg>播客</button>
    </div>
    <div class="upload">
      <textarea id="input" rows="1" placeholder="粘贴 B 站视频/合集页链接、音频直链或 BV 号，多个用逗号分隔"></textarea>
      <button class="clip" type="button" onclick="pasteClipboard()" title="从剪贴板识别链接，自动填入并去重">粘贴板</button>
      <button class="btn" id="go" onclick="doUpload()">上传</button>
    </div>
    <div class="sub">
      <label class="chk" id="seasonWrap" title="视频属于B站合集时, 依次上传合集内全部视频; 或直接粘贴合集页链接"><input type="checkbox" id="season">整个合集</label>
      <label class="chk" title="去序号/标签, 拆分'歌手-歌名', 歌手字段自动纠正"><input type="checkbox" id="clean" checked>整理歌名</label>
      <button class="link" onclick="toggleMore()" type="button">手动指定歌名</button>
    </div>
    <div class="more" id="more">
      <input type="text" id="song" placeholder="歌名 (留空=自动)">
      <input type="text" id="artist" placeholder="歌手 (留空=自动)">
    </div>
  </section>

  <section class="card" id="localCard" hidden>
    <div class="fix-head">
      <h2>留声机</h2>
      <span class="side-note">本地音频直接传进云盘</span>
    </div>
    <label class="local-drop" id="localDrop" for="localFile">
      <input type="file" id="localFile" accept=".mp3,.m4a,.aac,.flac,.ogg,.wav,audio/*" hidden>
      <span class="local-ico" aria-hidden="true">♪</span>
      <b id="localName">点击选择或拖入音频文件</b>
      <span id="localHint">MP3 / M4A / FLAC / AAC / OGG / WAV，单文件不超过 200MB</span>
    </label>
    <div class="more" id="localMore" style="display:flex">
      <input type="text" id="localSong" placeholder="歌名 (留空=按文件名)">
      <input type="text" id="localArtist" placeholder="歌手 (留空=自动)">
      <input type="text" id="localAlbum" placeholder="专辑 (可选)">
    </div>
    <div class="sub" style="margin-top:8px">
      <label class="chk" title="离线识别，首次需下载约 150MB 组件"><input type="checkbox" id="localLyric">同时补歌词<span style="opacity:.6;margin-left:6px">需离线组件约 150MB</span></label>
    </div>
    <div class="upload" style="margin-top:12px">
      <button class="btn" id="localGo" onclick="doLocalUpload()">上传到云盘</button>
    </div>
  </section>

  <section class="progress" id="progress" hidden>
    <div id="running">
      <div class="p-top">
        <span class="p-title" id="pTitle">正在上传</span>
        <span class="p-count" id="pCount"></span>
      </div>
      <div class="bar"><i id="pBar"></i></div>
      <div class="p-now" id="pNow">准备中</div>
      <div class="p-errs" id="pErrs" hidden></div>
      <details class="rawlog" id="rawlogWrap"><summary>详细日志</summary><pre id="rawlog"></pre></details>
    </div>
    <div class="p-done" id="finished" hidden>
      <p id="pDone">上传完成</p>
      <button class="link" onclick="document.getElementById('progress').hidden=true">收起</button>
    </div>
  </section>

  <div class="compare split" id="compare">
    <section class="card" id="searchCard">
      <div class="upload">
        <input type="text" id="skw" placeholder="搜索 B 站歌曲/翻唱/演唱会…">
        <button class="btn" id="sbtn" onclick="doSearch()">搜索</button>
      </div>
      <div id="sres" hidden></div>
      <div class="search-empty" id="searchHint">输入歌名后点「搜索」，结果会显示在这里，可与右侧云盘对照</div>
    </section>

    <section class="card cloud">
      <div class="cloud-head">
        <div class="cloud-title">
          <h2>音乐云盘</h2>
          <span class="cloud-meta" id="stats"></span>
        </div>
        <div class="cloud-right">
          <button class="mini" id="batchBtn" onclick="toggleBatch()">批量收藏</button>
          <button class="mini ico-btn" onclick="loadList()" title="刷新云盘" aria-label="刷新云盘"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
        </div>
      </div>
      <div class="batch-bar" id="batchBar" hidden>
        <button class="mini" onclick="selectAllCloud(true)">全选</button>
        <button class="mini" onclick="selectAllCloud(false)">清空</button>
        <span id="batchCount">已选 0 首</span>
        <button class="mini primary" onclick="openBatchFav()">收藏到歌单</button>
      </div>
      <div id="list"></div>
    </section>
  </div>

  <details class="card hist">
    <summary>上传历史 (本地记录, 最近50条) <button class="link" onclick="event.preventDefault();event.stopPropagation();clearHistory()">清空</button></summary>
    <div id="history"></div>
  </details>

  <details class="card hist" id="lyricHistCard" hidden>
    <summary>补歌词历史 (本地记录, 最近50条) <button class="link" onclick="event.preventDefault();event.stopPropagation();clearLyricHistory()">清空</button></summary>
    <div id="lyricHistory"></div>
  </details>

  <div id="lyrBatchLine" style="display:none;margin:12px 2px 0;font-size:12px;line-height:1.75;opacity:.85"></div>

  <p class="foot">免责声明: 上传内容仅限本人收听, 请遵守B站与网易云音乐的服务条款及版权法规, 请勿用于商业用途。</p>
</main>

<div class="acct-modal" id="accountModal" hidden>
  <div class="acct-card" role="dialog" aria-label="账号登录">
    <div class="acct-head"><span>账号登录</span><button class="mini" onclick="closeAccount()">关闭</button></div>
    <div class="acc-row">
      <div class="acc-info" id="ncmInfo"><span class="dot"></span>网易云音乐 · 检测中...</div>
      <button class="mini" data-acc="ncm:qr">扫码登录</button>
    </div>
    <div class="acc-row">
      <div class="acc-info" id="biliInfo"><span class="dot"></span>B站 · 检测中...</div>
      <button class="mini" data-acc="bili:qr">扫码登录</button>
    </div>
    <div id="qrbox" hidden>
      <div id="qrimg"></div>
      <p id="qrstate"></p>
    </div>
    <div class="manual">
      <button class="link" onclick="toggleManual()" type="button">手动粘贴登录凭证</button>
      <div id="manualBox" hidden>
        <div class="crow">
          <input type="password" id="ncmCookie" placeholder="网易云 Cookie（含 MUSIC_U=...）">
          <button class="mini" onclick="saveCookie('ncm')">保存</button>
        </div>
        <div class="crow">
          <input type="password" id="biliCookie" placeholder="B站 Cookie（含 SESSDATA=...）">
          <button class="mini" onclick="saveCookie('bili')">保存</button>
        </div>
      </div>
    </div>
    <p class="privacy">🔒 账号数据仅保存在本机程序目录, 不经过任何第三方服务器, 不会泄露</p>
  </div>
</div>

<div class="acct-modal" id="splitModal" hidden>
  <div class="acct-card" role="dialog" aria-label="文件超过上限">
    <div class="acct-head"><span>文件超过 200MB</span><button class="mini" onclick="closeSplit()">关闭</button></div>
    <p class="split-p" id="splitMsg"></p>
    <div class="split-act">
      <button class="mini" onclick="closeSplit()">取消</button>
      <button class="mini primary" id="splitYes" onclick="confirmSplit()">拆分上传</button>
    </div>
  </div>
</div>

<div class="acct-modal" id="coverModal" hidden>
  <div class="acct-card" role="dialog" aria-label="选择歌曲封面">
    <div class="acct-head"><span id="coverTitle">选择封面</span><button class="mini" onclick="cancelCoverPick()">关闭</button></div>
    <p class="split-p" id="coverSub"></p>
    <div class="cover-grid" id="coverGrid"></div>
    <div class="cover-custom" id="coverCustom" hidden><img id="coverCustomImg" alt=""><span id="coverCustomName"></span></div>
    <div class="cover-acts">
      <label class="mini cover-up">本地上传图片<input type="file" id="coverFile" accept="image/jpeg,image/png" hidden></label>
      <button class="mini" onclick="skipCoverPick()">不用封面</button>
      <span class="spacer"></span>
      <button class="mini" onclick="cancelCoverPick()">取消上传</button>
      <button class="mini primary" id="coverYes" onclick="confirmCoverPick()" disabled>用这张</button>
    </div>
  </div>
</div>

<div class="acct-modal" id="guideModal" hidden>
  <div class="acct-card" role="dialog" aria-label="快速上手">
    <div class="acct-head"><span id="guideTitle">快速上手</span><button class="mini" onclick="closeGuide()">关闭</button></div>
    <div id="guideFix">
      <div class="guide-step"><span class="guide-num">1</span><span>右上角「账号」里分别扫码登录网易云和 B 站。网易云用来读歌单、传云盘，B 站用来找音源。</span></div>
      <div class="guide-step"><span class="guide-num">2</span><span>选一个歌单点「开始扫描」。扫描后，「共 N 首」右侧会出现「加入我喜欢的音乐」和「取消爱心」两个按钮。</span></div>
      <div class="guide-step"><span class="guide-num">3</span><span>展开「暂无音源」或「VIP 专属」，点某首歌右侧的「找音源」，先「试听」确认，再点「补进云盘」。</span></div>
      <div class="guide-step"><span class="guide-num">4</span><span>补完后，统计行右侧按钮会变红。点开后会列出已补的歌，默认全选；再确认一次即可修改「我喜欢的音乐」。还没补歌时点击会提示先去找音源。</span></div>
      <div class="guide-step"><span class="guide-num">5</span><span>原灰歌默认保留；确认云盘版本能正常播放后，再点「取消爱心」把原歌移出歌单。</span></div>
      <div class="guide-tip">云盘单个文件上限 200MB。「取消爱心」只动歌单，不删除云盘文件。</div>
    </div>
    <div id="guideUp" hidden>
      <div class="guide-step"><span class="guide-num">1</span><span>右上角「账号」里分别扫码登录网易云和 B 站：网易云用来接收云盘，B 站用来读取音源。</span></div>
      <div class="guide-step"><span class="guide-num">2</span><span>顶部「上传」里切换「音乐」或「播客」。</span></div>
      <div class="guide-step"><span class="guide-num">3</span><span>音乐走 B 站，可搜音乐、评书、戏曲、播客、助眠；播客走苹果播客，可搜索节目并选单集，也支持小宇宙单集链接。两类都支持音频直链。</span></div>
      <div class="guide-step"><span class="guide-num">4</span><span>点「上传」后，进度和结果会显示在下方；完成后可在「音乐云盘」和上传记录里查看，点云盘歌曲右侧「收藏」可放进任意自建歌单。</span></div>
      <div class="guide-tip">单个文件超过 200MB 时会询问是否拆分上传，拆分后文件名会自动带（序号/总段数）。</div>
    </div>
    <div id="guideLocal" hidden>
      <div class="guide-step"><span class="guide-num">1</span><span>先在右上角「账号」里登录网易云，上传的歌曲会存进网易云云盘。</span></div>
      <div class="guide-step"><span class="guide-num">2</span><span>顶部进入「留声机」，点击虚线框或直接把本地音频拖进来，支持 MP3 / M4A / FLAC / AAC / OGG / WAV，单个文件不超过 200MB。</span></div>
      <div class="guide-step"><span class="guide-num">3</span><span>按需填写歌名、歌手、专辑；歌名留空时会自动使用文件名。</span></div>
      <div class="guide-step"><span class="guide-num">4</span><span>点「上传到云盘」，弹窗里可以本地选一张封面；点「不用封面」则保留音频文件自带的封面。要歌词就勾选「同时补歌词」，首次会提示下载约 150MB 的离线组件。</span></div>
      <div class="guide-step"><span class="guide-num">5</span><span>完成后歌曲会出现在下方「音乐云盘」，点右侧「收藏」就能放进任意自建歌单。</span></div>
      <div class="guide-tip">MP3 / M4A 支持写入新封面，其它格式会原样上传；M4A 暂不支持离线补歌词；超过 200MB 请先压缩或切分。</div>
    </div>
    <div class="split-act" style="margin-top:14px"><button class="btn" onclick="closeGuide()">知道了</button></div>
  </div>
</div>

<div class="toast" id="toast" hidden></div>

<div class="acct-modal" id="listenModal" hidden>
  <div class="listen-card" role="dialog" aria-label="试听">
    <div class="listen-grip"></div>
    <div class="listen-title" id="listenTitle">试听</div>
    <div class="listen-sub" id="listenSub"></div>
    <div class="listen-video"><iframe id="listenFrame" allow="autoplay; fullscreen" allowfullscreen></iframe></div>
    <div class="listen-acts">
      <button class="mini" onclick="closeListen()">返回主页</button>
      <button class="btn listen-go" onclick="openBili()">跳转到 B 站</button>
    </div>
  </div>
</div>

<div class="acct-modal" id="srcModal" hidden>
  <div class="listen-card" role="dialog" aria-label="找音源">
    <div class="listen-grip"></div>
    <div class="listen-title" id="srcTitle">找音源</div>
    <div class="listen-sub" id="srcSub"></div>
    <div class="src-list" id="srcList"></div>
    <div class="listen-acts"><button class="mini" onclick="closeSrc()">关闭</button></div>
  </div>
</div>

<div class="acct-modal" id="lyricModal" hidden>
  <div class="listen-card" role="dialog" aria-label="实时歌词">
    <div class="listen-grip"></div>
    <div class="listen-title" id="lyrTitle">实时歌词</div>
    <div class="listen-sub" id="lyrSub">正在读取播放信息…</div>
    <div class="lyr-box" id="lyrBox"><div class="lyr-empty">等待播放…</div></div>
    <div class="lyr-time"><span id="lyrNow">00:00</span><span id="lyrDur">00:00</span></div>
    <input type="range" class="lyr-seek" id="lyrSeek" min="0" max="100" step="0.5" value="0"
           oninput="seekLyric(this.value)" aria-label="校准进度">
    <div id="lyrCands" style="display:none;margin:8px 0 0;max-height:230px;overflow:auto;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.6"></div>
    <div id="sttBox" style="display:none;margin:8px 0 0;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.7">
      <div id="sttAsr" style="display:none;margin-bottom:8px"></div>
      <div id="sttBody" style="max-height:200px;overflow:auto"></div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="mini primary" id="sttGo" onclick="sttStart()">开始补时间轴</button>
        <button class="mini" id="sttUndo" onclick="sttUndo()" style="display:none">清除本机歌词</button>
        <button class="mini" id="sttCancel" onclick="sttCancel()">取消</button>
      </div>
    </div>
    <div class="listen-acts">
      <button class="mini" onclick="nudgeLyric(-1)">−1 秒</button>
      <button class="mini" onclick="nudgeLyric(1)">+1 秒</button>
      <button class="mini" onclick="calibrateLyric(this)">校准</button>
      <button class="mini" onclick="recalibrate()">从头对齐</button>
      <button class="mini" onclick="openCands()">换歌词版本</button>
      <button class="mini" id="sttBtn" onclick="openSttPanel()" title="没有时间轴歌词时，用本地 whisper 听一遍这段音频，自动补上时间戳">补时间轴</button>
      <button class="mini" onclick="ncmDirect(this)" title="不用插件: 以调试端口重启网易云后直接读进度">调试直连</button>
      <span class="mini-note" id="ncmSt" title="检查网易云进程的命令行是否带 --remote-debugging-port"></span>
      <button class="mini" id="brBtn" onclick="installBridge(this)" title="安装网易云桥接插件, 拿到真实进度">桥接插件</button>
      <button class="mini" onclick="closeLyric()">关闭</button>
    </div>
  </div>
</div>

<div class="acct-modal" id="pickModal" hidden>
  <div class="acct-card" role="dialog" aria-label="选择歌曲">
    <div class="acct-head"><span id="pickTitle">选择歌曲</span><button class="mini" onclick="closePick()">关闭</button></div>
    <p class="pick-sub" id="pickSub"></p>
    <label class="chk pick-all"><input type="checkbox" id="pickAll" checked onchange="togglePickAll(this.checked)">全选</label>
    <div id="pickList"></div>
    <div class="split-act" style="margin-top:14px">
      <button class="mini" onclick="closePick()">取消</button>
      <button class="mini primary" id="pickYes" onclick="confirmPick()">确认</button>
    </div>
  </div>
</div>

<div class="acct-modal" id="favModal" hidden>
  <div class="acct-card" role="dialog" aria-label="收藏到歌单">
    <div class="acct-head"><span id="favTitle">收藏到歌单</span><button class="mini" onclick="closeFav()">关闭</button></div>
    <p class="pick-sub" id="favSub">选择要收藏到的歌单，默认「我喜欢的音乐」。</p>
    <select id="favPl" aria-label="选择歌单"></select>
    <div class="split-act" style="margin-top:14px">
      <button class="mini primary" id="favYes" onclick="confirmFav()">收藏</button>
    </div>
  </div>
</div>

<div class="bp" id="biliPanel" hidden>
  <div class="bp-bar">
    <span class="bp-t" id="bpTitle">B站搜索</span>
    <span class="bp-hint">找到视频后复制它的链接，回到本页粘贴即可上传</span>
    <button class="mini" onclick="reloadBiliSearch()">重新搜索</button>
    <button class="mini" onclick="closeBiliPanel()">返回本页</button>
  </div>
  <iframe id="bpFrame" src="about:blank" title="B站搜索"></iframe>
</div>
<script>
function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const $ = id => document.getElementById(id);
function lockScroll(){ document.body.style.overflow = (!$('biliPanel').hidden || !$('accountModal').hidden || !$('splitModal').hidden || !$('coverModal').hidden || !$('pickModal').hidden || !$('favModal').hidden || !$('guideModal').hidden || !$('listenModal').hidden || !$('srcModal').hidden || !$('lyricModal').hidden) ? 'hidden' : ''; }
function openAccount(){ $('accountModal').hidden = false; lockScroll(); }
function closeAccount(){ $('accountModal').hidden = true; lockScroll(); }
function toggleManual(){ $('manualBox').hidden = !$('manualBox').hidden; }
function toggleMore(){ $('more').classList.toggle('open'); }
function focusInput(){ $('input').focus(); }

// 导航三级: 补歌 / 上传 / 留声机; 上传下二级 音乐(B站)/播客(苹果·小宇宙). 进度与历史共用
let curTab = 'fix', curType = 'music';
function switchTab(t) {
  const next = t === 'up' ? 'up' : (t === 'local' ? 'local' : 'fix');
  const changed = next !== curTab;
  curTab = next;
  try { localStorage.setItem('GraySongICU.tab', curTab); } catch (e) {}
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
  const fix = curTab === 'fix', loc = curTab === 'local';
  $('fixCard').hidden = !fix;
  $('fixSide').hidden = !fix;
  $('uploadCard').hidden = curTab !== 'up';
  $('localCard').hidden = !loc;
  $('searchCard').hidden = fix || loc;
  $('compare').hidden = fix;
  if (fix) { setSplit(false); loadPlaylists(); loadSide(); }
  else if (loc) setSplit(false);
  else applyType();
  if (changed) window.scrollTo(0, 0);
}
function switchType(t) {
  curType = t === 'pod' ? 'pod' : 'music';
  try { localStorage.setItem('GraySongICU.type', curType); } catch (e) {}
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.type === curType));
  resetSearchState();
  if (curTab === 'up') applyType();
}
function resetSearchState() {
  searchItems = []; searchMode = ''; appleShows = []; appleEps = []; appleShowName = '';
  $('sres').hidden = true; $('sres').innerHTML = '';
  $('searchHint').hidden = false;
}
function applyType() {
  const t = curType;
  $('input').placeholder = t === 'pod'
    ? '粘贴苹果播客单集链接（或小宇宙单集链接），多个用逗号分隔'
    : '粘贴 B 站视频/合集页链接、音频直链或 BV 号，多个用逗号分隔';
  $('seasonWrap').hidden = t !== 'music';
  $('skw').placeholder = t === 'pod'
    ? '搜索苹果播客节目，如：故事FM、忽左忽右…'
    : '搜索 B 站音乐/评书/戏曲/播客/助眠…';
  $('searchHint').textContent = t === 'music'
    ? '输入关键词后点「搜索」，B 站里的音乐、评书、戏曲、播客、助眠都可以搜；右侧可对照云盘'
    : '搜索节目后点「看单集」，再选具体单集上传；右侧可对照云盘已有歌曲';
  setSplit(true);
}

// 超过 200MB: 询问是否拆分成多个文件上传
let splitInfo = null;
function openSplit(info) {
  splitInfo = info;
  const mb = Math.round(info.size / 1048576);
  let msg = '这个文件约 ' + mb + 'MB，超过网易云云盘单文件 200MB 上限。';
  if (info.canSplit) {
    msg += '是否按音频位置拆成 ' + Math.ceil(info.size / (192 * 1048576)) + ' 个文件依次上传？'
      + '歌名会自动加上 (1/N) 编号，在云盘里连续播放。';
  } else {
    msg += '当前是 ' + info.ext + ' 格式，无法安全拆分；请换一期 MP3 或 M4A 音源的节目。';
  }
  $('splitMsg').textContent = msg;
  $('splitYes').hidden = !info.canSplit;
  $('splitModal').hidden = false;
  lockScroll();
}
function closeSplit(){ $('splitModal').hidden = true; splitInfo = null; lockScroll(); }
function confirmSplit(){ closeSplit(); doUpload(true, true); }

// 日志流: 全文进「详细日志」, 简短一行进 pNow, 错误行进 pErrs (错误态常驻可见)
function step(msg, isErr) {
  const pre = $('rawlog');
  pre.textContent += msg + '\\n';
  pre.scrollTop = pre.scrollHeight;
  if (isErr) {
    const eb = $('pErrs');
    eb.hidden = false;
    eb.textContent = (eb.textContent ? eb.textContent + '\\n' : '') + msg;
    return;
  }
  const short = msg.length > 66 ? msg.slice(0, 66) + '…' : msg;
  $('pNow').innerHTML = '<b>' + esc(short) + '</b>';
}
let lastTotal = 0;
function setBar(n, total) {
  $('pCount').textContent = total > 1 ? n + ' / ' + total : '';
  $('pBar').style.width = Math.max(3, Math.round(n / total * 100)) + '%';
}
// 单P任务无 [n/m] 行, 按阶段推进进度条
function phaseBar(msg) {
  if (lastTotal) return;
  const w = $('pBar');
  if (msg.indexOf('正在获取音频') > -1) w.style.width = '12%';
  else if (msg.indexOf('下载音频') > -1) w.style.width = '32%';
  else if (msg.indexOf('正在上传文件') > -1) w.style.width = '62%';
  else if (msg.indexOf('正在保存歌曲信息') > -1) w.style.width = '82%';
  else if (msg.indexOf('正在发布到云盘') > -1) w.style.width = '92%';
  else if (msg.indexOf('✓ 上传完成') > -1) w.style.width = '100%';
}
// 进度卡重置与上传事件流解析 (音乐页 / 补歌页共用)
function resetProgress(title) {
  lastTotal = 0;
  $('progress').hidden = false;
  $('running').hidden = false; $('finished').hidden = true;
  $('pErrs').hidden = true; $('pErrs').textContent = '';
  $('rawlog').textContent = '';
  $('pTitle').textContent = title || '正在上传'; $('pNow').textContent = '准备中';
  $('pCount').textContent = ''; $('pBar').style.width = '3%';
}
async function readUploadStream(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream:true });
    const lines = buf.split('\\n');
    buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; onLine(JSON.parse(l)); }
  }
}
let biliLogged = false;
// 账号登录整体收纳到顶栏「账号」按钮, 点开后才显示两端登录状态与扫码
function renderSettings(j) {
  const n = $('ncmInfo'), b = $('biliInfo');
  n.innerHTML = j.ncm.ok
    ? '<span class="dot on"></span>网易云音乐 <b>' + esc(j.ncm.nickname) + '</b> · 已登录'
    : j.ncm.timeout
      ? '<span class="dot off"></span>网易云音乐 · 检测超时'
      : '<span class="dot off"></span>网易云音乐 · 未登录';
  n.nextElementSibling.textContent = j.ncm.ok ? '更换账号' : '扫码登录';
  b.innerHTML = '<span class="dot ' + (j.bili ? 'on' : 'off') + '"></span>B站 · ' + (j.bili ? '已登录' : '未登录');
  b.nextElementSibling.textContent = j.bili ? '更换账号' : '扫码登录';
  const dot = $('account').querySelector('.dot');
  dot.className = 'dot ' + (j.ncm.ok ? 'on' : 'off');
  $('account').title = '网易云: ' + (j.ncm.ok ? esc(j.ncm.nickname) : j.ncm.timeout ? '检测超时' : '未登录')
    + ' | B站: ' + (j.bili ? '已登录' : '未登录');
}
async function loadStatus() {
  let j;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 35000);
  try {
    j = await (await fetch('/api/status', { signal: ac.signal })).json();
  } catch (e) {
    $('account').querySelector('.dot').className = 'dot off';
    $('account').title = '登录态检测超时, 点击重试';
    return;
  } finally { clearTimeout(timer); }
  biliLogged = !!j.bili;
  renderSettings(j);
}
$('accountModal').addEventListener('click', e => {
  const btn = e.target.closest('button[data-acc]'); if (!btn) return;
  showQr(btn.dataset.acc.split(':')[0]);
});
$('accountModal').addEventListener('click', e => { if (e.target === $('accountModal')) closeAccount(); });
// 扫码登录: 本地渲染二维码, 轮询状态, 成功自动写入凭证并刷新
let qrTimer = null, qrKind = '', qrKey = '';
async function showQr(kind) {
  qrKind = kind; clearInterval(qrTimer);
  openAccount();
  $('qrbox').hidden = false;
  $('qrimg').innerHTML = '<div class="empty">获取中...</div>';
  $('qrstate').textContent = '';
  try {
    const r = await (await fetch('/api/qr/' + kind + '/create')).json();
    if (!r.ok) throw new Error(r.error || '获取失败');
    qrKey = r.key;
    $('qrimg').innerHTML = '<img src="/api/qr/svg?text=' + encodeURIComponent(r.text) + '" alt="二维码">';
    $('qrstate').textContent = '请用' + (kind === 'bili' ? '哔哩哔哩' : '网易云音乐') + 'App扫码, 成功后自动登录';
    qrTimer = setInterval(pollQr, 2000);
  } catch (e) { $('qrstate').textContent = errMsg(e, '二维码获取失败'); }
}
async function pollQr() {
  try {
    const r = await (await fetch('/api/qr/' + qrKind + '/poll?key=' + encodeURIComponent(qrKey))).json();
    if (r.state === 'done') {
      clearInterval(qrTimer); qrTimer = null;
      $('qrstate').textContent = '登录成功';
      setTimeout(() => { if ($('qrstate').textContent === '登录成功') $('qrbox').hidden = true; }, 1200);
      loadStatus(); if (qrKind === 'ncm') loadList();
    } else if (r.state === 'scanned') $('qrstate').textContent = '已扫码, 请在手机上确认';
    else if (r.state === 'expired') {
      clearInterval(qrTimer); qrTimer = null;
      $('qrstate').textContent = '二维码已过期, 请重新点击扫码登录';
    }
  } catch (e) { /* 轮询失败静默, 下次重试 */ }
}
async function saveCookie(kind) {
  const v = kind === 'ncm' ? $('ncmCookie').value.trim() : $('biliCookie').value.trim();
  const r = await (await fetch('/api/cookie', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({kind, value:v}) })).json();
  if (r.ok) {
    if (kind === 'ncm') $('ncmCookie').value = ''; else $('biliCookie').value = '';
    loadStatus(); if (kind === 'ncm') loadList();
  } else alert('保存失败: ' + r.error);
}
async function loadHistory() {
  try {
    const j = await (await fetch('/api/history')).json();
    const box = $('history');
    if (!j.items.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
    box.innerHTML = j.items.map(h =>
      '<div class="h-row"><span class="h-time">' + esc(h.time) + '</span><span class="h-name">' + esc(h.song) + '</span>'
      + '<span class="h-size">' + (h.size ? (h.size/1048576).toFixed(1)+'MB' : '-') + '</span></div>').join('');
  } catch (e) { /* 历史加载失败不打扰主流程 */ }
}
async function clearHistory() {
  if (!confirm('确定清空全部上传历史? 此操作不可恢复')) return;
  try { await fetch('/api/history', { method: 'DELETE' }); loadHistory(); } catch (e) {}
}
// 补歌词历史: 只有真的补过才显示折叠区, 否则整块隐藏
async function loadLyricHistory() {
  const card = $('lyricHistCard'), box = $('lyricHistory');
  if (!card || !box) return;
  try {
    const j = await (await fetch('/api/lyric/history', { cache: 'no-store' })).json();
    const items = (j && j.items) || [];
    if (!items.length) { card.hidden = true; card.open = false; box.innerHTML = ''; return; }
    card.hidden = false;
    box.innerHTML = items.map(h =>
      '<div class="h-row"><span class="h-time">' + esc(h.time) + '</span><span class="h-name">'
      + esc(h.song || '') + (h.artist ? ' · ' + esc(h.artist) : '') + '</span>'
      + '<span class="h-size">' + Number(h.lines || 0) + ' 句</span></div>').join('');
  } catch (e) { card.hidden = true; }
}
async function clearLyricHistory() {
  if (!confirm('确定清空全部补歌词历史? 此操作不可恢复')) return;
  try { await fetch('/api/lyric/history', { method: 'DELETE' }); loadLyricHistory(); } catch (e) {}
}
// 表单记忆: 只存偏好项(音质/整理歌名/歌名/歌手); 上传全部/整个合集属场景开关不记忆, 防误触发大批量
const FORM_KEY = 'GraySongICU_form_v1';
function saveForm() {
  try { localStorage.setItem(FORM_KEY, JSON.stringify({
    clean: $('clean').checked, song: $('song').value, artist: $('artist').value })); } catch (e) {}
}
function restoreForm() {
  try {
    const f = JSON.parse(localStorage.getItem(FORM_KEY) || '{}');
    if (f.clean !== undefined) $('clean').checked = f.clean;
    if (f.song) $('song').value = f.song;
    if (f.artist) $('artist').value = f.artist;
  } catch (e) {}
}
// 空状态带行动 / 加载失败可重试 / grid 行布局
let cloudSongs = [], cloudLoaded = false;
// 云盘批量收藏: 进入选择模式后逐首勾选, 统一收藏到自建歌单
let batchMode = false;
const batchSel = new Set();
function toggleBatch() {
  batchMode = !batchMode;
  batchSel.clear();
  $('batchBar').hidden = !batchMode;
  $('batchBtn').textContent = batchMode ? '取消批量' : '批量收藏';
  $('batchCount').textContent = '已选 0 首';
  loadList();
}
function toggleSong(id) {
  const k = String(id);
  if (batchSel.has(k)) batchSel.delete(k); else batchSel.add(k);
  $('batchCount').textContent = '已选 ' + batchSel.size + ' 首';
}
function selectAllCloud(on) {
  batchSel.clear();
  if (on) cloudSongs.forEach(s => batchSel.add(String(s.songId)));
  $('batchCount').textContent = '已选 ' + batchSel.size + ' 首';
  loadList();
}
async function loadList() {
  const box = $('list');
  try {
    const j = await (await fetch('/api/list')).json();
    const fmtSize = n => n >= 1073741824 ? (n/1073741824).toFixed(1)+' GB' : (n/1048576).toFixed(1)+' MB';
    $('stats').textContent = '共 ' + j.count + ' 首 · ' + fmtSize(j.size) + (j.maxSize ? ' / 容量 ' + fmtSize(j.maxSize) : '');
    if (j.error) { box.innerHTML = '<div class="empty">' + esc(j.error) + '<br><button onclick="loadList()">重试</button></div>'; return; }
    cloudSongs = j.songs || []; cloudLoaded = true;
    if (searchMode) refreshSearchDup();
    if (!j.songs.length) { box.innerHTML = '<div class="empty">云盘还是空的<br><button onclick="focusInput()">去上传第一首</button></div>'; return; }
    box.innerHTML = j.songs.map(s =>
      '<div class="song"><div class="s-name">'
      + (batchMode ? '<input type="checkbox" class="batch-chk" data-id="' + s.songId + '"' + (batchSel.has(String(s.songId)) ? ' checked' : '') + '>' : '')
      + esc(s.name) + '</div><div class="s-artist">' + esc(s.artist) + '</div>'
      + '<div class="s-meta">' + (s.bitrate ? Math.round(s.bitrate / 1000) + 'kbps · ' : '')
      + (s.size ? (s.size / 1048576).toFixed(1) + 'MB' : '-') + '</div>'
      + '<div class="s-acts"><button class="s-fav" data-id="' + s.songId + '" data-name="' + esc(s.name) + '">收藏</button>'
      + '<button class="s-del" data-id="' + s.songId + '" data-name="' + esc(s.name) + '">删除</button></div></div>').join('');
  } catch (e) {
    box.innerHTML = '<div class="empty">加载失败<button onclick="loadList()">重试</button></div>';
  }
}
$('list').addEventListener('click', e => {
  const chk = e.target.closest('.batch-chk');
  if (chk) { toggleSong(chk.dataset.id); return; }
  const fav = e.target.closest('.s-fav');
  if (fav) { openFav({ songId: Number(fav.dataset.id), name: fav.dataset.name }); return; }
  const b = e.target.closest('.s-del'); if (!b) return;
  if (!confirm('确定从云盘删除《' + b.dataset.name + '》?')) return;
  fetch('/api/del', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({songId:+b.dataset.id}) }).then(loadList);
});
// 云盘歌曲收藏到指定歌单(默认「我喜欢的音乐」), 支持单首与批量
let favIds = [], plCache = null;
async function getPlaylistCache() {
  if (plCache) return plCache;
  const j = await (await fetch('/api/playlists')).json();
  if (j.error) throw new Error(j.error || '歌单读取失败');
  plCache = j.playlists || [];
  return plCache;
}
async function openFav(song, ids) {
  favIds = Array.isArray(ids) && ids.length ? ids.slice() : (song ? [song.songId] : []);
  if (!favIds.length) return;
  $('favTitle').textContent = song ? '收藏《' + song.name + '》到歌单' : '收藏 ' + favIds.length + ' 首到歌单';
  $('favSub').textContent = song ? '选择要收藏到的歌单，默认「我喜欢的音乐」。' : '已选 ' + favIds.length + ' 首，选择要收藏到的自建歌单。';
  $('favPl').innerHTML = '<option>读取歌单中…</option>';
  $('favModal').hidden = false;
  lockScroll();
  try {
    const list = await getPlaylistCache();
    const own = list.filter(p => p.own || p.special);
    if (!own.length) throw new Error('还没有可收藏的自己创建的歌单');
    $('favPl').innerHTML = own.map(p =>
      '<option value="' + p.id + '"' + (p.special ? ' selected' : '') + '>' + esc(p.name) + '（' + p.count + ' 首）</option>').join('');
  } catch (e) {
    $('favPl').innerHTML = '<option value="">' + esc(errMsg(e, '歌单读取失败')) + '</option>';
  }
}
function openBatchFav() {
  if (!batchSel.size) { toast('请先勾选要收藏的歌曲'); return; }
  openFav(null, Array.from(batchSel).map(Number));
}
function closeFav() { $('favModal').hidden = true; favIds = []; lockScroll(); }
async function confirmFav() {
  if (!favIds.length) return;
  const pid = Number($('favPl').value);
  if (!pid) { toast('请先选择歌单'); return; }
  const btn = $('favYes');
  btn.disabled = true; btn.textContent = '收藏中';
  try {
    const j = await (await fetch('/api/playlist/tracks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'add', pid, ids: favIds }),
    })).json();
    if (!j.ok) throw new Error(j.error || '收藏失败');
    const hit = (plCache || []).find(p => String(p.id) === String(pid));
    toast('已收藏 ' + favIds.length + ' 首到「' + (hit ? hit.name : '歌单') + '」');
    const wasBatch = batchMode;
    closeFav();
    if (wasBatch) toggleBatch();
  } catch (e) {
    alert('收藏失败: ' + errMsg(e, '请稍后重试'));
  }
  btn.disabled = false; btn.textContent = '收藏';
}
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doUpload(); } });
function uploadBV(bvid) { $('input').value = bvid; doUpload(); }

// ---------- 补歌: 扫描歌单灰歌/VIP歌 → B站找音源 → 补进云盘 ----------
let graySongs = [], grayGroups = { gray: [], vip: [] }, fixSongs = [], scanTotal = 0, scanPid = '', fixRunning = false;
const deletedSids = new Set();
async function loadPlaylists() {
  const sel = $('plSel');
  const keep = sel.value;
  try {
    const j = await (await fetch('/api/playlists')).json();
    if (j.error) {
      sel.innerHTML = '<option value="">' + esc(j.error) + '</option>';
      if (!graySongs.length) {
        $('grayList').innerHTML = '<div class="empty">' + esc(j.error)
          + '<br><button class="mini" data-act="qr">扫码登录网易云</button></div>';
      }
      return;
    }
    const list = j.playlists || [];
    if (!list.length) { sel.innerHTML = '<option value="">还没有歌单</option>'; return; }
    sel.innerHTML = list.map(p => '<option value="' + p.id + '">' + esc(p.name) + '（' + p.count + ' 首）</option>').join('');
    const saved = keep || localStorage.getItem('GraySongICU.pid') || '';
    if (saved && list.some(p => String(p.id) === saved)) sel.value = saved;
  } catch (e) {
    sel.innerHTML = '<option value="">歌单读取失败</option>';
  }
}
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000), m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
let sideLoaded = false;
let sideRec = [], recPage = 0;
const REC_PER_PAGE = 5;
function renderRec() {
  const total = Math.ceil(sideRec.length / REC_PER_PAGE);
  if (recPage >= total) recPage = Math.max(0, total - 1);
  const start = recPage * REC_PER_PAGE;
  const list = sideRec.slice(start, start + REC_PER_PAGE);
  $('sideRec').innerHTML = list.length ? list.map(s =>
    '<div class="side-item"><div class="side-line"><span class="side-name">' + esc(s.name) + '</span>'
    + (typeof s.score === 'number' ? '<span class="stamp">' + s.score + '% 相似</span>' : '') + '</div>'
    + '<div class="side-sub">' + esc(s.artist || '未知歌手') + '</div></div>').join('')
    : '<div class="side-empty">暂无推荐</div>';
  $('recPager').hidden = total <= 1;
  $('recPrev').disabled = recPage <= 0;
  $('recNext').disabled = recPage >= total - 1;
}
function flipRec(d) {
  const total = Math.ceil(sideRec.length / REC_PER_PAGE);
  const next = recPage + d;
  if (next < 0 || next >= total) return;
  recPage = next;
  renderRec();
}
async function loadSide() {
  if (sideLoaded) return;
  try {
    const j = await (await fetch('/api/side')).json();
    if (j.error) {
      $('sideLiked').innerHTML = '<div class="side-empty">登录网易云后显示</div>';
      $('sideRec').innerHTML = '<div class="side-empty">登录网易云后显示</div>';
      return;
    }
    sideLoaded = true;
    const liked = j.liked || [];
    $('sideLiked').innerHTML = liked.length ? liked.map(s =>
      '<div class="side-item"><div class="side-name">' + esc(s.name) + '</div><div class="side-sub">'
      + esc(s.artist || '未知歌手') + (s.count ? ' · ' + s.count + ' 次' : '') + '</div></div>').join('')
      : '<div class="side-empty">还没有喜欢的歌</div>';
    sideRec = j.rec || [];
    recPage = 0;
    renderRec();
  } catch (e) {
    $('sideLiked').innerHTML = '<div class="side-empty">加载失败</div>';
    $('sideRec').innerHTML = '<div class="side-empty">加载失败</div>';
    $('recPager').hidden = true;
  }
}
function durSec(d) {
  const p = String(d || '0:00').split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}
async function scanGray() {
  const pid = $('plSel').value;
  if (!pid) { $('plSel').focus(); return; }
  const btn = $('scanBtn'), box = $('grayList');
  btn.disabled = true; btn.textContent = '扫描中';
  box.innerHTML = '<div class="empty">正在扫描歌单，请稍候…</div>';
  try {
    const j = await (await fetch('/api/gray?pid=' + encodeURIComponent(pid))).json();
    if (j.error) throw new Error(j.error);
    grayGroups = { gray: j.gray || [], vip: j.vip || [] };
    graySongs = grayGroups.gray.concat(grayGroups.vip);
    scanTotal = j.total || 0;
    scanPid = pid;
    fixSongs = []; deletedSids.clear(); refreshFixButtons();
    try { localStorage.setItem('GraySongICU.pid', pid); } catch (e) {}
    renderFix();
  } catch (e) {
    graySongs = [];
    box.innerHTML = '<div class="empty">' + esc(errMsg(e, '歌单扫描失败')) + '<br><button onclick="scanGray()">重试</button></div>';
  }
  btn.disabled = false; btn.textContent = '开始扫描';
}
function rowHtml(s) {
  return '<div class="gq" data-sid="' + s.id + '"><div class="gq-row">'
    + '<div class="gq-l"><div class="gq-t">' + esc(s.name) + (s.fee === 1 ? '<span class="badge">VIP</span>' : '') + '</div>'
    + '<div class="gq-m">' + esc(s.artist) + ' · ' + fmtDur(s.durMs) + '</div></div>'
    + '<div class="gq-a"><button class="mini" data-act="find">找音源</button></div>'
    + '</div></div>';
}
function renderFix() {
  const box = $('grayList');
  const g = grayGroups.gray.filter(s => !deletedSids.has(s.id));
  const v = grayGroups.vip.filter(s => !deletedSids.has(s.id));
  if (!g.length && !v.length) {
    box.innerHTML = '<div class="empty">这个歌单里没有需要补的歌</div>';
    return;
  }
  let html = '<div class="sr-head"><span>共 ' + scanTotal + ' 首 · 暂无音源 ' + g.length + ' · VIP 专属 ' + v.length + '</span>'
    + '<div class="sr-btns">'
    + '<button class="mini" id="addLikeBtn" data-pick="add">加入我喜欢的音乐</button>'
    + '<button class="mini" id="delOrigBtn" data-pick="del">取消爱心</button>'
    + '</div></div>';
  if (g.length) html += '<details class="grp"><summary><span class="sum-l"><i class="dot-red"></i>暂无音源 · ' + g.length + ' 首</span><span class="sum-r"><span class="cta-breathe">音源补充</span></span></summary>' + g.map(rowHtml).join('') + '</details>';
  if (v.length) html += '<details class="grp"><summary><span class="sum-l">VIP 专属 · ' + v.length + ' 首</span></summary>' + v.map(rowHtml).join('') + '</details>';
  box.innerHTML = html;
  refreshFixButtons();
}
let srcSong = null, srcRow = null;
function openSrc(song, row) {
  srcSong = song; srcRow = row;
  $('srcTitle').textContent = '《' + song.name + '》';
  $('srcSub').textContent = [song.artist, fmtDur(song.durMs)].filter(Boolean).join(' · ');
  $('srcList').innerHTML = '<div class="cand-empty">正在 B 站找音源…</div>';
  $('srcModal').hidden = false;
  lockScroll();
}
function closeSrc() {
  $('srcModal').hidden = true;
  lockScroll();
}

// ---------- 实时歌词: 锚点+计时推算(网易云不上报进度, 只能自算) ----------
let lyrTimer = null, lyrBusy = false, lyrIdx = -1, lyrWarned = false;
let lyrKey = '', lyrLines = [], lyrDur = 0, lyrStatus = '', lyrSong = { title: '', artist: '' }, lyrAudioDur = 0;
let lyrAnc = { pos: 0, at: 0, paused: false };
let lyrWinPoll = null;

// 桌面歌词: 由本地服务拉起 Electron 透明置顶窗, 浏览器里只负责开关
async function toggleLyric(){
  try {
    const st = await (await fetch('/api/lyric-window')).json();
    if (st.running) {
      await fetch('/api/lyric-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'close' }) });
      setLyrBtn(false); stopLyrWinPoll(); toast('桌面歌词已关闭');
      return;
    }
    const r = await (await fetch('/api/lyric-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'open' }) })).json();
    startLyricBatch();
    if (!r.ok) { toast(r.error || '桌面歌词启动失败'); openLyric(); return; }
    if (r.installing) { setLyrBtn(true); startLyrWinPoll(); toast('首次使用，正在安装桌面歌词组件（约 20 秒），装好会自动打开'); return; }
    setLyrBtn(true); startLyrWinPoll(); toast('桌面歌词已开启，可拖动浮窗到任意位置');
  } catch (e) {
    toast('桌面歌词启动失败'); openLyric();
  }
}
function setLyrBtn(on){
  $('lyrBtn').classList.toggle('on', on);
  $('lyrBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
}
function startLyrWinPoll(){
  stopLyrWinPoll();
  lyrWinPoll = setInterval(async () => {
    try {
      const st = await (await fetch('/api/lyric-window')).json();
      if (st.running) { setLyrBtn(true); stopLyrWinPoll(); return; }
      if (st.installing) return; // 组件安装中, 继续等待
      setLyrBtn(false); stopLyrWinPoll();
    } catch (e) {}
  }, 3000);
}
function stopLyrWinPoll(){ if (lyrWinPoll) { clearInterval(lyrWinPoll); lyrWinPoll = null; } }
// 点「歌词」打开桌面窗时, 后台自动把上传历史里缺歌词的歌批量补上
// 先联网, 找不到再用本地 whisper; 进度显示在导航按钮和歌词抽屉里
let batchPoll = null, batchWasRunning = false, batchSeenSaved = '';
function startLyricBatch(){
  fetch('/api/lyric/batch/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(r => r.json())
    .then(j => {
      if (j.started) toast('后台开始补 ' + j.total + ' 首缺歌词的歌');
      if (j.running) startBatchPoll();
    })
    .catch(() => {});
}
function startBatchPoll(){
  if (batchPoll) return;
  batchPoll = setInterval(batchTick, 4000);
  batchTick();
}
// 页面打开就接管后台补歌词进度: 哪怕任务是在别处/上次打开的, 这里也实时显示
startBatchPoll();
async function batchTick(){
  try {
    const j = await (await fetch('/api/lyric/batch')).json();
    const lbl = $('lyrLabel');
    if (lbl) lbl.textContent = j.running ? '补歌词 ' + j.done + '/' + j.total : '歌词';
    const line = $('lyrBatchLine');
    if (line) {
      if (j.running) {
        line.style.display = 'block';
        line.innerHTML = '批量补歌词 ' + j.done + '/' + j.total
          + (j.current ? ' · 当前 ' + esc(j.current) : '')
          + '（B站字幕 ' + j.bili + ' / 网易云 ' + j.online + ' / 本地 ' + j.stt + ' / 失败 ' + j.failed + '）'
          + (j.asrReady === false ? ' · 本地转写不可用（' + esc(j.asrReason || '未安装 Python') + '）' : '')
          + ' <button class="mini" onclick="stopLyricBatch()">停止</button>';
      } else if (j.total) {
        line.style.display = 'block';
        line.textContent = '上次批量补歌词：共 ' + j.total + ' 首，B站字幕 ' + j.bili + '，网易云 ' + j.online + '，本地 ' + j.stt + '，失败 ' + j.failed + '，跳过 ' + j.skipped
          + (j.asrReady === false ? '（本地转写未启用：' + (j.asrReason || '未安装 Python') + '）' : '');
      } else {
        line.style.display = 'block';
        line.textContent = '后台补歌词：暂无待补任务';
      }
    }
    // 批量刚好补到正在播放这首: 立刻重新加载, 不用等切歌
    if (j.lastSaved && j.lastSaved !== batchSeenSaved && j.lastSaved === lyrKey && !lyrLines.length && lyrSong.title) {
      batchSeenSaved = j.lastSaved;
      await loadLyric(lyrSong.title, lyrSong.artist, lyrAudioDur);
    }
    if (batchWasRunning && !j.running) { toast('批量补歌词完成：B站字幕 ' + j.bili + ' · 网易云 ' + j.online + ' · 本地 ' + j.stt + ' · 失败 ' + j.failed); loadLyricHistory(); }
    batchWasRunning = !!j.running;
    if (!j.running && (j.finishedAt || !j.total) && batchPoll) { clearInterval(batchPoll); batchPoll = null; }
  } catch (e) {}
}
async function stopLyricBatch(){
  try {
    await fetch('/api/lyric/batch/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('正在停止批量补歌词');
  } catch (e) {}
}
function openLyric(){
  $('lyricModal').hidden = false;
  $('lyrBtn').classList.add('on'); $('lyrBtn').setAttribute('aria-pressed', 'true');
  lockScroll(); startLyricLoop(); refreshNcmStatus();
}
function closeLyric(){
  closeCands();
  stopLyricLoop();
  $('lyricModal').hidden = true;
  $('lyrBtn').classList.remove('on'); $('lyrBtn').setAttribute('aria-pressed', 'false');
  lockScroll();
}
function startLyricLoop(){
  if (lyrTimer) return;
  lyrKey = ''; lyrStatus = ''; lyrLines = []; lyrDur = 0; lyrIdx = -1; lyrWarned = false;
  lyrSong = { title: '', artist: '' };
  lyricTick();
  lyrTimer = setInterval(lyricTick, 500);
}
function stopLyricLoop(){ if (lyrTimer) { clearInterval(lyrTimer); lyrTimer = null; } }
let lyrCandsData = [];
function closeCands(){ const b = $('lyrCands'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }
async function openCands(){
  const t = lyrSong.title, a = lyrSong.artist;
  if (!t) return;
  const b = $('lyrCands');
  b.style.display = 'block';
  b.innerHTML = '正在搜索可用的歌词版本…';
  try {
    const r = await (await fetch('/api/lyric/cands?title=' + encodeURIComponent(t) + '&artist=' + encodeURIComponent(a) + '&dur=' + Math.round(lyrAudioDur || 0))).json();
    if (!r.ok) { b.innerHTML = esc(r.error || '搜索失败'); return; }
    lyrCandsData = r.cands || [];
    const head = '音源 ' + Math.round(r.dur || 0) + 's' + (r.current && r.current.saved ? ' · 当前: ' + esc(r.current.name) + ' ' + Math.round((r.current.durMs || 0) / 1000) + 's' : '');
    b.innerHTML = '<div style="opacity:.7;margin-bottom:4px">' + head + '</div>' +
      (lyrCandsData.length ? lyrCandsData.map((c, i) =>
        '<div onclick="pickCand(' + i + ')" style="cursor:pointer;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,.06)' +
        (c.current ? ';opacity:.55' : '') + '">' + esc(c.name) + ' · ' + esc(c.artist) + ' · ' + Math.round((c.durMs || 0) / 1000) + 's' +
        (c.diff != null ? ' <span style="opacity:.6">(差 ' + c.diff + 's)</span>' : '') +
        (c.current ? ' 当前' : '') + '</div>').join('')
        : '没搜到候选版本');
  } catch (e) { b.innerHTML = '搜索失败'; }
}
async function pickCand(i){
  const c = lyrCandsData[i];
  if (!c) return;
  const b = $('lyrCands');
  b.innerHTML = '正在读取这个版本的歌词…';
  try {
    const r = await (await fetch('/api/lyric/pick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: lyrSong.title, artist: lyrSong.artist, songId: c.songId, name: c.name, artistName: c.artist, durMs: c.durMs }),
    })).json();
    if (!r.ok) { b.innerHTML = esc(r.error || '这个版本没有可用歌词'); return; }
    closeCands();
    await loadLyric(lyrSong.title, lyrSong.artist, lyrAudioDur);
  } catch (e) { b.innerHTML = '保存失败'; }
}
// 「补时间轴」先展开说明卡(利/弊/当前状态), 由用户看过后再点开始, 不使用网页弹窗
function openSttPanel(){
  const t = lyrSong.title, a = lyrSong.artist;
  const body = $('sttBody'), go = $('sttGo');
  $('sttBox').style.display = 'block';
  $('sttUndo').style.display = 'none';
  const cancel = $('sttCancel');
  cancel.disabled = false; cancel.textContent = '取消';
  sttRunning = false;
  closeCands();
  if (!t) {
    go.disabled = true;
    $('sttAsr').style.display = 'none';
    body.innerHTML = '<div>现在没识别到正在播放的歌。先在网易云播放要补时间轴的那一首，再点这个按钮。</div>';
    return;
  }
  go.disabled = false;
  go.textContent = '开始补时间轴';
  const has = lyrLines.length;
  body.innerHTML =
    '<div style="font-weight:600;margin-bottom:4px">补时间轴：' + esc(t) + (a ? ' · ' + esc(a) : '') + '</div>' +
    '<div>用这首歌上传时的 B站音源，在<b>本机</b>用 whisper 重新听一遍，生成带时间戳的歌词。</div>' +
    '<div style="margin-top:6px;opacity:.9">好处</div>' +
    '<div>· 原本没有歌词、或歌词没有时间轴的歌，也能逐句滚动；<br>· 声音只在本机处理，不联网、不上传；<br>· 不改动云盘里已上传的音频。</div>' +
    '<div style="margin-top:6px;opacity:.9">代价</div>' +
    '<div>· 机器听写会有错字、漏句甚至串句，歌词文字只能当参考，结果会标「未校对」；<br>· 一首歌大约 1-2 分钟，期间请别关页面；<br>· 只能补「用本工具上传过、且上传历史里还有记录」的歌；<br>· 会替换当前' + (has ? '这 ' + has + ' 句歌词' : '歌词') + '，不想要可以再点「清除本机歌词」恢复联网歌词。</div>';
  asrRefresh();
}
function closeStt(){ const b = $('sttBox'); if (b) b.style.display = 'none'; if (asrTimer) { clearTimeout(asrTimer); asrTimer = null; } }
// 语音识别组件: 没装时在面板里给一个下载按钮, 装好后隐藏
let asrTimer = null;
function asrPaint(s){
  const box = $('sttAsr'), go = $('sttGo');
  if (!box) return;
  box.style.display = 'block';
  if (s.ready) {
    box.innerHTML = '<div style="opacity:.75">识别组件已就绪（' + (s.backend === 'cpp' ? '本机组件' : '开发环境') + '），无需再下载。</div>';
  } else if (s.installing) {
    const mb = n => (Number(n) / 1048576).toFixed(0);
    const prog = s.total ? ' ' + Math.round(Number(s.loaded) * 100 / Number(s.total)) + '%（' + mb(s.loaded) + '/' + mb(s.total) + 'MB）' : (s.loaded ? ' ' + mb(s.loaded) + 'MB' : '');
    box.innerHTML = '<div>正在' + esc(s.step || '下载') + prog + '…</div>' +
      '<div style="opacity:.75;margin-top:2px">约 150MB，只需下载一次。下载期间可以正常上传，只是暂时不能补时间轴。</div>';
  } else {
    box.innerHTML = '<div>补时间轴需要再下载一个语音识别组件（约 150MB，含中文模型）。只在本机使用，不上传声音。</div>' +
      (s.error ? '<div style="color:#ff8a80;margin-top:2px">上次安装失败：' + esc(s.error) + '</div>' : '') +
      '<div style="margin-top:6px"><button class="mini primary" onclick="asrInstall()">下载识别组件</button></div>';
  }
  if (sttRunning || !go) return;
  if (s.installing) { go.disabled = true; go.textContent = '组件下载中…'; }
  else if (!s.ready) { go.disabled = true; go.textContent = '先下载组件'; }
  else { go.disabled = false; go.textContent = '开始补时间轴'; }
}
async function asrRefresh(){
  let s = null;
  try { s = await (await fetch('/api/asr/status', { cache: 'no-store' })).json(); } catch (e) { return; }
  asrPaint(s || {});
  if (asrTimer) { clearTimeout(asrTimer); asrTimer = null; }
  if (s && s.installing) asrTimer = setTimeout(asrRefresh, 1200);
}
async function asrInstall(){
  const box = $('sttAsr');
  if (box) box.innerHTML = '<div>正在连接下载服务器…</div>';
  try {
    const r = await (await fetch('/api/asr/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!r.ok) throw new Error(r.error || '组件下载启动失败');
    asrRefresh();
  } catch (e) {
    if (box) box.innerHTML = '<div style="color:#ff8a80">✗ ' + esc(errMsg(e, '组件下载失败')) + '，请稍后重试。</div>';
  }
}
let sttRunning = false;
async function sttCancel(){
  // 识别中点「取消」= 真正停止后端进程; 空闲时只是收起面板
  if (!sttRunning) { closeStt(); return; }
  $('sttCancel').disabled = true;
  try {
    await fetch('/api/lyric/stt/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) {}
}
async function sttStart(){
  const t = lyrSong.title, a = lyrSong.artist;
  if (!t) return;
  const body = $('sttBody'), go = $('sttGo'), undo = $('sttUndo'), cancel = $('sttCancel');
  const log = [];
  const paint = () => { body.innerHTML = log.map(x => '<div>' + esc(x) + '</div>').join(''); body.scrollTop = body.scrollHeight; };
  const push = m => { log.push(m); paint(); };
  undo.style.display = 'none';
  go.disabled = true; go.textContent = '识别中…';
  sttRunning = true; cancel.disabled = false; cancel.textContent = '停止';
  body.innerHTML = ''; push('准备开始…');
  let saved = false;
  try {
    const res = await fetch('/api/lyric/stt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, artist: a }),
    });
    await readUploadStream(res, j => {
      if (j.type === 'log') push(j.msg || '');
      else if (j.type === 'canceled') push('已停止，本次结果没有保存');
      else if (j.type === 'error') push('✗ ' + (j.msg || '补时间轴失败'));
      else if (j.type === 'done') { push('✓ 已写入 ' + j.lines + ' 句（语音转写，未校对）'); saved = true; }
    });
    if (saved) {
      await loadLyric(t, a, lyrAudioDur);
      undo.style.display = '';
      go.textContent = '再补一次';
      loadLyricHistory();
    }
  } catch (e) {
    push('✗ ' + errMsg(e, '请求失败'));
  }
  sttRunning = false;
  cancel.disabled = false; cancel.textContent = '取消';
  go.disabled = false;
  if (go.textContent === '识别中…') go.textContent = '开始补时间轴';
}
async function sttUndo(){
  const t = lyrSong.title, a = lyrSong.artist;
  if (!t) return;
  const body = $('sttBody'), undo = $('sttUndo');
  body.innerHTML = '<div>正在清除本机歌词…</div>';
  try {
    const r = await (await fetch('/api/lyric/drop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, artist: a }),
    })).json();
    if (!r.ok) throw new Error(r.error || '清除失败');
    undo.style.display = 'none';
    await loadLyric(t, a, lyrAudioDur);
    body.innerHTML = '<div>已清除本机歌词，正在使用联网歌词（没有就显示没找到）。</div>';
  } catch (e) {
    body.innerHTML = '<div>✗ ' + esc(errMsg(e, '清除失败')) + '</div>';
  }
}
async function ncmDirect(btn){
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '重启中…';
  try {
    const j = await (await fetch('/api/ncm/relaunch', { method: 'POST' })).json();
    if (!j.ok) alert(j.error || '直连失败');
  } catch (e) { alert('直连失败'); }
  btn.disabled = false; btn.textContent = old;
  refreshNcmStatus();
}
// 检查网易云这次启动是否带调试参数(决定 CDP 直连能不能用)
async function refreshNcmStatus(){
  const el = $('ncmSt'); if (!el) return;
  try {
    const j = await (await fetch('/api/ncm/status')).json();
    if (!j.ncmRunning) { el.textContent = '网易云未运行'; el.style.color = ''; return; }
    if (j.launchedWithPort) {
      el.textContent = '已带调试端口' + (j.injected ? ' · 已注入' : ' · 未注入');
      el.style.color = j.injected ? '#2f9e44' : '#e8590c';
    } else {
      el.textContent = '未带调试端口';
      el.style.color = '#e8590c';
    }
  } catch (e) { el.textContent = ''; }
}
async function installBridge(btn){
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '安装中…';
  try {
    const j = await (await fetch('/api/plugin/install', { method: 'POST' })).json();
    if (j.ok) {
      btn.textContent = '已安装·重启网易云';
      setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3000);
    } else {
      btn.textContent = '安装失败'; btn.disabled = false;
      alert(j.error || '安装失败');
      setTimeout(() => { btn.textContent = old; }, 3000);
    }
  } catch (e) {
    btn.textContent = '安装失败'; btn.disabled = false;
    setTimeout(() => { btn.textContent = old; }, 3000);
  }
}
let lyrSrvPos = 0, lyrOff = 0;
function lyrPos(){
  const t = performance.now() / 1000;
  return Math.max(0, lyrAnc.paused ? lyrAnc.pos : lyrAnc.pos + (t - lyrAnc.at));
}
function setAnchor(pos){
  lyrAnc.pos = Math.max(0, pos);
  lyrAnc.at = performance.now() / 1000;
}
function fmtLyr(s){
  s = Math.max(0, Math.floor(s || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function parseLrc(txt){
  const out = [];
  for (const raw of String(txt || '').split(/\\r?\\n/)) {
    const m = raw.match(/^((?:\\[\\d+:\\d+(?:[.:]\\d+)?\\])+)(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    for (const x of m[1].matchAll(/\\[(\\d+):(\\d+(?:[.:]\\d+)?)\\]/g)) {
      out.push({ t: parseInt(x[1], 10) * 60 + parseFloat(String(x[2]).replace(':', '.')) , text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
async function lyricTick(){
  if (lyrBusy) return;
  lyrBusy = true;
  try {
    const j = await (await fetch('/api/live')).json();
    const title = j.title || '', artist = j.artist || '';
    if (!title) {
      $('lyrSub').textContent = '网易云没在放歌';
      if (lyrLines.length || lyrKey) {
        lyrKey = ''; lyrLines = []; lyrDur = 0; lyrIdx = -1;
        lyrSong = { title: '', artist: '' };
        $('lyrTitle').textContent = '实时歌词';
        $('lyrBox').innerHTML = '<div class="lyr-empty">等待播放…</div>';
        $('lyrNow').textContent = '00:00'; $('lyrDur').textContent = '00:00';
      }
      return;
    }
    const key = title + '|' + artist;
    if (key !== lyrKey) {
      lyrKey = key; lyrStatus = ''; lyrLines = []; lyrDur = 0; lyrIdx = -1; lyrWarned = false;
      lyrSong = { title, artist };
      lyrOff = 0; setAnchor(0); lyrAnc.paused = false;
      $('lyrTitle').textContent = title;
      $('lyrSub').textContent = (artist ? artist + ' · ' : '') + '正在找歌词…';
      $('lyrBox').innerHTML = '<div class="lyr-empty">正在找歌词…</div>';
      lyrAudioDur = Number(j.audioDur) || 0;
      await loadLyric(title, artist, lyrAudioDur);
    }
    // 服务端已按网易云真实播放进度(SMTC timeline)算好 pos: 前端直接跟随, 不再自己计时
    lyrSrvPos = Number(j.pos) || 0;
    setAnchor(lyrSrvPos + lyrOff);
    lyrAnc.paused = !!j.paused;
    if (j.warn) {
      $('lyrSub').textContent = (artist ? artist + ' · ' : '') + j.warn;
    } else if (lyrDur > 0 && !lyrWarned && lyrPos() > lyrDur + 5) {
      lyrWarned = true;
      $('lyrSub').textContent = (artist ? artist + ' · ' : '') + '可能不同步，点歌词或拖进度条校准';
    }
    renderLyric();
  } catch (e) {
    $('lyrSub').textContent = '读不到播放信息';
  } finally {
    lyrBusy = false;
  }
}
async function loadLyric(title, artist, audioDur){
  try {
    const j = await (await fetch('/api/lyric?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist) + '&dur=' + Math.round(Number(audioDur) || 0))).json();
    if (lyrKey !== title + '|' + artist) return;
    if (!j.ok) {
      $('lyrSub').textContent = (artist ? artist + ' · ' : '') + (j.error || '没找到歌词');
      $('lyrBox').innerHTML = '<div class="lyr-empty">这首歌没找到歌词</div>';
      return;
    }
    lyrLines = parseLrc(j.lrc);
    // 前端二次校验: 行数过少或时间轴异常时不展示, 避免把脏缓存当正常歌词
    if (lyrLines.length < 2 || lyrLines.some(l => l.t < 0 || l.t > 21600)) {
      lyrLines = []; lyrDur = 0;
      $('lyrSub').textContent = (artist ? artist + ' · ' : '') + '歌词数据异常，试试换一个版本';
      $('lyrBox').innerHTML = '<div class="lyr-empty">歌词数据异常，试试换一个版本</div>';
      return;
    }
    lyrDur = j.durMs ? j.durMs / 1000 : (lyrLines.length ? lyrLines[lyrLines.length - 1].t + 8 : 0);
    $('lyrSub').textContent = (artist ? artist + ' · ' : '') + lyrLines.length + ' 句歌词' + (j.warn ? ' · ' + j.warn : '');
    $('lyrSeek').max = String(Math.max(1, Math.round(lyrDur)));
    $('lyrDur').textContent = fmtLyr(lyrDur);
    renderLines();
  } catch (e) {}
}
function renderLines(){
  if (!lyrLines.length) return;
  $('lyrBox').innerHTML = '<div class="lyr-list" id="lyrList">' + lyrLines.map((l, i) =>
    '<div class="lyr-line" data-i="' + i + '" onclick="anchorLine(' + i + ')">' + esc(l.text) + '</div>'
  ).join('') + '</div>';
  lyrIdx = -1;
}
function renderLyric(){
  if (!lyrLines.length) return;
  const pos = lyrPos();
  let idx = -1;
  for (let i = 0; i < lyrLines.length; i++) { if (lyrLines[i].t <= pos) idx = i; else break; }
  $('lyrNow').textContent = fmtLyr(pos);
  $('lyrSeek').value = String(Math.max(0, Math.min(pos, Number($('lyrSeek').max) || pos)));
  if (idx === lyrIdx) return;
  lyrIdx = idx;
  const list = $('lyrList');
  if (!list) return;
  const els = list.children;
  for (let i = 0; i < els.length; i++) els[i].classList.toggle('cur', i === idx);
  if (idx >= 0 && els[idx]) {
    const box = $('lyrBox');
    const off = els[idx].offsetTop + els[idx].offsetHeight / 2 - box.clientHeight / 2;
    list.style.transform = 'translateY(' + (-off) + 'px)';
  }
}
function anchorLine(i){
  if (!lyrLines[i]) return;
  lyrOff = lyrLines[i].t - lyrSrvPos;
  setAnchor(lyrSrvPos + lyrOff);
  renderLyric();
}
function seekLyric(v){
  const sec = Math.max(0, Number(v) || 0);
  // 抽屉拖进度条: 直接推给服务端, 桌面歌词窗也跟着对齐
  lyrOff = 0; lyrSrvPos = sec;
  setAnchor(sec);
  renderLyric();
  if (lyrKey) {
    fetch('/api/live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seek:sec})}).catch(function(){});
  }
}
function nudgeLyric(d){
  lyrOff += d;
  setAnchor(lyrSrvPos + lyrOff);
  renderLyric();
}
function recalibrate(){
  lyrOff = 0;
  setAnchor(lyrSrvPos);
  lyrWarned = false;
  renderLyric();
}
async function calibrateLyric(btn){
  if (!lyrLines.length) { $('lyrSub').textContent = '还没有歌词，先等下播放信息'; return; }
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '校准中…';
  $('lyrSub').textContent = '正在读取网易云播放条…';
  try {
    const j = await (await fetch('/api/lyricpos')).json();
    if (j.ok && typeof j.pos === 'number') {
      setAnchor(j.pos);
      lyrWarned = false;
      renderLyric();
      $('lyrSub').textContent = '已校准到 ' + fmtLyr(j.pos);
    } else {
      $('lyrSub').textContent = j.error || '校准失败';
    }
  } catch (e) {
    $('lyrSub').textContent = '校准失败，请重试';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

async function findSources(row, btn) {
  const song = graySongs.find(s => String(s.id) === row.dataset.sid);
  if (!song) return;
  openSrc(song, row);
  const list = $('srcList');
  btn.disabled = true; btn.textContent = '搜索中';
  const kw = [song.name, song.artist].filter(Boolean).join(' ');
  try {
    if (!cloudLoaded) await loadList();
    const j = await (await fetch('/api/search?kw=' + encodeURIComponent(kw))).json();
    if (j.needLogin) {
      list.innerHTML = '<div class="cand-empty">需要先登录 B 站<button class="mini" data-act="qr">扫码登录</button></div>';
      return;
    }
    if (j.error) {
      list.innerHTML = '<div class="cand-empty">B 站搜索被临时限制<button class="mini" data-act="pop" data-kw="' + esc(kw) + '">在页面内搜 B 站</button></div>';
      return;
    }
    // 严格匹配: 时长相差不超过 3 秒且标题包含歌名, 最多 3 条候选
    const hits = (j.items || []).filter(v =>
      Math.abs(durSec(v.duration) - (song.durMs || 0) / 1000) <= 3
      && normName(v.title).indexOf(normName(song.name)) > -1).slice(0, 3);
    if (!hits.length) {
      list.innerHTML = '<div class="cand-empty">没有找到时长吻合的音源<button class="mini" data-act="pop" data-kw="' + esc(kw) + '">在页面内搜 B 站</button></div>';
      return;
    }
    list.innerHTML = hits.map(v => {
      const dup = !!cloudMatch(v.title);
      return '<div class="cand"><div class="cand-l"><div class="cand-t">' + esc(v.title)
        + (dup ? '<span class="badge ok">云盘已有</span>' : '') + '</div>'
        + '<div class="cand-m">' + esc(v.author) + ' · ' + esc(v.duration) + '</div></div>'
        + '<div class="cand-a"><button class="mini" data-act="preview" data-bv="' + esc(v.bvid) + '" data-song="' + esc(song.name) + '" data-title="' + esc(v.title) + '">试听</button>'
        + '<button class="mini ' + (dup ? '' : 'primary') + '" data-act="up" data-bv="' + esc(v.bvid) + '">'
        + (dup ? '仍要补进' : '补进云盘') + '</button>'
        + '</div></div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="cand-empty">搜索失败，请稍后再试</div>';
  } finally {
    btn.disabled = false; btn.textContent = '找音源';
  }
}
let listenBv = '', listenPage = 1;
const qPages = Object.create(null);
// 多P视频试听定位: 按搜索词匹配分P名, 匹配不到再回退第1P
function pickPreviewPage(pages, q) {
  if (!Array.isArray(pages) || pages.length <= 1) return 1;
  const nq = normName(q);
  if (!nq) return 1;
  let best = 1, bestScore = 0;
  for (const p of pages) {
    const np = normName(p.part);
    if (!np) continue;
    let score = 0;
    if (np === nq) score = 100;
    else if (np.includes(nq)) score = 80 - Math.min(40, np.length - nq.length);
    else if (nq.includes(np) && np.length >= 2) score = 60 - Math.min(40, nq.length - np.length);
    if (score > bestScore) { bestScore = score; best = p.page; }
  }
  return bestScore > 0 ? best : 1;
}
function openListen(bvid, song, title) {
  listenBv = bvid;
  listenPage = 1;
  $('listenTitle').textContent = song || title || '试听';
  $('listenSub').textContent = song ? (title || '') : '';
  $('listenSub').hidden = !$('listenSub').textContent;
  $('listenModal').hidden = false;
  lockScroll();
  const q = String(song || $('skw').value || '').trim();
  const show = pages => {
    listenPage = pickPreviewPage(pages, q);
    $('listenFrame').src = 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid)
      + '&page=' + listenPage + '&autoplay=1&danmaku=0&high_quality=1';
  };
  if (qPages[bvid]) return show(qPages[bvid]);
  // 分P信息尚未探测到: 补查一次(后端有缓存, 通常秒回)
  $('listenFrame').src = 'about:blank';
  fetch('/api/quality?bvids=' + encodeURIComponent(bvid))
    .then(r => r.json())
    .then(j => {
      const it = (j.items || [])[0];
      if (it && it.pages) qPages[bvid] = it.pages;
      show(qPages[bvid] || []);
    })
    .catch(() => show([]));
}
function closeListen() {
  $('listenModal').hidden = true;
  $('listenFrame').src = 'about:blank';
  lockScroll();
}
function openBili() {
  if (listenBv) window.open('https://www.bilibili.com/video/' + encodeURIComponent(listenBv)
    + (listenPage > 1 ? '?p=' + listenPage : ''), '_blank', 'noopener');
}
// 点击弹窗外部收起
$('listenModal').addEventListener('click', e => { if (e.target === $('listenModal')) closeListen(); });
async function fixUpload(btn, song, row) {
  if (fixRunning || !song) return;
  fixRunning = true;
  btn.disabled = true; btn.textContent = '补齐中';
  resetProgress('正在补歌');
  let ok = false;
  try {
    const res = await fetch('/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: btn.dataset.bv, allPages: false, split: false, clean: false,
        song: song.name, artist: song.artist }),
    });
    await readUploadStream(res, j => {
      if (j.type === 'done') {
        const good = (j.results || []).filter(r => r.ok).length;
        ok = good > 0;
        $('pBar').style.width = '100%';
        $('running').hidden = true; $('finished').hidden = false;
        $('pDone').innerHTML = ok ? '补歌完成<span>已加入云盘</span>' : '补歌失败<span>请查看详细日志</span>';
        if (ok) {
          if (row) {
            row.classList.add('filled');
            row.querySelector('.gq-t').insertAdjacentHTML('beforeend', '<span class="badge ok">已补</span>');
            const findBtn = row.querySelector('[data-act="find"]');
            if (findBtn) { findBtn.disabled = true; findBtn.textContent = '已补'; }
          }
          const hit = (j.results || []).find(r => r.ok);
          if (hit && hit.songId && !fixSongs.some(f => f.sid === song.id)) {
            fixSongs.push({ sid: song.id, songId: hit.songId, name: song.name, artist: song.artist, added: false, deleted: false });
            refreshFixButtons();
          }
          loadList(); loadHistory();
        }
      } else if (j.type === 'error') {
        $('running').hidden = true; $('finished').hidden = false;
        step('✗ ' + j.msg, true);
        $('pDone').innerHTML = j.needSplit
          ? '补歌失败<span>音频超过 200MB, 无法直接补入云盘</span>'
          : '补歌失败<span>' + esc(String(j.msg || '').slice(0, 60)) + '</span>';
      } else {
        step(j.msg); phaseBar(j.msg);
      }
    });
  } catch (e) {
    step('✗ ' + errMsg(e, '补歌失败'), true);
    $('running').hidden = true; $('finished').hidden = false;
    $('pDone').innerHTML = '补歌失败<span>' + esc(errMsg(e, '请稍后重试').slice(0, 60)) + '</span>';
  }
  if (ok) { btn.textContent = '已补'; } else { btn.disabled = false; btn.textContent = '补进云盘'; }
  fixRunning = false;
}
// 补完后的批量操作: 弹窗默认全选, 取消勾选即跳过
let pickMode = '', pickItems = [];
function refreshFixButtons() {
  const add = $('addLikeBtn'), del = $('delOrigBtn');
  if (add) add.classList.toggle('ready', fixSongs.some(f => !f.added));
  if (del) del.classList.toggle('ready', fixSongs.some(f => !f.deleted));
}
function openPick(mode) {
  if (!fixSongs.length) { toast('先去寻找音源吧'); return; }
  pickMode = mode;
  pickItems = fixSongs.filter(f => mode === 'add' ? !f.added : !f.deleted);
  if (!pickItems.length) {
    toast(mode === 'add' ? '这些歌已经加入过了' : '没有需要取消爱心的歌');
    return;
  }
  $('pickTitle').textContent = mode === 'add' ? '加入「我喜欢的音乐」' : '取消爱心';
  $('pickSub').textContent = mode === 'add'
    ? '下面这些歌已补进云盘，默认全部加入；取消勾选的不加入。'
    : '默认从当前歌单移出（在「我喜欢的音乐」里就是取消爱心）；取消勾选的不处理。云盘文件不受影响。';
  $('pickList').innerHTML = pickItems.map((f, i) =>
    '<label class="pick-row"><input type="checkbox" data-i="' + i + '" checked>'
    + '<span class="pick-name">' + esc(f.name) + '</span><span class="pick-artist">' + esc(f.artist) + '</span></label>').join('');
  $('pickAll').checked = true;
  $('pickYes').disabled = false;
  $('pickYes').textContent = mode === 'add' ? '确认加入' : '确认取消爱心';
  $('pickModal').hidden = false;
  lockScroll();
}
function closePick(){ $('pickModal').hidden = true; lockScroll(); }
// 检查更新: 有新版本时直接打开发布页下载, 当前是绿色版/开发版也能用
async function checkUpdate() {
  const btn = $('updBtn');
  if (!btn) return;
  const label = btn.querySelector('.guide-label');
  const old = label ? label.textContent : '';
  btn.disabled = true;
  if (label) label.textContent = '检查中…';
  try {
    const r = await fetch('/api/update/check');
    const j = await r.json();
    if (!j.ok) { toast(j.error || '暂时无法检查更新'); return; }
    if (!j.hasUpdate) { toast('已是最新版本（' + j.current + '）'); return; }
    const lines = [
      '发现新版本 v' + j.latest + '（当前 ' + j.current + '）',
      '',
      j.notes ? j.notes.slice(0, 400) : '点击确定打开下载页面。',
      j.sha256 ? 'SHA256: ' + j.sha256 : '',
    ].filter(Boolean).join(String.fromCharCode(10));
    if (j.url && confirm(lines + String.fromCharCode(10, 10) + '是否打开下载页面？')) window.open(j.url, '_blank');
  } catch (e) {
    toast('检查更新失败，请稍后再试');
  } finally {
    btn.disabled = false;
    if (label) label.textContent = old;
  }
}
// 轻提示
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}
// 统一错误文案: 网络/解析类异常转成人话, 中文错误原样展示
function errMsg(e, fallback) {
  const s = String((e && e.message) || e || '').trim();
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(s)) return '连接失败, 请确认程序还在运行。';
  if (/Unexpected token|JSON|parse/i.test(s)) return '返回的数据无法识别, 请刷新后重试。';
  if (/timeout|超时/i.test(s)) return '等待超时, 请稍后再试。';
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  return fallback || '操作失败, 请稍后重试。';
}
// 快速上手弹窗: 按当前页面显示对应教程
function openGuide(){
  const fix = curTab === 'fix', loc = curTab === 'local';
  $('guideTitle').textContent = fix ? '补歌 · 快速上手' : (loc ? '留声机 · 快速上手' : '上传 · 快速上手');
  $('guideFix').hidden = !fix;
  $('guideUp').hidden = fix || loc;
  $('guideLocal').hidden = !loc;
  $('guideModal').hidden = false;
  lockScroll();
}
function closeGuide(){ $('guideModal').hidden = true; lockScroll(); }
function togglePickAll(on){ $('pickList').querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = on; }); }
async function confirmPick() {
  const chosen = Array.from($('pickList').querySelectorAll('input[type=checkbox]'))
    .filter(c => c.checked).map(c => pickItems[+c.dataset.i]);
  if (!chosen.length) { closePick(); return; }
  const mode = pickMode, btn = $('pickYes');
  const ask = mode === 'add'
    ? '确认把选中的 ' + chosen.length + ' 首加入「我喜欢的音乐」？'
    : '确认从当前歌单移出 ' + chosen.length + ' 首（取消爱心）？云盘文件不受影响。';
  if (!window.confirm(ask)) return;
  btn.disabled = true; btn.textContent = '处理中';
  try {
    const body = mode === 'add'
      ? { op: 'add', ids: chosen.map(f => f.songId) }
      : { op: 'del', pid: Number(scanPid), ids: chosen.map(f => f.sid) };
    const j = await (await fetch('/api/playlist/tracks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (!j.ok) throw new Error(j.error || '操作失败');
    if (mode === 'add') {
      chosen.forEach(f => { f.added = true; });
      chosen.forEach(f => {
        const t = document.querySelector('.gq[data-sid="' + f.sid + '"] .gq-t');
        if (t && !t.querySelector('.badge.ok')) t.insertAdjacentHTML('beforeend', '<span class="badge ok">已加入</span>');
      });
    } else {
      chosen.forEach(f => { f.deleted = true; deletedSids.add(f.sid); });
      renderFix();
    }
    closePick(); refreshFixButtons(); loadList();
  } catch (e) {
    btn.disabled = false; btn.textContent = mode === 'add' ? '确认加入' : '确认取消爱心';
    alert('操作失败: ' + errMsg(e, '请稍后重试'));
  }
}
$('grayList').addEventListener('click', e => {
  const p = e.target.closest('button[data-pick]');
  if (p) { openPick(p.dataset.pick); return; }
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'find') findSources(b.closest('.gq'), b);
});
$('srcModal').addEventListener('click', e => {
  if (e.target === $('srcModal')) { closeSrc(); return; }
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'preview') openListen(b.dataset.bv, b.dataset.song || '', b.dataset.title || '');
  else if (act === 'up') fixUpload(b, srcSong, srcRow);
  else if (act === 'qr') { closeSrc(); showQr('bili'); }
  else if (act === 'pop') { closeSrc(); popSearch(b.dataset.kw); }
});
// 搜索结果: 音乐=B站视频, 播客=苹果播客节目与单集
let searchItems = [], searchMode = '', appleShows = [], appleEps = [], appleShowName = '';
function normName(s){
  let out = '';
  for (const ch of String(s || '').toLowerCase()) {
    const c = ch.codePointAt(0);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) out += ch;
  }
  return out;
}
function cloudMatch(title) {
  const t = normName(title);
  if (!t) return null;
  return cloudSongs.find(s => {
    const n = normName(s.name);
    if (!n) return false;
    if (n === t) return true;
    // 仅当云盘歌名足够长且占了标题的大部分时才算同一首, 避免 Live/Remix 版被误判
    return n.length >= 5 && t.indexOf(n) > -1 && n.length / t.length >= 0.5;
  }) || null;
}
function refreshSearchDup() {
  if (searchMode === 'ep') {
    appleEps = appleEps.map(v => Object.assign({}, v, { cloud: !!cloudMatch(v.name) }));
  } else if (searchMode === 'bili') {
    searchItems = searchItems.map(v => Object.assign({}, v, { cloud: !!cloudMatch(v.title) }));
  }
  renderSearch();
}
function renderSearch() {
  if (searchMode === 'show' || searchMode === 'ep') return searchMode === 'show' ? renderShows() : renderEps();
  const box = $('sres');
  const total = searchItems.length;
  const dup = searchItems.filter(v => v.cloud).length;
  const list = searchItems.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || (b.play || 0) - (a.play || 0));
  setSplit(true);
  const head = '<div class="sr-head"><span>找到 ' + total + ' 首' + (dup ? ' · 云盘已有 ' + dup + ' 首' : '') + '</span></div>';
  if (!list.length) {
    box.innerHTML = head + '<div class="empty">' + (total ? '这些歌云盘里都已经有了' : '没有找到相关内容')
      + '<br><button class="mini" data-act="pop">在页面内搜B站</button></div>';
    return;
  }
  box.innerHTML = head + list.map(v =>
    '<div class="sr"><div class="sr-l"><div class="sr-t">' + esc(v.title)
    + (v.label ? '<span class="qtag ' + (v.tier || 'q64') + '" title="' + esc(v.detail || '') + '">' + esc(v.label) + '</span>' : '')
    + (v.cloud ? '<span class="badge">云盘已有</span>' : '') + '</div>'
    + '<div class="sr-m">' + esc(v.author) + ' · ' + esc(v.duration) + ' · ' + fmtPlay(v.play) + '次播放</div></div>'
    + '<div class="sr-a"><button class="mini" data-act="preview" data-bv="' + esc(v.bvid) + '" data-title="' + esc(v.title) + '">试听</button>'
    + '<button class="mini' + (v.cloud ? '' : ' primary') + '" data-act="upload" data-bv="' + esc(v.bvid) + '">'
    + (v.cloud ? '仍要上传' : '上传') + '</button>'
    + '</div></div>'
  ).join('');
}
function renderShows() {
  const box = $('sres');
  setSplit(true);
  const head = '<div class="sr-head"><span>找到 ' + appleShows.length + ' 个节目</span></div>';
  if (!appleShows.length) { box.innerHTML = head + '<div class="empty">没有找到相关节目，换个关键词试试</div>'; return; }
  box.innerHTML = head + appleShows.map(s =>
    '<div class="sr"><div class="sr-l"><div class="sr-t">' + esc(s.name) + '</div>'
    + '<div class="sr-m">' + esc(s.artist || '未知主播') + (s.count ? ' · ' + s.count + ' 集' : '') + '</div></div>'
    + '<div class="sr-a"><button class="mini primary" data-act="show" data-id="' + esc(s.collectionId) + '" data-name="' + esc(s.name) + '">看单集</button></div></div>'
  ).join('');
}
function renderEps() {
  const box = $('sres');
  setSplit(true);
  const head = '<div class="sr-head"><span>' + esc(appleShowName || '节目') + ' · ' + appleEps.length + ' 集</span>'
    + '<div class="sr-btns"><button class="mini" data-act="backshow">返回节目</button></div></div>';
  if (!appleEps.length) { box.innerHTML = head + '<div class="empty">这个节目暂时没有公开音频的单集</div>'; return; }
  box.innerHTML = head + appleEps.map(v =>
    '<div class="sr"><div class="sr-l"><div class="sr-t">' + esc(v.name) + (v.cloud ? '<span class="badge">云盘已有</span>' : '') + '</div>'
    + '<div class="sr-m">' + esc(v.show) + (v.durationMs ? ' · ' + fmtDur(v.durationMs) : '') + '</div></div>'
    + '<div class="sr-a"><button class="mini' + (v.cloud ? '' : ' primary') + '" data-act="epup" data-link="' + esc(v.link) + '">'
    + (v.cloud ? '仍要上传' : '上传') + '</button></div></div>'
  ).join('');
}
async function doSearch() {
  if (curType === 'music') return doBiliSearch();
  return doAppleSearch($('skw').value.trim());
}
async function doBiliSearch() {
  const kw = $('skw').value.trim();
  if (!kw) { $('skw').focus(); return; }
  const box = $('sres');
  box.hidden = false;
  $('searchHint').hidden = true;
  searchMode = 'bili';
  if (!biliLogged) { showBiliLoginPrompt(box); return; }
  box.innerHTML = '<div class="empty">搜索并检测音质中…</div>';
  try {
    if (!cloudLoaded) await loadList();
    const j = await (await fetch('/api/search?kw=' + encodeURIComponent(kw))).json();
    if (j.needLogin) { showBiliLoginPrompt(box); return; }
    if (j.error) { searchItems = []; box.innerHTML = '<div class="empty">B站登录可能已过期 <button class="mini" data-act="qr">扫码登录B站</button> <button class="mini" data-act="pop">在页面内搜B站</button></div>'; return; }
    const items = j.items || [];
    // 先补齐音质与分P信息, 再一次性渲染; 保证结果出来时就带音质标签, 也可直接按音质排序
    let qmap = {};
    if (items.length) {
      try {
        const qj = await (await fetch('/api/quality?bvids=' + encodeURIComponent(items.map(v => v.bvid).join(',')))).json();
        (qj.items || []).forEach(q => {
          qmap[q.bvid] = q;
          if (q.pages) qPages[q.bvid] = q.pages;
        });
      } catch (e) { /* 音质探测失败不影响搜索 */ }
    }
    searchItems = items.map(v => {
      const q = qmap[v.bvid] || {};
      return Object.assign({}, v, {
        cloud: !!cloudMatch(v.title),
        label: q.label, tier: q.tier, score: q.score, detail: q.detail,
      });
    });
    renderSearch();
  } catch (e) {
    searchItems = [];
    box.innerHTML = '<div class="empty">搜索失败, 请稍后再试 <button class="mini" data-act="pop">在页面内搜B站</button></div>';
  }
}
async function doAppleSearch(kw) {
  if (!kw) { $('skw').focus(); return; }
  const box = $('sres');
  box.hidden = false;
  $('searchHint').hidden = true;
  searchMode = 'show';
  box.innerHTML = '<div class="empty">搜索中...</div>';
  try {
    if (!cloudLoaded) await loadList();
    const j = await (await fetch('/api/podcast/search?kw=' + encodeURIComponent(kw))).json();
    if (j.error) { appleShows = []; box.innerHTML = '<div class="empty">' + esc(j.error) + '</div>'; return; }
    appleShows = j.items || [];
    renderShows();
  } catch (e) {
    appleShows = [];
    box.innerHTML = '<div class="empty">搜索失败, 请稍后再试</div>';
  }
}
async function openAppleShow(id, name) {
  const box = $('sres');
  box.hidden = false;
  $('searchHint').hidden = true;
  appleShowName = name;
  searchMode = 'ep';
  box.innerHTML = '<div class="empty">正在读取单集...</div>';
  try {
    if (!cloudLoaded) await loadList();
    const j = await (await fetch('/api/podcast/episodes?id=' + encodeURIComponent(id))).json();
    if (j.error) throw new Error(j.error);
    appleEps = (j.items || []).map(v => Object.assign({}, v, { cloud: !!cloudMatch(v.name) }));
    renderEps();
  } catch (e) {
    appleEps = [];
    box.innerHTML = '<div class="empty">' + esc(errMsg(e, '单集读取失败')) + '<br><button class="mini" data-act="backshow">返回节目</button></div>';
  }
}
function showBiliLoginPrompt(box) {
  searchItems = [];
  searchMode = 'bili';
  $('searchHint').hidden = true;
  setSplit(true);
  box.innerHTML = '<div class="empty">搜索需要先登录B站<br><button class="mini" data-act="qr">扫码登录B站</button> <button class="mini" data-act="pop">在页面内搜B站</button></div>';
}
// 搜索结果按钮统一用事件委托, 避免内联引号在模板字符串中被提前转义
$('sres').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'preview') openListen(b.dataset.bv, '', b.dataset.title || '');
  else if (act === 'upload') uploadBV(b.dataset.bv);
  else if (act === 'show') openAppleShow(b.dataset.id, b.dataset.name);
  else if (act === 'backshow') renderShows();
  else if (act === 'epup') { $('input').value = b.dataset.link; doUpload(); }
  else if (act === 'qr') showQr('bili');
  else if (act === 'pop') popSearch();
});
function fmtPlay(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
// 左右对照: 有搜索结果时把搜索框与音乐云盘并排, 同时查看已有哪些歌
function setSplit(on) {
  $('compare').classList.toggle('split', on);
  document.querySelector('main').classList.toggle('split', on);
}
// 内嵌B站搜索: 覆盖在本页内, 无需切换窗口; 找到视频复制链接回来粘贴即可
let bpKw = '';
function popSearch(kw) {
  bpKw = kw !== undefined ? String(kw) : $('skw').value.trim();
  $('bpTitle').textContent = bpKw ? 'B站搜索 · ' + bpKw : 'B站搜索';
  $('bpFrame').src = 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(bpKw);
  $('biliPanel').hidden = false;
  lockScroll();
}
function reloadBiliSearch() {
  $('bpFrame').src = 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(bpKw);
}
function closeBiliPanel() {
  if ($('biliPanel').hidden) return;
  $('biliPanel').hidden = true;
  $('bpFrame').src = 'about:blank';
  lockScroll();
  $('skw').focus();
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('guideModal').hidden) closeGuide();
  else if (!$('coverModal').hidden) cancelCoverPick();
  else if (!$('listenModal').hidden) closeListen();
  else if (!$('srcModal').hidden) closeSrc();
  else if (!$('lyricModal').hidden) closeLyric();
  else if (!$('pickModal').hidden) closePick();
  else if (!$('favModal').hidden) closeFav();
  else if (!$('splitModal').hidden) closeSplit();
  else if (!$('accountModal').hidden) closeAccount();
  else if (!$('biliPanel').hidden) closeBiliPanel();
});
$('skw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
// 从任意文本里提取 B站/小宇宙/苹果播客链接、音频直链与裸 BV 号(分享文案、多行文本都适用)
function extractLinks(text) {
  const s = String(text || '');
  const urls = (s.match(/https?:\\/\\/[^\\s,，;；]+/g) || [])
    .map(u => u.replace(/[\\)\\]】。.,，]+$/, ''))
    .filter(u => /b23\\.tv|bilibili\\.com|xiaoyuzhoufm\\.com|podcasts\\.apple\\.com|\\.(mp3|m4a|aac|flac|ogg|wav)(\\?|$)/i.test(u));
  const inUrl = new Set();
  for (const u of urls) for (const b of (u.match(/BV[0-9A-Za-z]{10}/g) || [])) inUrl.add(b.toLowerCase());
  const bvs = (s.match(/\\bBV[0-9A-Za-z]{10}\\b/g) || []).filter(b => !inUrl.has(b.toLowerCase()));
  const seen = new Set(), out = [];
  for (const x of [...urls, ...bvs]) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(x);
  }
  return out;
}
function splitInput(v) {
  return String(v || '').split(/[,，\\r\\n]+/).map(s => s.trim()).filter(Boolean);
}
// 粘贴板: 读取剪贴板 → 识别链接 → 去重后按逗号追加到输入框
async function pasteClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); }
  catch (e) {
    alert('浏览器不允许直接读取剪贴板，请在输入框里按 Ctrl+V 手动粘贴');
    return;
  }
  const found = extractLinks(text);
  if (!found.length) { alert('剪贴板里没有找到 B 站链接、BV 号、播客单集或音频直链'); return; }
  const merged = [...new Set([...splitInput($('input').value), ...found])];
  $('input').value = merged.join(', ');
  $('input').focus();
}
// ---------- 上传封面选择 ----------
let coverItems = [], coverChoice = null, coverResolver = null, uploadCover = null;
function cancelCoverPick() {
  const r = coverResolver; coverResolver = null;
  $('coverModal').hidden = true; lockScroll();
  if (r) r(undefined);
}
function skipCoverPick() {
  const r = coverResolver; coverResolver = null;
  $('coverModal').hidden = true; lockScroll();
  if (r) r(null);
}
function confirmCoverPick() {
  if (!coverChoice) return;
  const r = coverResolver; coverResolver = null;
  $('coverModal').hidden = true; lockScroll();
  if (r) r(coverChoice);
}
function paintCoverGrid(items) {
  coverItems = items;
  $('coverGrid').innerHTML = items.map((x, i) =>
    '<div class="cover-item" data-i="' + i + '"><img src="' + esc(x.proxy) + '" loading="lazy" alt="" onerror="this.parentNode.hidden=true">'
    + '<span class="cover-tag">' + esc(x.source) + '</span></div>').join('');
}
function selectCover(i) {
  coverChoice = coverItems[i] ? { url: coverItems[i].url } : null;
  $('coverCustom').hidden = true;
  [...$('coverGrid').querySelectorAll('.cover-item')].forEach((el, idx) => el.classList.toggle('sel', idx === i));
  $('coverYes').disabled = !coverChoice;
}
function selectCustomCover(dataUrl, name) {
  coverChoice = { dataUrl };
  [...$('coverGrid').querySelectorAll('.cover-item')].forEach(el => el.classList.remove('sel'));
  $('coverCustom').hidden = false;
  $('coverCustomImg').src = dataUrl;
  $('coverCustomName').textContent = name || '本地图片';
  $('coverYes').disabled = false;
}
function askCover(title, pic, artist) {
  return new Promise(resolve => {
    coverResolver = resolve;
    coverItems = []; coverChoice = null;
    $('coverYes').disabled = true;
    $('coverCustom').hidden = true;
    $('coverTitle').textContent = title ? '「' + title + '」选封面' : '选择封面';
    $('coverSub').textContent = pic ? '可以用当前音源的封面，也可以在本地选一张。' : '可以自己上传一张，或者直接不用封面。';
    if (!pic) {
      $('coverGrid').innerHTML = '<div class="cover-empty">这首歌没有自带封面，点下方的「本地上传图片」选一张，或直接不用封面。</div>';
      $('coverModal').hidden = false; lockScroll();
      return;
    }
    $('coverGrid').innerHTML = '<div class="cover-empty">正在读取封面...</div>';
    $('coverModal').hidden = false; lockScroll();
    fetch('/api/cover/search?pic=' + encodeURIComponent(pic))
      .then(r => r.json()).then(j => {
        if (!coverResolver) return;
        const items = (j && j.items) || [];
        if (!items.length) {
          $('coverGrid').innerHTML = '<div class="cover-empty">没有读到封面，可以点「本地上传图片」，或者直接不用封面。</div>';
          return;
        }
        paintCoverGrid(items);
        selectCover(0);
      }).catch(() => {
        if (coverResolver) $('coverGrid').innerHTML = '<div class="cover-empty">读取封面失败，可以本地上传图片。</div>';
      });
  });
}
$('coverGrid').addEventListener('click', e => {
  const it = e.target.closest('.cover-item'); if (!it) return;
  selectCover(+it.dataset.i);
});
$('coverFile').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!/^image\\/(jpeg|png)$/.test(f.type)) { alert('只支持 JPG / PNG 图片'); return; }
  if (f.size > 5 * 1024 * 1024) { alert('图片请小于 5MB'); return; }
  const rd = new FileReader();
  rd.onload = () => selectCustomCover(rd.result, f.name);
  rd.readAsDataURL(f);
});

// ---------- 留声机: 本地音频上传 ----------
let localFile = null;
const LOCAL_EXTS = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'wav'];
function setLocalFile(f) {
  if (!f) return;
  const ext = f.name.toLowerCase().split('.').pop();
  if (!LOCAL_EXTS.includes(ext)) { alert('只支持 MP3 / M4A / FLAC / AAC / OGG / WAV 音频'); return; }
  if (f.size > 200 * 1024 * 1024) { alert('文件超过 200MB，请先压缩或切分'); return; }
  localFile = f;
  $('localName').textContent = f.name;
  $('localHint').textContent = (f.size / 1048576).toFixed(1) + 'MB · 已就绪';
}
$('localFile').addEventListener('change', e => setLocalFile(e.target.files && e.target.files[0]));
['dragenter', 'dragover'].forEach(ev => $('localDrop').addEventListener(ev, e => { e.preventDefault(); $('localDrop').classList.add('on'); }));
['dragleave', 'drop'].forEach(ev => $('localDrop').addEventListener(ev, e => { e.preventDefault(); $('localDrop').classList.remove('on'); }));
$('localDrop').addEventListener('drop', e => setLocalFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));

// 离线识别组件：没装时在这里直接提示体积并一键下载
async function asrStatusReq() {
  try { return await (await fetch('/api/asr/status', { cache: 'no-store' })).json(); } catch (e) { return null; }
}
async function ensureAsrReady() {
  let st = await asrStatusReq();
  if (!st || !st.ok) { step('✗ 无法查询离线组件状态', true); return false; }
  if (st.ready) { step('离线组件已就绪'); return true; }
  if (!st.installing) {
    const yes = confirm('补歌词需要下载离线语音识别组件：约 150MB（含中文模型）。\\n\\n只在本机使用，不上传声音；下载一次后可离线使用。\\n\\n现在下载吗？');
    if (!yes) return false;
    try {
      const r = await (await fetch('/api/asr/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).json();
      if (!r.ok) throw new Error(r.error || '组件下载启动失败');
    } catch (e) {
      step('✗ ' + errMsg(e, '组件下载启动失败'), true);
      return false;
    }
  }
  let last = '', lastAt = 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 1200));
    st = await asrStatusReq();
    if (!st) { step('✗ 组件状态查询失败', true); return false; }
    if (st.ready) { step('离线组件已就绪'); return true; }
    if (!st.installing) { step('✗ 组件下载失败：' + (st.error || '未知原因'), true); return false; }
    const mb = n => Math.round(Number(n || 0) / 1048576);
    const prog = st.total ? Math.round(Number(st.loaded) * 100 / Number(st.total)) + '%（' + mb(st.loaded) + '/' + mb(st.total) + 'MB）' : (st.loaded ? mb(st.loaded) + 'MB' : '');
    const label = (st.step || '下载识别组件') + (prog ? ' ' + prog : '');
    if (label !== last || Date.now() - lastAt > 5000) {
      last = label; lastAt = Date.now();
      step(label + '…');
    }
  }
}
async function doLocalLyric(title, artist) {
  let saved = false;
  try {
    const res = await fetch('/api/lyric/stt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist }),
    });
    await readUploadStream(res, j => {
      if (j.type === 'log') step(j.msg || '');
      else if (j.type === 'done') saved = true;
      else if (j.type === 'error') step('✗ 补歌词失败：' + (j.msg || '请稍后重试'), true);
    });
  } catch (e) {
    step('✗ 补歌词失败：' + errMsg(e, '请稍后重试'), true);
  }
  if (saved) loadLyricHistory();
  return saved;
}
async function doLocalUpload() {
  if (!localFile) { $('localFile').click(); return; }
  const nm = localFile.name;
  const ext = nm.toLowerCase().split('.').pop();
  let wantLyric = $('localLyric').checked;
  if (wantLyric && (ext === 'm4a' || ext === 'aac')) {
    alert('M4A / AAC 暂不支持离线补歌词，本次只上传音频；需要歌词可先转成 MP3 或 FLAC。');
    wantLyric = false; $('localLyric').checked = false;
  }
  const dot = nm.lastIndexOf('.');
  const base = dot > 0 ? nm.slice(0, dot) : nm;
  const title = $('localSong').value.trim() || base;
  const artist = $('localArtist').value.trim();
  const picked = await askCover(title, '', artist);
  if (picked === undefined) return;
  const btn = $('localGo');
  btn.disabled = true; btn.textContent = '上传中';
  if (wantLyric) {
    resetProgress('正在检查离线歌词组件');
    step('补歌词需要离线识别组件（约 150MB，只在本机使用）');
    const ok = await ensureAsrReady();
    if (!ok) {
      wantLyric = false; $('localLyric').checked = false;
      step('已跳过补歌词，继续上传音频');
    }
  }
  resetProgress('正在上传本地音频');
  let done = null, lyricSaved = false;
  const finish = (main, sub) => {
    $('pBar').style.width = '100%';
    $('running').hidden = true; $('finished').hidden = false;
    $('pDone').innerHTML = esc(main) + '<span>' + esc(sub) + '</span>';
    loadList(); loadHistory();
  };
  try {
    let token = '';
    if (picked && picked.dataUrl) {
      step('正在准备封面...');
      const cr = await fetch('/api/local/cover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover: { dataUrl: picked.dataUrl } }),
      });
      const cj = await cr.json();
      if (!cj.ok) throw new Error(cj.error || '封面准备失败');
      token = cj.token;
    }
    const qs = '?name=' + encodeURIComponent(nm)
      + '&song=' + encodeURIComponent($('localSong').value.trim())
      + '&artist=' + encodeURIComponent(artist)
      + '&album=' + encodeURIComponent($('localAlbum').value.trim())
      + '&token=' + encodeURIComponent(token);
    const res = await fetch('/api/local/upload' + qs, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: localFile,
    });
    await readUploadStream(res, j => {
      if (j.type === 'done') {
        done = j;
        if (!wantLyric) finish('上传完成', '已加入云盘');
      } else if (j.type === 'error') {
        $('running').hidden = true; $('finished').hidden = false;
        step('✗ ' + j.msg, true);
        $('pDone').innerHTML = '上传失败<span>请查看错误信息</span>';
      } else {
        step(j.msg); phaseBar(j.msg);
      }
    });
    if (done && wantLyric) {
      $('pBar').style.width = '100%';
      step('音频已入库, 开始离线识别歌词(可能要 1-2 分钟, 请不要关闭页面)');
      lyricSaved = await doLocalLyric(title, artist);
      finish('上传完成', lyricSaved ? '已加入云盘 · 歌词已补充（未校对）' : '已加入云盘 · 歌词未补上，可稍后在云盘里重试');
    }
  } catch (e) {
    step('✗ ' + errMsg(e, '上传失败'), true);
    $('running').hidden = true; $('finished').hidden = false;
    $('pDone').innerHTML = '上传失败<span>' + esc(errMsg(e, '请稍后重试').slice(0, 80)) + '</span>';
  }
  btn.disabled = false; btn.textContent = '上传到云盘';
}

async function doUpload(split, skipCover) {
  const input = $('input').value.trim();
  if (!input) { $('input').focus(); return; }
  if (!skipCover) {
    uploadCover = null;
    const tokens = input.split(/[\\n,，、]+/).map(s => s.trim()).filter(Boolean);
    if (tokens.length === 1) {
      let title = $('song').value.trim(), pic = '', artist = $('artist').value.trim();
      try {
        const j = await (await fetch('/api/cover/meta?input=' + encodeURIComponent(tokens[0]))).json();
        if (j.ok) { title = title || j.title || ''; pic = j.pic || ''; artist = artist || j.artist || ''; }
      } catch (e) {}
      const picked = await askCover(title, pic, artist);
      if (picked === undefined) return;
      uploadCover = picked;
    }
  }
  split = split === true;
  const btn = $('go');
  btn.disabled = true; btn.textContent = '上传中';
  resetProgress(split ? '正在拆分上传' : '正在上传');
  saveForm();
  try {
    const res = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ input, type: curType, allPages: true, split, season: $('season').checked,
        clean: $('clean').checked, song: $('song').value.trim(), artist: $('artist').value.trim(),
        cover: uploadCover }) });
    await readUploadStream(res, j => {
      if (j.type === 'done') {
        const ok = j.results.filter(r => r.ok).length;
        const fails = j.results.filter(r => !r.ok);
        $('pBar').style.width = '100%';
        fails.forEach(f => step('✗ ' + f.song + ': ' + f.error, true));
        $('running').hidden = true; $('finished').hidden = false;
        $('pDone').innerHTML = '上传完成<span>成功 ' + ok + ' / ' + j.results.length + (fails.length ? ', 失败明细见上方' : ', 已加入云盘') + '</span>';
        loadList(); loadHistory();
      } else if (j.type === 'error') {
        $('running').hidden = true; $('finished').hidden = false;
        if (j.needSplit) {
          step('文件超过 200MB, 等待确认是否拆分', true);
          $('pDone').innerHTML = '需要确认<span>文件超过 200MB</span>';
          if (!split) openSplit(j.needSplit);
          else step('✗ 拆分后仍无法上传: ' + j.msg, true);
        } else {
          step('✗ ' + j.msg, true);
          $('pDone').innerHTML = '上传失败<span>请查看错误信息</span>';
        }
      } else {
        step(j.msg); phaseBar(j.msg);
        const m = j.msg.match(/\\[(\\d+)\\/(\\d+)\\]/);
        if (m) {
          lastTotal = +m[2];
          setBar(+m[1], +m[2]);
          $('pTitle').textContent = j.msg.replace(/===\\s*\\[.*?\\]\\s*/, '').replace(/\\s*===\\s*$/, '');
        }
      }
    });
  } catch (e) {
    step('✗ ' + errMsg(e, '上传失败'), true);
    $('running').hidden = true; $('finished').hidden = false;
    $('pDone').innerHTML = '上传失败<span>' + esc(errMsg(e, '请稍后重试').slice(0, 80)) + '</span>';
  }
  btn.disabled = false; btn.textContent = '上传';
}
restoreForm(); loadStatus(); loadList(); loadHistory(); loadLyricHistory();
try {
  const savedTab = localStorage.getItem('GraySongICU.tab') || 'fix';
  const savedType = localStorage.getItem('GraySongICU.type');
  curType = savedType === 'pod' ? 'pod' : 'music';
  switchTab(savedTab === 'local' ? 'local' : (savedTab === 'fix' ? 'fix' : 'up'));
  switchType(curType);
} catch (e) { switchTab('fix'); }
</script>
</body>
</html>`;

// ---------- 桌面歌词浮窗页面 (Electron 加载, 透明背景, 仅显示字幕) ----------
const DLYRIC_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>GraySongICU 桌面歌词</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden;user-select:none}
  body{--lc:#ffffff;font:14px/1.5 "PingFang SC","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;color:#fff}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 26px 2px;box-sizing:border-box;-webkit-app-region:no-drag}
  .songrow{position:relative;display:flex;align-items:center;gap:6px;min-width:0}
  .song{flex:0 1 auto;min-width:0;font-size:13px;font-weight:500;color:rgba(255,255,255,.6);text-shadow:0 1px 4px rgba(0,0,0,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.6px}
  .lyrsrc{flex:0 0 auto;font-size:9px;line-height:1;letter-spacing:.5px;padding:2px 5px;border-radius:6px;border:1px solid rgba(255,255,255,.22);color:rgba(255,255,255,.55);text-shadow:none;white-space:nowrap}
  .lyrsrc[data-src="bilibili"]{border-color:rgba(251,114,153,.5);color:rgba(251,160,185,.85)}
  .lyrsrc[data-src="netease"]{border-color:rgba(236,65,65,.5);color:rgba(255,130,130,.9)}
  .lyrsrc[data-src="whisper"]{border-color:rgba(255,255,255,.2);color:rgba(255,255,255,.5)}
  .song,.cur,.next{-webkit-app-region:no-drag}
  .cur{margin-top:6px;line-height:1.32;letter-spacing:.2px;color:var(--lc);word-break:break-word;text-wrap:balance}
  @keyframes lyricSwap{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  .cur.swap{animation:lyricSwap .26s cubic-bezier(.22,.61,.36,1)}
  .cur.dim{font-size:16px!important;font-weight:400;color:rgba(255,255,255,.72);text-shadow:0 1px 6px rgba(0,0,0,.9)}
  .next{margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:26px;transition:opacity .2s}
  body.s-classic .cur{font-size:calc(34px * var(--fs,1));font-weight:700;text-shadow:0 2px 10px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.95)}
  body.s-classic .next{font-size:calc(19px * var(--fs,1));color:rgba(255,255,255,.7);text-shadow:0 1px 8px rgba(0,0,0,.9)}
  body.s-neon .cur{font-size:calc(34px * var(--fs,1));font-weight:800;letter-spacing:.5px;text-shadow:0 0 6px var(--lc),0 0 22px var(--lc),0 2px 12px rgba(0,0,0,.9)}
  body.s-neon .next{font-size:calc(19px * var(--fs,1));color:var(--lc);opacity:.55;text-shadow:0 0 10px var(--lc)}
  body.s-minimal .cur{font-size:calc(32px * var(--fs,1));font-weight:400;letter-spacing:1px;text-shadow:0 1px 8px rgba(0,0,0,.78)}
  body.s-minimal .next{display:none}
  body.s-custom .cur{font-size:calc(34px * var(--fs,1));font-weight:600;text-shadow:0 2px 14px rgba(0,0,0,.92)}
  body.s-custom .next{font-size:calc(19px * var(--fs,1));color:var(--lc);opacity:.6}
  .bar{position:absolute;top:-3px;left:0;z-index:99;display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:6px;width:300px;max-width:100%;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s;-webkit-app-region:no-drag}
  .bar.on{opacity:1;visibility:visible;pointer-events:auto}

  body.locked .bar{display:none}
  .bar button[hidden],.bar select[hidden]{display:none}
  .sw{display:inline-flex;align-items:center;gap:4px}
  .sw i{width:14px;height:14px;border-radius:50%;border:1px solid rgba(255,255,255,.35);cursor:pointer;display:inline-block;box-sizing:border-box}
  .sw i.on{box-shadow:0 0 0 2px rgba(236,65,65,.95)}
  body.s-custom.w400 .cur{font-weight:400}
  body.s-custom.w700 .cur{font-weight:700}
  body.s-custom.w800 .cur{font-weight:800;letter-spacing:.6px}
  body.s-custom.o-none .cur{text-shadow:0 2px 8px rgba(0,0,0,.5)}
  body.s-custom.o-soft .cur{text-shadow:0 2px 10px rgba(0,0,0,.9),0 0 2px rgba(0,0,0,.6)}
  body.s-custom.o-strong .cur{text-shadow:0 2px 10px rgba(0,0,0,.95),0 0 4px #000,0 0 2px #000}
  body.s-custom.hide-next .next{display:none}
  .lockhint{position:fixed;top:8px;right:12px;z-index:98;width:28px;height:26px;padding:0;color:rgba(255,255,255,.78);background:rgba(20,20,24,.55);border:1px solid rgba(255,255,255,.16);border-radius:9px;display:none;align-items:center;justify-content:center;cursor:pointer;font-family:inherit;-webkit-app-region:no-drag}
  body.locked .lockhint{display:inline-flex}
  .bar button,.bar select{background:rgba(20,20,24,.55);border:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.8);border-radius:9px;font-family:inherit;outline:none;cursor:pointer;-webkit-app-region:no-drag}
  .bar .qbtn{width:28px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;transition:transform .12s,border-color .12s}
  .bar .qbtn.txt{font-size:10px;font-weight:600;letter-spacing:.3px}
  .bar .qbtn:hover{transform:translateY(-1px)}
  .bar button:hover,.bar select:hover,.lockhint:hover{border-color:#ec4141;color:#ec4141}
  .bar select{height:26px;padding:0 3px 0 6px;font-size:11px;border-radius:9px}
  #style{width:72px}#cw{width:54px}#co{width:68px}#cn{width:80px}
  .bar .panel{position:absolute;top:calc(100% + 4px);bottom:auto;left:0;display:flex;align-items:center;gap:5px;width:300px;justify-content:center;padding:4px 5px;background:rgba(20,20,24,.55);border:1px solid rgba(255,255,255,.18);border-radius:10px;box-sizing:border-box}
  .bar.pabove .panel{top:auto;bottom:calc(100% + 4px)}
  .bar .panel[hidden]{display:none}
  .bar .panel .sw{flex:0 0 auto;display:flex;align-items:center;gap:4px}
  .bar .sw i{width:20px;height:20px;flex:0 0 auto}
  .bar svg,.lockhint svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
  .song,.cur,.next{cursor:grab}
  body.dragging .song,body.dragging .cur,body.dragging .next{cursor:grabbing}
</style>
</head>
<body>
<div class="bar">
  <button id="styleBtn" class="qbtn" type="button" title="歌词样式"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
  <button id="colorBtn" class="qbtn" type="button" title="歌词颜色"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2c3.4 3.9 6 6.9 6 9.8a6 6 0 1 1-12 0c0-2.9 2.6-5.9 6-9.8z"/></svg></button>
  <button id="minus" class="qbtn txt" type="button" title="歌词进度 -1 秒">−1s</button>
  <button id="plus" class="qbtn txt" type="button" title="歌词进度 +1 秒">+1s</button>
  <button id="fdown" class="qbtn txt" type="button" title="字号变小">A−</button>
  <button id="fup" class="qbtn txt" type="button" title="字号变大">A+</button>
  <button id="lock" class="qbtn" type="button" title="锁定歌词"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.6"/><path d="M8 10.5V7.8a4 4 0 0 1 7.9-1.3"/></svg></button>
  <button id="close" class="qbtn" type="button" title="关闭桌面歌词"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
  <div class="panel" id="stylePanel" hidden>
    <select id="style" title="歌词样式">
      <option value="classic">经典</option>
      <option value="neon">霓虹</option>
      <option value="minimal">极简</option>
      <option value="custom">自定义</option>
    </select>
    <select id="cw" hidden title="字重">
      <option value="400">常规</option><option value="700">加粗</option><option value="800">特粗</option>
    </select>
    <select id="co" hidden title="描边">
      <option value="none">无描边</option><option value="soft">柔和</option><option value="strong">强描边</option>
    </select>
    <select id="cn" hidden title="下一句">
      <option value="1">显示下句</option><option value="0">只看本句</option>
    </select>
  </div>
  <div class="panel" id="colorPanel" hidden>
    <span class="sw" id="sw"></span>
  </div>
</div>
<button class="lockhint" id="lockhint" type="button" title="解锁歌词"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.6"/><path d="M8 10.5V7.5a4 4 0 1 1 8 0v3"/></svg></button>
<div class="wrap">
  <div class="songrow"><div class="song" id="song">正在连接网易云…</div><span class="lyrsrc" id="lyrsrc" hidden></span></div>
  <div class="cur dim" id="cur">等待播放…</div>
  <div class="next" id="next"></div>
</div>
<script>
(function(){
  var elSong=document.getElementById('song'),elCur=document.getElementById('cur'),elNext=document.getElementById('next'),elSrc=document.getElementById('lyrsrc');
  var basePos=0,baseAt=0,playing=false,lines=[],busy=false,lastIdx=-2,scale=1;
  try{ scale=parseFloat(localStorage.getItem('graysongicu.lyric.scale')||'1')||1; }catch(e){}
  scale=Math.min(1.8,Math.max(0.7,scale));
  function applyScale(){ document.documentElement.style.setProperty('--fs', String(scale)); }
  function paintSrc(src,verify){
    var txt=src==='bilibili'?'B站字幕':src==='netease'?'网易云':src==='whisper'?'本地转写':'';
    if(!txt){ elSrc.hidden=true; elSrc.textContent=''; placeBar(); return; }
    elSrc.hidden=false;
    elSrc.textContent=txt;
    elSrc.dataset.src=src;
    elSrc.title=src==='bilibili'?('B站字幕'+(verify==='none'?' · 未校对':'')):src==='netease'?'网易云歌词':'本地语音转写 · 未校对';
    placeBar();
  }
  function saveScale(){ try{ localStorage.setItem('graysongicu.lyric.scale',String(scale)); }catch(e){} }
  applyScale();
  var styleSel=document.getElementById('style');
  var cwSel=document.getElementById('cw'),coSel=document.getElementById('co'),cnSel=document.getElementById('cn'),swBox=document.getElementById('sw');
  var stylePanel=document.getElementById('stylePanel'),colorPanel=document.getElementById('colorPanel');
  var style='classic',lcolor='#ffffff',cw='700',co='soft',cn='1';
  var SWATCHES=['#ffffff','#ffe9a8','#ffd166','#ffb4c0','#ff8fa3','#ff6b6b','#ec4141','#b388ff','#7bdff2','#4dd0e1','#b8f2a0','#cfd8dc'];
  try{
    style=localStorage.getItem('graysongicu.lyric.style')||'classic';
    lcolor=localStorage.getItem('graysongicu.lyric.color')||'#ffffff';
    cw=localStorage.getItem('graysongicu.lyric.w')||'700';
    co=localStorage.getItem('graysongicu.lyric.o')||'soft';
    cn=localStorage.getItem('graysongicu.lyric.n')||'1';
  }catch(e){}
  var STYLES=['s-classic','s-neon','s-minimal','s-custom'];
  function markSw(){
    var dots=swBox.children;
    for(var i=0;i<dots.length;i++){ dots[i].className = (dots[i].getAttribute('data-c')===lcolor.toLowerCase())?'on':''; }
  }
  SWATCHES.forEach(function(c){
    var d=document.createElement('i');
    d.style.background=c; d.setAttribute('data-c',c); d.title=c;
    d.onclick=function(){ setColor(c); colorPanel.hidden=true; };
    swBox.appendChild(d);
  });
  function applyTheme(){
    STYLES.forEach(function(cl){ document.body.classList.remove(cl); });
    document.body.classList.add('s-'+style);
    ['w400','w700','w800'].forEach(function(cl){ document.body.classList.remove(cl); });
    document.body.classList.add('w'+cw);
    ['o-none','o-soft','o-strong'].forEach(function(cl){ document.body.classList.remove(cl); });
    document.body.classList.add('o-'+co);
    document.body.classList.toggle('hide-next', cn==='0');
    document.body.style.setProperty('--lc',lcolor);
    styleSel.value=style;
    cwSel.value=cw; coSel.value=co; cnSel.value=cn;
    var showCustom=(style==='custom');
    cwSel.hidden=!showCustom; coSel.hidden=!showCustom; cnSel.hidden=!showCustom;
    markSw();
  }
  function setColor(c){
    lcolor=c;
    try{ localStorage.setItem('graysongicu.lyric.color',lcolor); }catch(e){}
    document.body.style.setProperty('--lc',lcolor);
    markSw();
  }
  styleSel.onchange=function(){
    style=styleSel.value;
    try{ localStorage.setItem('graysongicu.lyric.style',style); }catch(e){}
    applyTheme();
  };
  cwSel.onchange=function(){ cw=cwSel.value; try{ localStorage.setItem('graysongicu.lyric.w',cw); }catch(e){} applyTheme(); };
  coSel.onchange=function(){ co=coSel.value; try{ localStorage.setItem('graysongicu.lyric.o',co); }catch(e){} applyTheme(); };
  cnSel.onchange=function(){ cn=cnSel.value; try{ localStorage.setItem('graysongicu.lyric.n',cn); }catch(e){} applyTheme(); };
  applyTheme();
  // 样式/颜色面板默认收起, 点图标才展开; 两个面板同时只开一个
  document.getElementById('styleBtn').onclick=function(){
    stylePanel.hidden=!stylePanel.hidden;
    if(!stylePanel.hidden) colorPanel.hidden=true;
  };
  document.getElementById('colorBtn').onclick=function(){
    colorPanel.hidden=!colorPanel.hidden;
    if(!colorPanel.hidden) stylePanel.hidden=true;
  };
  var lockBtn=document.getElementById('lock'), hintBtn=document.getElementById('lockhint'), barEl=document.querySelector('.bar'), songRow=document.querySelector('.songrow');
  // 工具条嵌到歌名行, 紧跟在音源标签后面; 绝对定位不挤占歌名
  if(barEl&&songRow) songRow.appendChild(barEl);
  function placeBar(){
    if(!barEl||!songRow) return;
    var row=songRow.getBoundingClientRect();
    var anchor=(elSrc&&!elSrc.hidden?elSrc:elSong).getBoundingClientRect();
    var x=Math.round(anchor.right-row.left+8);
    var max=Math.round(row.width-(barEl.offsetWidth||300)-2);
    barEl.style.left=Math.min(Math.max(0,x),Math.max(0,max))+'px';
    // 上方空间不够时, 面板改为向下展开
    barEl.classList.toggle('pabove', Math.round(row.top)-37>=0);
  }
  placeBar();
  var isLocked=false, lastIgnore=null, lastX=0, lastY=0, rectCache=[], rectAt=0, dragging=false, barTimer=null;
  function canIPC(){ return !!(window.GrayIPC && window.GrayIPC.setIgnore); }
  function setIgnore(v){ if(lastIgnore===v) return; lastIgnore=v; if(canIPC()) window.GrayIPC.setIgnore(v); }
  function textRects(){
    if(Date.now()-rectAt<600) return rectCache;
    rectAt=Date.now(); var out=[];
    [elSong,elCur,elNext].forEach(function(el){
      if(!el||!el.firstChild) return;
      var rg=document.createRange(); rg.selectNodeContents(el);
      var rs=rg.getClientRects();
      for(var i=0;i<rs.length;i++){ if(rs[i].width>1&&rs[i].height>1) out.push(rs[i]); }
    });
    rectCache=out; return out;
  }
  function inR(x,y,r){ return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; }
  function boxHot(el,x,y){
    if(!el) return false;
    var r=el.getBoundingClientRect();
    return r.width>1&&r.height>1&&inR(x,y,r);
  }
  // 工具条展开时整块算"热区", 避免面板/色点缝隙穿透
  function barHot(x,y){
    if(!barEl||!barEl.classList.contains('on')) return false;
    if(boxHot(barEl,x,y)) return true;
    var ps=barEl.querySelectorAll('.panel');
    for(var i=0;i<ps.length;i++){
      if(ps[i].hidden) continue;
      var r=ps[i].getBoundingClientRect();
      if(r.width>1&&r.height>1&&inR(x,y,r)) return true;
    }
    return false;
  }
  function textHot(x,y){
    var rs=textRects();
    for(var i=0;i<rs.length;i++){ if(inR(x,y,rs[i])) return true; }
    return false;
  }
  function isHot(x,y){
    if(isLocked) return boxHot(hintBtn,x,y);
    // 歌词文字也可直接拖动, 所以文字矩形同样作为热区
    return barHot(x,y)||textHot(x,y);
  }
  function showBar(){
    if(barTimer){ clearTimeout(barTimer); barTimer=null; }
    if(barEl){ placeBar(); barEl.classList.add('on'); }
  }
  function scheduleHideBar(){
    if(barTimer||!barEl) return;
    barTimer=setTimeout(function(){
      barTimer=null;
      if(barEl) barEl.classList.remove('on');
      stylePanel.hidden=true; colorPanel.hidden=true;
    },3000);
  }
  document.addEventListener('mousemove', function(e){
    if(!canIPC()) return;
    lastX=e.clientX; lastY=e.clientY;
    if(dragPending){
      // 按住歌词后移动超过阈值才算拖动, 避免轻轻一点就整窗乱跑
      if(Math.abs(e.clientX-dragPending.x)+Math.abs(e.clientY-dragPending.y)>4){
        dragPending=null; startDrag();
      }
      return;
    }
    if(dragging) return;
    var hot=isHot(lastX,lastY);
    setIgnore(!hot);
    if(hot) showBar(); else scheduleHideBar();
  });
  // 鼠标离开窗口时也要开始 3 秒倒计时, 否则工具条会一直挂在那里
  document.addEventListener('mouseleave', function(){
    dragPending=null;
    if(dragging) return;
    setIgnore(true);
    scheduleHideBar();
  });
  function startDrag(){
    if(dragging||isLocked) return;
    if(!(window.GrayIPC&&window.GrayIPC.dragStart)) return;
    dragging=true;
    document.body.classList.add('dragging');
    setIgnore(false);
    window.GrayIPC.dragStart();
  }
  function endDrag(){
    dragPending=null;
    if(!dragging) return;
    dragging=false;
    document.body.classList.remove('dragging');
    if(window.GrayIPC&&window.GrayIPC.dragEnd) window.GrayIPC.dragEnd();
    var hot=isHot(lastX,lastY);
    setIgnore(!hot);
    if(hot) showBar(); else scheduleHideBar();
  }
  var dragPending=null;
  document.addEventListener('mousedown', function(e){
    if(isLocked||dragging||e.button!==0) return;
    if(!(window.GrayIPC&&window.GrayIPC.dragStart)) return;
    if(!textHot(e.clientX,e.clientY)) return;
    dragPending={x:e.clientX,y:e.clientY};
    e.preventDefault();
  });
  document.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
  if(window.GrayIPC){
    lockBtn.onclick=function(){ window.GrayIPC.setLock(true); };
    hintBtn.onclick=function(){ window.GrayIPC.setLock(false); };
    window.GrayIPC.onLockState(function(v){
      isLocked=!!v;
      document.body.classList.toggle('locked',isLocked);
      rectAt=0;
      setIgnore(isLocked?true:!isHot(lastX,lastY));
    });
    setIgnore(true);
    window.__lyrDbg=function(x,y){return {ignore:lastIgnore,hot:isHot(x,y),locked:isLocked};};
  } else {
    lockBtn.style.display='none';
    hintBtn.style.display='none';
  }
  document.getElementById('fdown').onclick=function(){ scale=Math.max(0.7,scale-0.1); applyScale(); saveScale(); };
  document.getElementById('fup').onclick=function(){ scale=Math.min(1.8,scale+0.1); applyScale(); saveScale(); };
  document.getElementById('minus').onclick=function(){ nudge(-1); };
  document.getElementById('plus').onclick=function(){ nudge(1); };
  document.getElementById('close').onclick=function(){ window.close(); };
  function nudge(v){
    fetch('/api/live',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nudge:v})}).then(poll);
  }
  function swapText(el,txt){
    if(el.textContent===txt) return;
    el.textContent=txt;
    el.classList.remove('swap');
    void el.offsetWidth;
    el.classList.add('swap');
  }
  function setLine(cur,next,empty){
    if(elCur.textContent!==cur) swapText(elCur,cur);
    elCur.classList.toggle('dim',!!empty);
    if(elNext.textContent!==next) elNext.textContent=next;
    lastIdx=-2;
  }
  function curPos(){ return playing? basePos+(performance.now()/1000-baseAt):basePos; }
  function render(){
    if(!lines.length) return;
    var p=curPos(),idx=-1;
    for(var i=0;i<lines.length;i++){ if(lines[i].t<=p) idx=i; else break; }
    if(idx===lastIdx) return;
    lastIdx=idx;
    if(idx<0){
      // 前奏/刚换歌/暂停在开头: 展示第一句, 不要只显示一个省略号让人以为没歌词
      // 播放中淡色表示"还没唱到"; 暂停时按正常颜色, 因为用户就是要看当前这句
      var f=lines[0]?lines[0].text:'';
      var n2=lines[1]?lines[1].text:'';
      if(elCur.textContent!==f) swapText(elCur,f);
      elCur.classList.toggle('dim', !!playing);
      if(elNext.textContent!==n2) elNext.textContent=n2;
      return;
    }
    var nxt=(idx+1<lines.length)?lines[idx+1].text:'';
    if(elCur.textContent!==lines[idx].text){ swapText(elCur,lines[idx].text); elCur.classList.remove('dim'); }
    if(elNext.textContent!==nxt) elNext.textContent=nxt;
  }
  function poll(){
    if(busy) return; busy=true;
    fetch('/api/live').then(function(r){return r.json();}).then(function(j){
      busy=false;
      if(!j||!j.ok) return;
      lines=(j.lines||[]).filter(function(l){ return l && typeof l.t==='number' && l.t>=0 && l.t<=21600 && l.text; });
      basePos=j.pos||0; baseAt=performance.now()/1000; playing=!!j.playing;
      if(!j.title){ setLine('等待播放…','',true); elSong.textContent='网易云没在放歌'; paintSrc('',''); return; }
      elSong.textContent=j.title+(j.artist?' · '+j.artist:'');
      paintSrc(j.src,j.verify);
      if(!lines.length){ setLine(j.error?j.error:'正在找歌词…','',true); paintSrc('',''); return; }
      lastIdx=-2; render();
    }).catch(function(){ busy=false; });
  }
  setInterval(poll,400);
  setInterval(render,100);
  poll();
})();
</script>
</body>
</html>`;

// ---------- B站搜索 (wbi签名, 供页面搜索与后续灰色解锁复用) ----------
const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = { key: null, ts: 0 };
async function wbiKey() {
  if (wbiCache.key && Date.now() - wbiCache.ts < 3600e3) return wbiCache.key;
  const j = await getJSON('https://api.bilibili.com/x/web-interface/nav', {});
  const img = (j.data && j.data.wbi_img) || {};
  const i1 = (img.img_url || '').match(/([0-9a-f]+)\.png/), i2 = (img.sub_url || '').match(/([0-9a-f]+)\.png/);
  const raw = (i1 ? i1[1] : '') + (i2 ? i2[1] : '');
  if (raw.length < 32) throw new Error('搜索初始化失败');
  wbiCache = { key: WBI_TAB.map(i => raw[i]).join('').slice(0, 32), ts: Date.now() };
  return wbiCache.key;
}
function wbiSign(params, key) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const qs = Object.keys(p).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))).join('&');
  return qs + '&w_rid=' + crypto.createHash('md5').update(qs + key).digest('hex');
}
async function biliSearch(kw) {
  const H = await biliHeaders();
  // 无cookie时补一个随机设备号, 避免搜索接口风控(-412)
  if (!H.Cookie) H.Cookie = 'buvid3=' + crypto.randomUUID().toUpperCase() + 'infoc';
  const key = await wbiKey();
  const j = await getJSON('https://api.bilibili.com/x/web-interface/wbi/search/type?' + wbiSign({
    search_type: 'video', keyword: kw, page: 1, page_size: 20, order: 'totalrank',
  }, key), H);
  if (j.code !== 0) throw new Error('搜索失败: ' + (j.message || j.code));
  // v_voucher = B站风控挑战(无登录cookie时常见), 视为不可用, 前端降级到小窗模式
  if (j.data && j.data.v_voucher && !(j.data.result || []).length) throw new Error('B站搜索被临时限制');
  return ((j.data || {}).result || []).filter(v => v.bvid).map(v => ({
    bvid: v.bvid,
    title: String(v.title || '').replace(/<[^>]+>/g, ''),
    author: v.author || '',
    duration: v.duration || '',
    play: v.play || 0,
  }));
}
// 音质探测: 搜索结果按 bvid 懒加载, 读取 dash 音频流实际码率; 会话内缓存避免重复请求
const Q_CACHE = new Map();
const Q_TIERS = {
  30251: ['Hi-Res', 'hires', 95],
  30280: ['192K', 'q192', 85],
  30232: ['132K', 'q132', 70],
  30216: ['64K', 'q64', 50],
};
function qualityLabel(a) {
  const t = Q_TIERS[a.id];
  const kbps = Math.round(a.bandwidth / 1000);
  const detail = '实测 ' + kbps + ' kbps';
  if (t) return { label: t[0], tier: t[1], score: t[2], detail };
  return { label: kbps + 'K', tier: kbps >= 128 ? 'q132' : 'q64', score: kbps >= 128 ? 65 : 50, detail };
}
async function biliQuality(bvid) {
  if (Q_CACHE.has(bvid)) return Q_CACHE.get(bvid);
  const H = await biliHeaders();
  const view = await getJSON('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), H, 15000);
  if (view.code !== 0) throw new Error(view.message || '视频信息获取失败');
  const cid = view.data && view.data.cid;
  if (!cid) throw new Error('缺少 cid');
  const pj = await getJSON('https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid)
    + '&cid=' + cid + '&fnval=16&fnver=0&qn=0', H, 15000);
  if (pj.code !== 0 || !pj.data || !pj.data.dash) throw new Error(pj.message || '无音频流');
  // 30250=杜比全景声, 云盘不支持, 不参与音质评价
  const audios = (pj.data.dash.audio || []).filter(a => a.id !== 30250).sort((a, b) => b.bandwidth - a.bandwidth);
  if (!audios.length) throw new Error('无音频流');
  const out = {
    ...qualityLabel(audios[0]),
    // 附带分P列表, 前端试听时用来定位到正确的分P (多P/合集视频默认page=1会播错歌)
    pages: (view.data.pages || []).map(p => ({ page: p.page, part: p.part || '', duration: p.duration || 0 })),
  };
  if (Q_CACHE.size > 300) Q_CACHE.clear();
  Q_CACHE.set(bvid, out);
  return out;
}
// 并发限制 3, 避免一次搜索打出几十个请求触发 B站风控
async function biliQualityBatch(bvids) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < bvids.length) {
      const bvid = bvids[i++];
      try { out.push({ bvid, ...(await biliQuality(bvid)) }); }
      catch (e) { out.push({ bvid, error: true }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, bvids.length) }, worker));
  return out;
}

// ---------- 二维码本地生成 (byte模式, ECC M/L, 版本1-6, 掩码0; 登录链接不出本机) ----------
// [版本, 数据块数, 每块数据码字, 每块纠错码字, 纠错等级(0=M,1=L)]
const QR_VERS = [
  [1, 1, 16, 10, 0], [1, 1, 19, 7, 1],
  [2, 1, 28, 16, 0], [2, 1, 34, 10, 1],
  [3, 1, 44, 26, 0], [3, 1, 55, 15, 1],
  [4, 2, 32, 18, 0], [4, 1, 80, 20, 1],
  [5, 2, 43, 24, 0], [5, 1, 108, 26, 1],
  [6, 4, 27, 16, 0], [6, 2, 68, 18, 1],
];
const qrGf = (() => {
  const e = new Uint8Array(512), l = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { e[i] = x; l[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) e[i] = e[i - 255];
  return { e, l };
})();
const qrMul = (a, b) => (a && b) ? qrGf.e[qrGf.l[a] + qrGf.l[b]] : 0;
function qrRsGen(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= qrMul(g[j], qrGf.e[i]); }
    g = ng;
  }
  return g;
}
function qrRsEcc(data, g) {
  const res = new Array(g.length - 1).fill(0);
  for (const b of data) {
    const f = b ^ res[0];
    res.shift(); res.push(0);
    if (f) for (let i = 0; i < g.length - 1; i++) res[i] ^= qrMul(g[i + 1], f);
  }
  return res;
}
function qrMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const spec = QR_VERS.find(v => (4 + 8 + bytes.length * 8) <= v[1] * v[2] * 8);
  if (!spec) throw new Error('内容过长');
  const [ver, nblk, dPer, ePer, eccLevel] = spec;
  const maxBits = nblk * dPer * 8;
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let i = 0; bits.length < maxBits; i++) push(i % 2 ? 0x11 : 0xec, 8);
  const dataCW = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; dataCW.push(b); }
  const g = qrRsGen(ePer);
  const blocks = [], eccs = [];
  for (let i = 0; i < nblk; i++) { const d = dataCW.slice(i * dPer, (i + 1) * dPer); blocks.push(d); eccs.push(qrRsEcc(d, g)); }
  const cw = [];
  for (let i = 0; i < dPer; i++) for (const b of blocks) cw.push(b[i]);
  for (let i = 0; i < ePer; i++) for (const e of eccs) cw.push(e[i]);
  const n = 17 + 4 * ver;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
      set(rr, cc, (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  if (ver >= 2) {
    const cs = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] }[ver];
    for (const r of cs) for (const c of cs) {
      if (fn[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  set(n - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!fn[8][n - 1 - i]) set(8, n - 1 - i, false); if (!fn[n - 1 - i][8]) set(n - 1 - i, 8, false); }
  // 格式信息: 纠错等级(2bit)+掩码0(3bit) 经BCH(15,5)编码后异或0x5412
  const fdata = eccLevel << 3;
  let frem = fdata << 10;
  for (let i = 4; i >= 0; i--) if (frem & (1 << (i + 10))) frem ^= 0x537 << i;
  const fmt = ((fdata << 10) | frem) ^ 0x5412;
  const fbit = i => !!((fmt >> i) & 1);
  // 格式信息第一副本(左上): 位0-5竖排, 位6-8拐角, 位9-14横排
  for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
  set(7, 8, fbit(6)); set(8, 8, fbit(7)); set(8, 7, fbit(8));
  for (let i = 9; i <= 14; i++) set(8, 14 - i, fbit(i));
  // 格式信息第二副本: 位0-7右下横排, 位8-14左下竖排
  for (let i = 0; i <= 7; i++) set(8, n - 1 - i, fbit(i));
  for (let i = 8; i <= 14; i++) set(n - 15 + i, 8, fbit(i));
  const all = [];
  for (const b of cw) for (let k = 7; k >= 0; k--) all.push((b >> k) & 1);
  let bi = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const r = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fn[r][c]) {
          let dark = bi < all.length ? !!all[bi] : false;
          bi++;
          if ((r + c) % 2 === 0) dark = !dark;
          m[r][c] = dark;
        }
      }
    }
  }
  return m;
}
function qrSvg(text) {
  const m = qrMatrix(text);
  const n = m.length, q = 4;
  let cells = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) cells += `<rect x="${c + q}" y="${r + q}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
}

// ---------- 扫码登录 (B站: passport qrcode; 网易云: eapi unikey) ----------
async function biliQrCreate() {
  const j = await getJSON('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', await biliHeaders());
  if (j.code !== 0 || !(j.data || {}).qrcode_key) throw new Error('获取登录码失败: ' + (j.message || j.code));
  return { text: j.data.url, key: j.data.qrcode_key };
}
async function biliQrPoll(key) {
  const r = await req('GET', 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), await biliHeaders());
  const j = JSON.parse(r.text);
  const code = j.data && j.data.code;
  if (code === 0) {
    const cookie = (r.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    if (!/SESSDATA=/.test(cookie)) throw new Error('登录成功但未取得凭证, 请重试');
    await saveCookie('bili', cookie);
    return { state: 'done' };
  }
  return { state: code === 86090 ? 'scanned' : code === 86038 ? 'expired' : 'wait' };
}
async function ncmQrCreate() {
  const r = await weapiRaw('/api/login/qrcode/unikey', { type: 1 });
  if (r.json.code !== 200 || !r.json.unikey) throw new Error('获取登录码失败: ' + (r.json.message || r.json.code));
  // 二维码内容必须是官网登录 URL, 只放裸 unikey 时 App 扫码会提示「暂不支持该类型」
  return { text: 'https://music.163.com/login?codekey=' + r.json.unikey, key: r.json.unikey };
}
async function ncmQrPoll(key) {
  const r = await weapiRaw('/api/login/qrcode/client/login', { key, type: 1 });
  const c = r.json.code;
  if (c === 803) {
    // 803时凭证在响应体cookie字段, 部分情况下在Set-Cookie
    const cookie = r.json.cookie || r.setCookie.map(s => s.split(';')[0]).join('; ');
    if (!/MUSIC_U=[^;\s]+/.test(cookie)) throw new Error('登录成功但未取得凭证, 请重试');
    await saveCookie('ncm', cookie);
    return { state: 'done' };
  }
  return { state: c === 802 ? 'scanned' : c === 800 ? 'expired' : 'wait' };
}

// ---------- 服务器 ----------
// 只接受本机同源请求: 阻止恶意网页跨站调用、DNS rebinding, 同时限制请求体上限
function localRequestGate(rq, url) {
  const host = String(rq.headers.host || '');
  if (host !== HOST + ':' + PORT && host !== 'localhost:' + PORT) return 403;
  if (String(rq.headers['sec-fetch-site'] || '') === 'cross-site') return 403;
  const origin = String(rq.headers.origin || '');
  if (origin && (origin !== 'http://' + HOST + ':' + PORT && origin !== 'http://localhost:' + PORT)) return 403;
  // /api/push 是开发期本机脚本联调用的, 不带凭据; 其余接口必须带本次启动的凭据
  if (url.startsWith('/api/') && url !== '/api/push' && !hasApiToken(rq)) return 401;
  const len = Number(rq.headers['content-length'] || 0);
  const cap = (rq.url || '').split('?')[0] === '/api/local/upload' ? 210 * 1024 * 1024 : 8 * 1024 * 1024;
  if (len > cap) return 413;
  return 0;
}
// ---------- 检查更新 ----------
// 默认读 GitHub Release; 也可用 GRAYSONGICU_UPDATE_URL 指向自建 latest.json
// latest.json 格式: { "version": "1.1.0", "url": "https://.../GraySongICU-Setup-1.1.0.exe", "sha256": "...", "notes": "..." }
const GITHUB_REPO = 'lussey820/bili2ncm';
const APP_VERSION = process.env.GRAYSONGICU_VERSION || '';
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => Number(n) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
async function checkUpdate() {
  let latest = '', url = '', notes = '', sha256 = '', published = '';
  const custom = process.env.GRAYSONGICU_UPDATE_URL || '';
  if (custom) {
    const j = await getJSON(custom, { 'User-Agent': UA }, 15000);
    latest = String(j.version || '');
    url = String(j.url || '');
    notes = String(j.notes || '');
    sha256 = String(j.sha256 || '');
    published = String(j.published || '');
    if (!latest || !url) throw new Error('更新清单格式不正确, 需要 version 和 url');
  } else {
    const headers = { 'User-Agent': 'GraySongICU', 'Accept': 'application/vnd.github+json' };
    const j = await getJSON('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest', headers, 15000);
    if (!j.tag_name) throw new Error('还没有公开发布版本, 暂时无法检查更新');
    latest = String(j.tag_name).replace(/^v/i, '');
    notes = String(j.body || '').trim().slice(0, 600);
    published = String(j.published_at || '');
    const assets = j.assets || [];
    const pick = assets.find(a => /\.exe$/i.test(a.name)) || assets.find(a => /\.zip$/i.test(a.name)) || assets[0];
    if (pick) {
      url = String(pick.browser_download_url || '');
      const dg = String(pick.digest || '');
      if (/^sha256:/i.test(dg)) sha256 = dg.slice(7);
    }
  }
  if (!latest) throw new Error('更新信息里没有版本号');
  const hasUpdate = !!APP_VERSION && cmpVer(latest, APP_VERSION) > 0;
  return { current: APP_VERSION || '开发版', latest, hasUpdate, url, notes, sha256, published };
}
function handleRequest(rq, rs) {
  const url = rq.url.split('?')[0];
  const deny = localRequestGate(rq, url);
  if (deny) {
    rs.writeHead(deny, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return rs.end(deny === 413 ? '请求内容过大' : deny === 401 ? 'unauthorized' : 'forbidden');
  }
  if (rq.method === 'GET' && url === '/') {
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': AUTH_COOKIE });
    return rs.end(PAGE);
  }
  if (rq.method === 'GET' && url === '/api/status') {
    withTimeout(ncmAccount(), 30000, '登录态检测超时(30秒)')
      .then(ncm => {
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ncm, bili: /SESSDATA/.test(readBiliCookie()) }));
      }).catch(e => {
        logError('status', e);
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ncm: { ok: false, timeout: /检测超时/.test(e.message), error: friendlyError(e) }, bili: /SESSDATA/.test(readBiliCookie()) }));
      });
    return;
  }
  if (rq.method === 'GET' && url === '/api/update/check') {
    checkUpdate().then(j => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(JSON.stringify({ ok: true, ...j }));
    }).catch(e => {
      logError('update', e);
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(JSON.stringify({ ok: false, error: friendlyError(e) }));
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/qr/svg') {
    try {
      const text = new URL(rq.url, 'http://x').searchParams.get('text') || '';
      rs.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(qrSvg(text));
    } catch (e) {
      logError('qr', e);
      rs.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      rs.end('二维码生成失败, 请刷新重试。');
    }
    return;
  }
  for (const kind of ['bili', 'ncm']) {
    if (rq.method === 'GET' && url === '/api/qr/' + kind + '/create') {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      (async () => {
        try {
          const j = await (kind === 'bili' ? biliQrCreate() : ncmQrCreate());
          rs.end(JSON.stringify({ ok: true, text: j.text, key: j.key }));
        } catch (e) { fail(rs, e); }
      })();
      return;
    }
    if (rq.method === 'GET' && url === '/api/qr/' + kind + '/poll') {
      const key = new URL(rq.url, 'http://x').searchParams.get('key') || '';
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      (async () => {
        try {
          rs.end(JSON.stringify(await (kind === 'bili' ? biliQrPoll(key) : ncmQrPoll(key))));
        } catch (e) {
          logError('qr', e);
          rs.end(JSON.stringify({ state: 'error', error: friendlyError(e) }));
        }
      })();
      return;
    }
  }
  if (rq.method === 'POST' && url === '/api/cookie') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      try {
        const { kind, value } = JSON.parse(body);
        const raw = String(value || '').trim();
        if (kind === 'ncm') {
          const cookie = raw.match(/MUSIC_U\s*=\s*([0-9A-Fa-f]{16,})/) ? raw : 'MUSIC_U=' + raw;
          await saveCookie('ncm', cookie);
        } else {
          await saveCookie('bili', raw);
        }
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ok: true }));
      } catch (e) {
        fail(rs, e);
      }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/list') {
    cloudList().then(j => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify(j));
    }).catch(e => {
      fail(rs, e, { count: 0, size: 0, songs: [] });
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/history') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    rs.end(JSON.stringify({ items: readHistory().slice(0, 50) }));
    return;
  }
  if (rq.method === 'DELETE' && url === '/api/history') {
    try {
      fs.writeFileSync(HISTORY_FILE, '[]');
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ok: true }));
    } catch (e) {
      fail(rs, e);
    }
    return;
  }
  if (rq.method === 'GET' && url === '/api/lyric/history') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify({ items: readLyricHistory().slice(0, 50) }));
    return;
  }
  if (rq.method === 'DELETE' && url === '/api/lyric/history') {
    try {
      fs.writeFileSync(LYRIC_HISTORY_FILE, '[]');
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ok: true }));
    } catch (e) {
      fail(rs, e);
    }
    return;
  }
  if (rq.method === 'GET' && url === '/api/playlists') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    (async () => {
      try { rs.end(JSON.stringify({ playlists: await ncmPlaylists() })); }
      catch (e) { fail(rs, e, { playlists: [] }); }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/side') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    (async () => {
      try { rs.end(JSON.stringify(await ncmSide())); }
      catch (e) { fail(rs, e, { liked: [], rec: [] }); }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/nowplaying') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    ensureSmWatcher();
    // 统一走 liveTickState: 暂停/桥接停推时也要保留冻结进度, 不能退回只剩窗口标题的假播放状态
    const s = liveTickState();
    rs.end(JSON.stringify({
      playing: s.playing, title: s.title, artist: s.artist,
      status: s.playing ? 'Playing' : 'Paused',
      src: pushFresh() ? (pushState.src || 'plugin') : (smState.src || 'none'),
      pos: s.pos, dur: s.audioDur || s.dur,
      ncmId: pushState ? pushState.ncmId : 0,
    }));
    return;
  }
  if (url === '/api/push' && (rq.method === 'POST' || rq.method === 'OPTIONS')) {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' });
    if (rq.method === 'OPTIONS') return rs.end('{}');
    let body = '';
    rq.on('data', d => { body += d; if (body.length > 20000) { try { rq.destroy(); } catch (e) {} } });
    rq.on('end', () => {
      try {
        const o = JSON.parse(body || '{}');
        const pos = Number(o.pos), dur = Number(o.dur), t = Number(o.t);
        const playing = o.status === 'Playing';
        const srcTag = String(o.src || 'plugin');
        if (srcTag !== 'cdp' && cdpFresh()) { rs.end('{"ok":true,"ignored":1}'); return; }
        if (srcTag === 'cdp') cdpLastPushAt = Date.now();
        const nowSec = Date.now() / 1000;
        const nTitle = String(o.title || ''), nArtist = String(o.artist || '');
        // 暂停/切歌瞬间桥接偶尔会推一条空歌名, 如果照单全收会把当前曲目清空,
        // 表现就是歌词窗闪一下"等待播放"再跳回第一句, 这里直接忽略
        if (!nTitle) { rs.end('{"ok":true,"ignored":1}'); return; }
        const nPos = Number.isFinite(pos) && pos >= 0 ? pos : -1;
        const prev = pushState;
        const sameTrack = !!prev && sameTrackKey(nTitle, nArtist, prev.title, prev.artist);
        let monoPos, monoAt;
        if (!sameTrack) {
          // 换歌: 锚点从这次上报的位置重新开始
          monoPos = Math.max(0, nPos);
          monoAt = nowSec;
        } else {
          const prevMono = prev.monoPos != null ? prev.monoPos : prev.pos;
          const prevAt = prev.monoAt != null ? prev.monoAt : prev.posAt;
          // 插件上报的 pos 有时是失真的(进度事件没触发时会一直停在一个旧值, 甚至归零),
          // 所以用"本地估算 + 只接受不倒退的上报"来保证暂停时停在当前这句, 而不是跳回第一句
          const estNow = prev.status === 'Paused' ? prevMono : prevMono + Math.max(0, nowSec - (prevAt || nowSec));
          if (!playing) {
            // 暂停: 把位置冻结在暂停那一刻的估算值, 不接受可能失真的 pos
            if (prev.status === 'Paused') { monoPos = prevMono; monoAt = prevAt; }
            else { monoPos = estNow; monoAt = nowSec; }
          } else if (nPos >= 0 && nPos >= estNow - 1.5) {
            // 正常前进或向前跳转: 以新值为锚点
            monoPos = nPos; monoAt = nowSec;
          } else {
            // 明显落后(或上报为 0): 视为失效数据, 继续用本地时钟
            monoPos = prevMono; monoAt = prevAt;
          }
        }
        pushState = {
          playing,
          title: nTitle,
          artist: nArtist,
          monoPos, monoAt, lastPushed: nPos,
          album: String(o.album || ''),
          ncmId: Number(o.ncmId) || 0,
          src: srcTag,
          status: playing ? 'Playing' : (o.status === 'Paused' ? 'Paused' : 'none'),
          pos: Number.isFinite(pos) && pos >= 0 ? pos : -1,
          dur: Number.isFinite(dur) && dur > 0 ? dur : 0,
          posAt: Number.isFinite(t) && t > 0 ? t / 1000 : Date.now() / 1000,
          atMs: Date.now(),
        };
        if (!pushLogged && pushState.title) {
          pushLogged = true;
          console.log('[bridge] 已收到网易云推送: ' + pushState.title + ' - ' + pushState.artist);
        }
        rs.end('{"ok":true}');
      } catch (e) { rs.end('{"ok":false}'); }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/lyric/cands') {
    const sp = new URL(rq.url, 'http://x').searchParams;
    const title = (sp.get('title') || '').trim(), artist = (sp.get('artist') || '').trim();
    const dur = Number(sp.get('dur')) || 0;
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (!title) return rs.end(JSON.stringify({ ok: false, error: '缺少歌名' }));
    (async () => {
      try {
        const cur = lyrIdxGet(title, artist);
        const cands = await ncmSongCands(title, artist);
        rs.end(JSON.stringify({
          ok: true, dur,
          current: cur ? { songId: cur.songId || '', name: cur.name || '', artist: cur.artist || '', durMs: cur.durMs || 0, saved: !!cur.lrc } : null,
          cands: cands.slice(0, 12).map(c => ({
            songId: String(c.song.id), name: c.song.name || '', artist: c.artist || '',
            durMs: c.song.dt || 0,
            diff: dur > 0 ? Math.round(Math.abs((c.song.dt || 0) / 1000 - dur)) : null,
            current: !!(cur && cur.songId && String(cur.songId) === String(c.song.id)),
          })),
        }));
      } catch (e) { fail(rs, e); }
    })();
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/pick') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      try {
        const o = JSON.parse(body || '{}');
        const title = String(o.title || '').trim(), artist = String(o.artist || '').trim();
        const songId = String(o.songId || '').replace(/[^0-9]/g, '');
        if (!title || !songId) return rs.end(JSON.stringify({ ok: false, error: '参数不全' }));
        const r = await lyricBySongId(songId);
        // 手动换版本同样走二次校验, 避免把别的版本/纯音乐占位写进索引
        const curDur = pushFresh() && pushState.title === title && pushState.artist === artist ? Math.round(pushState.dur * 1000) : 0;
        const v = lrcAudit(r.lrc, { durSec: curDur / 1000, minLines: 3 });
        if (!v.ok) return rs.end(JSON.stringify({ ok: false, error: '这个版本没有可用歌词(' + v.reason + '), 换一个试试' }));
        const rec = lyrIdxPut(title, artist, {
          songId, name: String(o.name || title), artist: String(o.artistName || artist),
          durMs: Number(o.durMs) || 0, lrc: r.lrc, tlrc: r.tlrc, manual: true,
          audioDurMs: curDur,
          offset: lyrIdxOffset(title, artist),
        });
        if (!rec) return rs.end(JSON.stringify({ ok: false, error: '这个版本的歌词数据异常, 换一个试试' }));
        LYRIC_CACHE.delete(title + '|' + artist);
        // 正在放这首歌就直接重新加载, 不用等下一首
        if (live.title === title && live.artist === artist) {
          liveLoad(live.key, live.title, live.artist, pushFresh() ? pushState.dur : 0);
        }
        rs.end(JSON.stringify({ ok: true, songId, lines: v.lines, name: String(o.name || title) }));
      } catch (e) { fail(rs, e); }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/asr/status') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify(asrStatus()));
    return;
  }
  if (rq.method === 'POST' && url === '/api/asr/install') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      try { rs.end(JSON.stringify(await installAsrPack())); }
      catch (e) { fail(rs, e); }
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/stt') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      const send = msg => { try { rs.write(JSON.stringify({ type: 'log', msg }) + '\n'); } catch (e) {} };
      try {
        if (sttBusy) throw new Error('已经在补另一首, 请等它跑完');
        const o = JSON.parse(body || '{}');
        const title = String(o.title || '').trim(), artist = String(o.artist || '').trim();
        if (!title) throw new Error('缺少歌名');
        const r = await sttLyricForSong(title, artist, send);
        rs.end(JSON.stringify({ type: 'done', ...r }) + '\n');
      } catch (e) {
        if (e.message === '__canceled__') return rs.end(JSON.stringify({ type: 'canceled' }) + '\n');
        logError('lyric', e);
        rs.end(JSON.stringify({ type: 'error', msg: friendlyError(e) }) + '\n');
      }
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/stt/stop') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    sttStopping = true;
    if (sttChild) { try { sttChild.kill(); } catch (e) {} }
    rs.end(JSON.stringify({ ok: true, stopped: !!sttChild }));
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/drop') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      try {
        const o = JSON.parse(body || '{}');
        const title = String(o.title || '').trim(), artist = String(o.artist || '').trim();
        if (!title) return rs.end(JSON.stringify({ ok: false, error: '缺少歌名' }));
        lyrIdxDrop(title, artist);
        LYRIC_CACHE.delete(title + '|' + artist);
        // 正在放这首歌就立刻重找联网歌词, 不用等下一首
        if (live.title === title && live.artist === artist) {
          liveLoad(live.key, live.title, live.artist, pushFresh() ? pushState.dur : 0);
        }
        rs.end(JSON.stringify({ ok: true }));
      } catch (e) { fail(rs, e); }
    });
    return;
  }
  if (url === '/api/lyric/batch' && rq.method !== 'POST') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify(lyrBatchSnap()));
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/batch/start') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify({ ok: true, ...lyrBatchStart() }));
    return;
  }
  if (rq.method === 'POST' && url === '/api/lyric/batch/stop') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify({ ok: true, stopped: lyrBatchStop() }));
    return;
  }
  if (url === '/api/ncm/status') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    (async () => {
      let portOpen = false;
      try { const l = await cdpTargets(); portOpen = !!(l && l.length); } catch (e) {}
      const li = await ncmLaunchInfo();
      rs.end(JSON.stringify({ port: NCM_DEBUG_PORT, portOpen, injected: !!cdpInjectedAt, cdpLive: cdpFresh(), plugin: pushFresh(), src: pushState ? (pushState.src || 'plugin') : 'none', ncmRunning: li.running, launchedWithPort: li.withPort, launchedPort: li.port, error: cdpErr }));
    })();
    return;
  }
  if (url === '/api/ncm/relaunch' && (rq.method === 'POST' || rq.method === 'OPTIONS')) {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (rq.method === 'OPTIONS') return rs.end('{}');
    (async () => {
      try { rs.end(JSON.stringify(Object.assign({ ok: true }, await ncmRelaunch()))); }
      catch (e) { fail(rs, e); }
    })();
    return;
  }
  if (url === '/api/plugin/status') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify({ installed: bridgePluginInstalled(), path: BRIDGE_PLUGIN_PATH, connected: pushFresh(), title: pushState ? pushState.title : '', src: pushState ? (pushState.src || 'plugin') : (cdpFresh() ? 'cdp' : (smState.src || 'none')), cdp: cdpFresh() }));
    return;
  }
  if (url === '/api/plugin/install' && (rq.method === 'POST' || rq.method === 'OPTIONS')) {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    if (rq.method === 'OPTIONS') return rs.end('{}');
    try { rs.end(JSON.stringify({ ok: true, path: installBridgePlugin(), installed: true, needRestart: true })); }
    catch (e) { fail(rs, e); }
    return;
  }
  if (url === '/api/plugin/source') {
    rs.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end('// manifest.json\n' + BRIDGE_MANIFEST + '\n\n// main.js\n' + Buffer.from(BRIDGE_JS_B64, 'base64').toString('utf8'));
    return;
  }
  if (rq.method === 'GET' && url === '/api/lyric') {
    const sp = new URL(rq.url, 'http://x').searchParams;
    const title = (sp.get('title') || '').trim();
    const artist = (sp.get('artist') || '').trim();
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!title) return rs.end(JSON.stringify({ ok: false, error: '缺少歌名' }));
    if (sp.get('debug') === '1') {
      (async () => {
        try {
          const c = await ncmSongCands(title, artist);
          rs.end(JSON.stringify({ ok: true, cands: c.slice(0, 12).map(x => ({ name: x.song.name, artist: x.artist, score: x.sc, dur: x.song.dt })) }));
        } catch (e) { fail(rs, e); }
      })();
      return;
    }
    (async () => {
      try { rs.end(JSON.stringify(await lyricFor(title, artist, Number(sp.get('dur')) || 0))); }
      catch (e) { fail(rs, e); }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/lyricpos') {
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    (async () => {
      try {
        rs.end(JSON.stringify(await ocrPlayPos()));
      } catch (e) {
        fail(rs, e, { error: friendlyError(e) });
      }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/gray') {
    const pid = (new URL(rq.url, 'http://x').searchParams.get('pid') || '').trim();
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!/^\d+$/.test(pid)) return rs.end(JSON.stringify({ songs: [], total: 0, error: '请选择歌单' }));
    (async () => {
      try { rs.end(JSON.stringify(await scanPlaylist(pid))); }
      catch (e) { fail(rs, e, { songs: [], total: 0 }); }
    })();
    return;
  }
  if (rq.method === 'POST' && url === '/api/playlist/tracks') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      try {
        const o = JSON.parse(body);
        const ids = (Array.isArray(o.ids) ? o.ids : []).map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 500);
        if (!ids.length) return rs.end(JSON.stringify({ ok: false, error: '没有选中歌曲' }));
        const j = await editPlaylistTracks({ op: o.op === 'del' ? 'del' : 'add', pid: o.pid, ids });
        rs.end(JSON.stringify({ ok: true, playlistId: j.id, count: j.count }));
      } catch (e) {
        fail(rs, e);
      }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/search') {
    const kw = (new URL(rq.url, 'http://x').searchParams.get('kw') || '').trim();
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!kw) return rs.end(JSON.stringify({ items: [] }));
    if (!/SESSDATA/.test(readBiliCookie())) return rs.end(JSON.stringify({ items: [], needLogin: true }));
    (async () => {
      try {
        rs.end(JSON.stringify({ items: await biliSearch(kw) }));
      } catch (e) {
        fail(rs, e, { items: [] });
      }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/quality') {
    const bvids = (new URL(rq.url, 'http://x').searchParams.get('bvids') || '').split(',')
      .map(s => s.trim()).filter(s => /^BV[0-9A-Za-z]{10}$/.test(s)).slice(0, 20);
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!bvids.length) return rs.end(JSON.stringify({ items: [] }));
    (async () => {
      try { rs.end(JSON.stringify({ items: await biliQualityBatch(bvids) })); }
      catch (e) { fail(rs, e, { items: [] }); }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/podcast/search') {
    const kw = (new URL(rq.url, 'http://x').searchParams.get('kw') || '').trim();
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!kw) return rs.end(JSON.stringify({ items: [] }));
    (async () => {
      try { rs.end(JSON.stringify({ items: await appleSearch(kw) })); }
      catch (e) { rs.end(JSON.stringify({ items: [], error: '播客搜索失败, 请稍后再试' })); }
    })();
    return;
  }
  if (rq.method === 'GET' && url === '/api/podcast/episodes') {
    const id = (new URL(rq.url, 'http://x').searchParams.get('id') || '').trim();
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (!/^\d+$/.test(id)) return rs.end(JSON.stringify({ items: [] }));
    (async () => {
      try { rs.end(JSON.stringify({ items: await appleEpisodes(id) })); }
      catch (e) { rs.end(JSON.stringify({ items: [], error: '单集读取失败, 请稍后再试' })); }
    })();
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
        fail(rs, e);
      }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/api/cover/search') {
    const sp = new URL(rq.url, 'http://x').searchParams;
    const pic = (sp.get('pic') || '').trim();
    findCovers(pic).then(items => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(JSON.stringify({ ok: true, items }));
    }).catch(e => fail(rs, e));
    return;
  }
  if (rq.method === 'GET' && url === '/api/cover/img') {
    const target = (new URL(rq.url, 'http://x').searchParams.get('url') || '').trim();
    let ref = 'https://image.baidu.com/';
    try {
      const h = new URL(target).hostname;
      if (/bilibili|hdslb|biliimg/i.test(h)) ref = 'https://www.bilibili.com/';
      else if (/music\.126\.net/i.test(h)) ref = 'https://music.163.com/';
    } catch (e) {}
    fetchCoverBuffer(target, ref).then(buf => {
      rs.writeHead(200, { 'Content-Type': imageMime(buf) || 'image/jpeg', 'Cache-Control': 'max-age=3600' });
      rs.end(buf);
    }).catch(e => { rs.writeHead(404); rs.end(''); });
    return;
  }
  if (rq.method === 'GET' && url === '/api/cover/meta') {
    const input = (new URL(rq.url, 'http://x').searchParams.get('input') || '').trim();
    (async () => {
      let title = '', pic = '', artist = '';
      try {
        const bv = (input.match(/BV[0-9A-Za-z]{10}/) || [])[0];
        const pod = parsePodcast(input);
        if (bv) {
          const H = await biliHeaders();
          const v = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, H, 15000);
          title = (v.data && v.data.title) || '';
          pic = (v.data && v.data.pic) || '';
          // 用整理后的歌名去搜图, 比原始视频标题准得多; 顺带拿到歌手用于找歌手照片
          const cn = title ? cleanSongName(title) : null;
          if (cn) { title = cn.song; artist = cn.artist || ''; }
        } else if (pod && pod.kind === 'apple') {
          const list = await appleEpisodes(pod.collectionId);
          const ep = pod.episodeId ? list.find(x => x.episodeId === pod.episodeId) : list[0];
          if (ep) { title = ep.name; pic = ep.artwork || ''; }
        } else if (pod && pod.kind === 'xiaoyuzhou') {
          const page = await req('GET', pod.url, { 'User-Agent': UA, 'Referer': 'https://www.xiaoyuzhoufm.com/' });
          const meta = {};
          for (const m of page.text.matchAll(/<meta[^>]+(?:property|name)="(og:[^"]+)"[^>]*content="([^"]*)"/g)) meta[m[1]] = m[2];
          title = decodeEntities(meta['og:title'] || '');
          pic = meta['og:image'] || '';
        } else if (/^https?:\/\//i.test(input)) {
          const n = decodeURIComponent((input.split('?')[0].split('/').pop() || '')).replace(/\.[a-z0-9]+$/i, '');
          title = n || '';
        }
      } catch (e) { logError('cover', e); }
      if (pic.startsWith('//')) pic = 'https:' + pic;
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(JSON.stringify({ ok: true, title, pic: pic.startsWith('//') ? 'https:' + pic : pic, artist }));
    })();
    return;
  }
  // ---------- 留声机: 本地上传 ----------
  // 封面分两步: 先上传图片拿 token, 再传音频(避免把图片塞进查询串)
  if (rq.method === 'POST' && url === '/api/local/cover') {
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      try {
        const o = JSON.parse(body || '{}');
        const cover = await resolveCover(o.cover);
        if (!cover) throw new Error('图片读取失败, 请换一张试试');
        const token = crypto.randomBytes(12).toString('hex');
        const now = Date.now();
        for (const [k, v] of localCovers) if (now - v.at > 10 * 60 * 1000) localCovers.delete(k);
        localCovers.set(token, { buffer: cover.buffer, mime: cover.mime, at: now });
        rs.end(JSON.stringify({ ok: true, token }));
      } catch (e) { fail(rs, e); }
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/local/upload') {
    const sp = new URL(rq.url, 'http://x').searchParams;
    if (uploadBusy) { uploadBusyReply(rs); return; }
    uploadBusy = true;
    rq.on('close', () => { if (!rq.complete) uploadBusy = false; });
    const name = sp.get('name') || 'audio';
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = msg => { try { rs.write(JSON.stringify({ type: 'log', msg }) + '\n'); } catch (e) {} };
    // 先把请求体流式写到临时文件, 内存占用与音频大小无关
    const tmpA = path.join(os.tmpdir(), 'gsi-up-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
    let coverFile = null;
    (async () => {
      let size = 0, tooBig = false, aborted = false;
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(tmpA);
          ws.on('error', reject);
          rq.on('data', d => {
            if (tooBig || aborted) return;
            size += d.length;
            if (size > MAX_CLOUD_BYTES) { tooBig = true; rq.destroy(); ws.destroy(); return; }
            if (!ws.write(d)) rq.pause();
          });
          ws.on('drain', () => { try { rq.resume(); } catch (e) {} });
          rq.on('aborted', () => {
            aborted = true;
            try { ws.destroy(); } catch (e) {}
            reject(new Error(tooBig ? '文件超过 200MB, 请先压缩或切分后再传' : '上传被中断'));
          });
          rq.on('end', () => {
            if (tooBig) return reject(new Error('文件超过 200MB, 请先压缩或切分后再传'));
            if (aborted) return;
            ws.end(() => resolve());
          });
        });
        if (!size) throw new Error('没有读取到音频内容');
        const ext = (name.toLowerCase().match(/\.(mp3|m4a|aac|flac|ogg|wav)$/) || [])[1] || '';
        if (!ext) throw new Error('只支持 MP3 / M4A / FLAC / AAC / OGG / WAV 音频');
        const base = name.replace(/\.(mp3|m4a|aac|flac|ogg|wav)$/i, '');
        const song = (sp.get('song') || '').trim() || base || 'audio';
        const artist = (sp.get('artist') || '').trim();
        const album = (sp.get('album') || '').trim();
        let cover = null;
        const cv = localCovers.get(sp.get('token') || '');
        if (cv) { localCovers.delete(sp.get('token')); cover = { buffer: cv.buffer, mime: cv.mime }; }
        const applied = await applyCoverFile(tmpA, size, ext, cover, { title: song, artist, album }, send);
        coverFile = applied.temp || null;
        const file = applied.file;
        size = applied.size;
        send('正在校验本地音频 (' + (size / 1048576).toFixed(2) + 'MB)...');
        const md5 = await hashFile(file, 'md5');
        const up = await uploadBuffer({
          file, size, md5, ext, filename: sanitize(song) + '.' + ext, song, artist, album,
          contentType: contentTypeFor(ext), send,
        });
        appendHistory({ input: name, song, artist, ok: true, songId: up.songId });
        rs.end(JSON.stringify({ type: 'done', results: [{ ok: true, song, songId: up.songId }] }) + '\n');
      } catch (e) {
        logError('local', e);
        try { rs.end(JSON.stringify({ type: 'error', msg: friendlyError(e) }) + '\n'); } catch (_) {}
      } finally {
        uploadBusy = false;
        for (const p of [tmpA, coverFile]) { try { fs.unlinkSync(p); } catch (e) {} }
      }
    })();
    return;
  }
  if (rq.method === 'POST' && url === '/api/upload') {
    if (uploadBusy) { uploadBusyReply(rs); return; }
    uploadBusy = true;
    rq.on('close', () => { if (!rq.complete) uploadBusy = false; });
    let body = '';
    rq.on('data', d => body += d);
    rq.on('end', async () => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      // 客户端可能中途断开(关浏览器/超时), 上传任务需继续跑完, 写日志失败必须静默
      const send = msg => { try { rs.write(JSON.stringify({ type: 'log', msg }) + '\n'); } catch (e) {} };
      try {
        const opts = JSON.parse(body);
        opts.cover = await resolveCover(opts.cover);
        // 多任务: input 可为字符串(空白/逗号分隔多个链接或BV号)或数组, 含合集页链接时自动走合集模式
        const inputs = parseInputs(opts.input);
        if (!inputs.length) throw new Error('未提供视频链接或BV号');
        const results = await runJobs(inputs, opts, send);
        rs.end(JSON.stringify({ type: 'done', results }) + '\n');
      } catch (e) {
        logError('upload', e);
        rs.end(JSON.stringify({ type: 'error', msg: friendlyError(e), needSplit: e.needSplit || null }) + '\n');
      } finally {
        uploadBusy = false;
      }
    });
    return;
  }
  if (rq.method === 'GET' && url === '/desktop-lyrics') {
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': AUTH_COOKIE });
    rs.end(DLYRIC_PAGE);
    return;
  }
  if (url === '/api/live') {
    if (rq.method === 'POST') {
      let body = '';
      rq.on('data', d => body += d);
      rq.on('end', () => {
        try {
          const o = JSON.parse(body || '{}');
          if (typeof o.nudge === 'number') liveNudge(o.nudge);
          if (typeof o.seek === 'number') liveSeek(o.seek);
        } catch (e) {}
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify(liveTickState()));
      });
      return;
    }
    rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    rs.end(JSON.stringify(liveTickState()));
    return;
  }
  if (url === '/api/lyric-window') {
    if (rq.method === 'POST') {
      let body = '';
      rq.on('data', d => body += d);
      rq.on('end', async () => {
        let action = 'open';
        try { action = JSON.parse(body || '{}').action || 'open'; } catch (e) {}
        try {
          const out = action === 'close' ? await closeLyricWindow() : await openLyricWindow();
          rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          rs.end(JSON.stringify(out));
        } catch (e) { fail(rs, e); }
      });
      return;
    }
    lyricWindowState().then(st => {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(JSON.stringify({ ok: true, running: st.running, installing: st.installing }));
    }).catch(e => fail(rs, e));
    return;
  }
  rs.writeHead(404); rs.end('not found');
}
http.createServer((rq, rs) => {
  try {
    handleRequest(rq, rs);
  } catch (e) {
    // 兜底: 任何未预料的同步异常都不把堆栈丢给用户
    logError('request', e);
    try {
      if (!rs.headersSent) rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (!rs.writableEnded) rs.end(JSON.stringify({ ok: false, error: friendlyError(e) }));
    } catch (_) { /* 连接已断开 */ }
  }
}).listen(PORT, HOST, () => {
  console.log(`GraySongICU 已启动: http://${HOST}:${PORT}`);
  console.log('免责声明: 仅供技术学习与个人使用, 云盘内容仅限本人收听');
  setTimeout(ncmWatchdog, 2500);
  const ncmTimer = setInterval(ncmWatchdog, 6000);
  if (ncmTimer.unref) ncmTimer.unref();
});
// 进程级兜底: 未捕获异常只写日志, 不让服务直接退出
process.on('uncaughtException', e => logError('uncaught', e));
process.on('unhandledRejection', e => logError('unhandled', e));
