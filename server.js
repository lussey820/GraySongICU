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
const { execFile } = require('child_process');
const os = require('os');

const PORT = 3210;
const HOST = '127.0.0.1';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const BUCKET = 'jd-musicrep-privatecloud-audio-public';
// 实测(2026-10-22): 云盘存储层单文件上限 200MB, 200MB+1KB 即返回 413
const MAX_CLOUD_BYTES = 200 * 1024 * 1024;
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
function req(method, url, headers, body, isBinary, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: body ? { ...headers, 'Content-Length': body.length } : headers,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(req(method, res.headers.location, headers, body, isBinary, timeoutMs));
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

// 上传一个音频文件(Buffer)到云盘, 返回 songId
async function uploadBuffer({ buffer, ext, filename, song, artist, album, contentType, send }) {
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  send(`正在准备上传 (大小 ${(buffer.length / 1048576).toFixed(2)}MB)...`);
  const check = await ncmReq('/api/cloud/upload/check', {
    bitrate: '999000', ext, length: buffer.length, md5, songId: '0', version: 1,
  });
  if (check.code !== 200) throw new Error('预检失败: ' + JSON.stringify(check).slice(0, 150));
  if (!check.needUpload) send('⚡ 云盘里已有相同内容, 秒传完成 (无需上传文件)');

  send('正在连接云盘存储...');
  const tokenRes = await ncmReq('/api/nos/token/alloc', {
    bucket: BUCKET, ext, filename, local: false, nos_product: 3, type: 'audio', md5,
  });
  if (!tokenRes.result || !tokenRes.result.objectKey) throw new Error('存储分配失败: ' + JSON.stringify(tokenRes).slice(0, 150));
  const { objectKey, token, resourceId } = tokenRes.result;

  if (check.needUpload) {
    send('正在上传文件...');
    const lbs = JSON.parse((await req('GET', `https://wanproxy.127.net/lbs?version=1.0&bucketname=${BUCKET}`, {})).text);
    const upUrl = `${lbs.upload[0]}/${BUCKET}/${objectKey.replace(/\//g, '%2F')}?offset=0&complete=true&version=1.0`;
    const up = await req('POST', upUrl, { 'x-nos-token': token, 'Content-MD5': md5, 'Content-Type': contentType || 'audio/mp4' }, buffer);
    if (up.status !== 200) throw new Error('云存储上传失败: ' + up.text.slice(0, 150));
    send('文件上传完成');
  }

  send('正在保存歌曲信息...');
  // 入库偶发失败: 大文件首次处理可能超过网关60秒返回504, 稍后重试即秒回 (限流 uploadStatus:9 同理)
  let info = null, lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      info = await ncmReq('/api/upload/cloud/info/v2', {
        md5, songid: check.songId, filename, song, album: album || '', artist, bitrate: '999000', resourceId,
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
async function uploadAudioAuto({ buffer, ext, filename, song, artist, album, contentType, send, split }) {
  if (buffer.length <= MAX_CLOUD_BYTES) {
    const up = await uploadBuffer({ buffer, ext, filename, song, artist, album, contentType, send });
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
      song: name, artist, album: album || '', contentType, send,
    });
    send(`✓ 第 ${i + 1}/${builders.length} 段完成${up.instant ? ' (秒传)' : ''}`);
    out.push({ song: name, songId: up.songId, instant: up.instant, size: part.length });
  }
  return out;
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

// ---------- ffmpeg 转码兜底 (可选: 系统装有 ffmpeg 才启用) ----------
let ffmpegOk = null; // null=未检测, true/false=缓存
function checkFfmpeg() {
  return new Promise(resolve => {
    if (ffmpegOk !== null) return resolve(ffmpegOk);
    try {
      execFile('ffmpeg', ['-version'], { timeout: 5000 }, err => {
        ffmpegOk = !err;
        resolve(ffmpegOk);
      }).on('error', () => { ffmpegOk = false; resolve(false); });
    } catch (e) { ffmpegOk = false; resolve(false); }
  });
}
// m4a → mp3: 走临时文件 (MP4 容器需可寻址输入, 管道不可靠), 用后即删
function transcodeMp3(buf) {
  return new Promise((resolve, reject) => {
    const inF = path.join(os.tmpdir(), 'bili2ncm_' + Date.now() + '.m4a');
    const outF = inF.replace(/\.m4a$/, '.mp3');
    try { fs.writeFileSync(inF, buf); } catch (e) { return reject(new Error('临时文件写入失败: ' + e.message)); }
    execFile('ffmpeg', ['-y', '-i', inF, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outF], { timeout: 300000 }, (err, so, se) => {
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
// 合集页链接识别: space.bilibili.com/{mid}/channel/collectiondetail?sid={season_id} (或 ?season_id=)
function parseSeason(input) {
  const sid = (input.match(/[?&](?:sid|season_id)=(\d+)/) || [])[1];
  if (!sid) return null;
  const mid = (input.match(/space\.bilibili\.com\/(\d+)/) || [])[1];
  return { sid, mid: mid || null };
}
// 输入拆分: 字符串按空白/逗号分号拆成多任务, 数组原样用
function parseInputs(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，;；]+/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}
// 小宇宙单集: https://www.xiaoyuzhoufm.com/episode/{id}
function parsePodcast(input) {
  const m = String(input || '').match(/xiaoyuzhoufm\.com\/episode\/([0-9a-zA-Z]+)/);
  return m ? { id: m[1], url: 'https://www.xiaoyuzhoufm.com/episode/' + m[1] } : null;
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// 小宇宙播客单集: 页面公开 og:audio 直链, 下载后复用云盘上传链路
async function podcastUpload(input, opts, send) {
  const pc = parsePodcast(input);
  if (!pc) throw new Error('无法解析小宇宙单集链接: ' + input);
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
  const buf = await req('GET', audioUrl, { 'User-Agent': UA, 'Referer': 'https://www.xiaoyuzhoufm.com/' }, null, true);
  send(`已下载 ${(buf.length / 1048576).toFixed(2)}MB`);

  const songName = sanitize(opts.song || title);
  const artist = sanitize(opts.artist || showName);
  const ups = await uploadAudioAuto({
    buffer: buf, ext, filename: songName + '.' + ext,
    song: songName, artist, album: '', contentType, send, split: !!opts.split,
  });
  ups.forEach(u => appendHistory({ source: '播客', url: pc.url, song: u.song, artist, songId: u.songId, size: u.size }));
  send(`✓ 上传完成${ups.every(u => u.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
  return ups.map(u => ({ input: pc.url, song: u.song, songId: u.songId, ok: true, instant: u.instant }));
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
      send(`✗ ${bv} 失败: ${e.message}`);
      results.push({ input: bv, ok: false, error: e.message });
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
    if (i > 0) { send('为避免平台限制, 等待5秒后继续...'); await sleep(5000); }
    const season = parseSeason(item);
    const podcast = parsePodcast(item);
    try {
      if (podcast) {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务: 播客 #####`);
        results.push(...await podcastUpload(item, opts, send));
      } else if (season) {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务: 合集 #####`);
        results.push(...await seasonUpload(season, opts, send));
      } else {
        send(`\n##### 第 ${i + 1}/${inputs.length} 个任务 #####`);
        results.push(...await biliUpload(item, opts, send));
      }
    } catch (e) {
      if (e.needSplit) throw e;
      send(`✗ 任务失败: ${e.message}`);
      results.push({ input: item, ok: false, error: e.message });
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
          send(`✗ ${eps[i]} 失败: ${e.message}`);
          sub.push({ input: eps[i], ok: false, error: e.message });
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

      send('下载音频中...');
      const buf = await downloadAudio(a, H, send);
      send(`已下载 ${(buf.length / 1048576).toFixed(2)}MB`);

      // 30251=Hi-Res(FLAC), 其余为 AAC(m4a); 专辑不写(留空给网易云/后续手动匹配)
      const ext = a.id === 30251 ? 'flac' : 'm4a';
      let ups;
      try {
        ups = await uploadAudioAuto({
          buffer: buf, ext, filename: songName + '.' + ext,
          song: songName, artist, album: '', contentType: ext === 'flac' ? 'audio/flac' : 'audio/mp4', send, split: !!opts.split,
        });
      } catch (e) {
        // m4a 被云盘拒绝时的转码兜底 (登录失效/需确认拆分时不重试; flac 原生支持无需兜底)
        if (ext !== 'm4a' || e.authFail || e.needSplit) throw e;
        if (!(await checkFfmpeg())) { send('[提示] 未检测到格式转换工具(ffmpeg), 无法自动转码'); throw e; }
        send('云盘不接收此格式, 正在转换格式后重试...');
        const mp3 = await transcodeMp3(buf);
        const up = await uploadBuffer({
          buffer: mp3, ext: 'mp3', filename: songName + '.mp3',
          song: songName, artist, album: '', contentType: 'audio/mpeg', send,
        });
        ups = [{ song: songName, songId: up.songId, instant: up.instant, size: mp3.length }];
      }
      ups.forEach(up => {
        results.push({ page: pg.page, song: up.song, songId: up.songId, ok: true, instant: up.instant });
        appendHistory({ bvid, page: pg.page, song: up.song, artist, songId: up.songId, size: up.size || buf.length });
      });
      send(`✓ 上传完成${ups.every(up => up.instant) ? ' (秒传)' : ''}${ups.length > 1 ? `, 共 ${ups.length} 段` : ''}`);
    } catch (e) {
      if (e.needSplit) throw e;
      send(`✗ 这一段失败: ${e.message}`);
      results.push({ page: pg.page, song: songName, ok: false, error: e.message });
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

// ---------- 页面 ----------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>bili2ncm — B站音频传网易云云盘</title>
<style>
  :root{ --red:#ec4141; --red-dark:#d63a3a; --bg:#f6f6f8; --card:#fff; --line:#ebebef; --line-soft:#f2f2f5; --t1:#1f1f22; --t2:#6b6b72; --t3:#9b9ba2; --ok:#2bb673; --bad:#d5453c; }
  *{margin:0;padding:0;box-sizing:border-box}
  [hidden]{display:none !important}
  body{background:var(--bg);color:var(--t1);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  input,select,button{font-family:inherit}
  :focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:4px}

  .top{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
  .top-in{max-width:720px;margin:0 auto;height:56px;padding:0 16px;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:15px;font-weight:600;letter-spacing:.2px}
  .tabs{display:flex;gap:2px;background:#f1f1f4;border-radius:9px;padding:3px}
  .tab{height:32px;padding:0 18px;border:none;border-radius:7px;background:transparent;color:var(--t2);font-size:13px;cursor:pointer;transition:background .15s,color .15s}
  .tab:hover{color:var(--t1)}
  .tab.on{background:#fff;color:var(--red);font-weight:500;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .account{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--t2)}
  .dot{width:7px;height:7px;border-radius:50%;background:#c9c9cf}
  .dot.on{background:var(--ok)} .dot.off{background:var(--bad)}
  .account b{color:var(--t1);font-weight:500}
  .link{background:none;border:none;color:var(--t3);font-size:13px;cursor:pointer;padding:10px 4px}
  .link:hover{color:var(--red)}

  main{max-width:720px;margin:0 auto;padding:20px 16px 40px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
  .card h2{font-size:15px;font-weight:600}

  .upload{display:flex;gap:10px}
  .upload input[type=text],.upload textarea{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid #e3e3e9;border-radius:8px;background:#fff;font-size:14px;color:var(--t1);outline:none;transition:border-color .15s}
  .upload textarea{resize:none;padding-top:11px;line-height:1.4}
  .upload input::placeholder,.upload textarea::placeholder{color:#b0b0b8}
  .upload input:focus,.upload textarea:focus{border-color:var(--red)}
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
  .acct-card{background:#fff;border-radius:14px;padding:18px 20px 16px;width:min(440px,100%);max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.16)}
  .acct-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:15px;font-weight:600;color:var(--t1)}
  .acct-card .crow{display:flex;gap:10px}
  .acct-card input{flex:1;min-width:0;height:40px;padding:0 10px;border:1px solid #e3e3e9;border-radius:7px;font-size:13px;outline:none}
  .acct-card input:focus{border-color:var(--red)}
  .mini{background:#fff;border:1px solid var(--line);border-radius:7px;padding:9px 14px;font-size:12.5px;color:var(--t2);cursor:pointer}
  .mini:hover{color:var(--red);border-color:#f3c9c9}
  .mini:disabled{background:#fafafc;color:var(--t3);border-color:var(--line-soft);cursor:default}
  .acct-btn{background:#fff;border:1px solid var(--line);border-radius:20px;padding:7px 14px;cursor:pointer}
  .acct-btn:hover{border-color:#f3c9c9;color:var(--red)}
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
  .compare.split{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,0.88fr);gap:16px;align-items:stretch}
  .compare.split > .card{display:flex;flex-direction:column;height:calc(100vh - 250px);min-height:440px;padding:18px 22px}
  .compare.split > .card.cloud{background:#fbfbfd}
  .compare.split #sres,.compare.split #list{flex:1;min-height:0;overflow:auto;padding-right:6px;scrollbar-width:thin;scrollbar-color:#dedee4 transparent}
  .compare.split #sres{margin-top:12px}
  .compare.split #sres::-webkit-scrollbar,.compare.split #list::-webkit-scrollbar{width:6px}
  .compare.split #sres::-webkit-scrollbar-track,.compare.split #list::-webkit-scrollbar-track{background:transparent}
  .compare.split #sres::-webkit-scrollbar-thumb,.compare.split #list::-webkit-scrollbar-thumb{background:#e2e2e8;border-radius:3px}
  .compare.split .sr-head{position:sticky;top:0;z-index:1;background:#fff;padding:6px 0 9px}
  .compare.split .sr,.compare.split .song{padding:13px 0}
  .compare.split .song{grid-template-columns:1fr 1fr 92px 34px;gap:10px}
  main.split{max-width:1080px}
  main.split > .card,main.split > .progress,main.split > .hist,main.split > .foot{max-width:720px;margin-left:auto;margin-right:auto}
  @media (max-width:900px){
    .compare.split{display:block}
    .compare.split > .card{height:auto;min-height:0}
    .compare.split #sres,.compare.split #list{overflow:visible}
    main.split{max-width:720px}
  }

  .cloud-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px}
  .cloud-right{display:flex;align-items:center;gap:12px}
  .cloud-meta{font-size:12px;color:var(--t3);font-variant-numeric:tabular-nums}
  .song{display:grid;grid-template-columns:1fr 1fr 108px 40px;grid-template-areas:"name artist meta del";align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line-soft);font-size:13px}
  .s-name{grid-area:name;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-artist{grid-area:artist;min-width:0;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-meta{grid-area:meta;color:var(--t3);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .s-del{grid-area:del;background:none;border:none;font-size:13px;color:var(--t3);cursor:pointer;text-align:right;padding:8px 0}
  .s-del:hover{color:var(--red)}
  .empty{padding:34px 0 30px;text-align:center;color:var(--t3);font-size:13px;border-top:1px solid var(--line-soft)}
  .empty button{background:none;border:none;color:var(--red);font-size:13px;cursor:pointer;padding:8px}
  #sres{margin-top:4px}
  .sr-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0 8px;border-top:1px solid var(--line-soft);font-size:12.5px;color:var(--t3)}
  .sr-head .chk{padding:2px 0}
  .badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:#fdeeee;color:var(--red);font-size:11px;font-weight:400;vertical-align:1px}
  .sr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid var(--line-soft);font-size:13px}
  .sr-l{min-width:0}
  .sr-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sr-m{margin-top:2px;color:var(--t3);font-size:12px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sr-a{display:flex;gap:8px;flex-shrink:0}
  #pv{padding:10px 0;border-bottom:1px solid var(--line-soft)}
  #pv iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:8px;display:block}
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

  @media (max-width:400px){ .brand{display:none} }
  @media (max-width:560px){
    .upload{flex-wrap:wrap}
    .upload input[type=text],.upload textarea{flex:1 1 100%}
    .upload select{flex:1;width:auto}
    .btn{flex:none;padding:0 22px}
    .song{grid-template-columns:1fr auto;grid-template-areas:"name del" "artist del";row-gap:2px}
    .s-meta{display:none}
    .acct-card .crow{flex-wrap:wrap}
    .acct-card input{flex:1 1 100%}
  }
</style>
</head>
<body>

<div class="top">
  <div class="top-in">
    <div class="brand">bili2ncm</div>
    <div class="tabs" role="tablist">
      <button class="tab on" data-tab="music" onclick="switchTab('music')">音乐</button>
      <button class="tab" data-tab="pod" onclick="switchTab('pod')">播客</button>
    </div>
    <button class="account acct-btn" id="account" onclick="openAccount()" title="账号登录"><span class="dot"></span><span id="acctText">账号</span></button>
  </div>
</div>

<main>
  <section class="card">
    <div class="upload">
      <textarea id="input" rows="1" placeholder="粘贴 B 站视频/合集页链接或 BV 号，可一次粘贴多个"></textarea>
      <button class="btn" id="go" onclick="doUpload()">上传</button>
    </div>
    <div class="sub">
      <label class="chk" id="seasonWrap" title="视频属于B站合集时, 依次上传合集内全部视频; 或直接粘贴合集页链接"><input type="checkbox" id="season">整个合集</label>
      <label class="chk" title="去序号/标签, 拆分'歌手-歌名', 歌手字段自动纠正"><input type="checkbox" id="clean" checked>整理歌名</label>
      <button class="link" onclick="toggleMore()" type="button">手动指定歌名</button>
    </div>
    <p class="hint" id="podHint" hidden>粘贴小宇宙播客单集链接（xiaoyuzhoufm.com/episode/…），可一次粘贴多期；超过 200MB 时会先询问是否拆分成多个文件。</p>
    <div class="more" id="more">
      <input type="text" id="song" placeholder="歌名 (留空=自动)">
      <input type="text" id="artist" placeholder="歌手 (留空=自动)">
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

  <div class="compare" id="compare">
    <section class="card" id="searchCard">
      <div class="upload">
        <input type="text" id="skw" placeholder="搜索 B 站歌曲/翻唱/演唱会…">
        <button class="btn" id="sbtn" onclick="doSearch()">搜索</button>
      </div>
      <div id="sres" hidden></div>
    </section>

    <section class="card cloud">
      <div class="cloud-head">
        <h2>音乐云盘</h2>
        <div class="cloud-right">
          <span class="cloud-meta" id="stats"></span>
          <button class="mini" onclick="loadList()">刷新</button>
        </div>
      </div>
      <div id="list"></div>
    </section>
  </div>

  <details class="card hist">
    <summary>上传历史 (本地记录, 最近50条) <button class="link" onclick="event.preventDefault();event.stopPropagation();clearHistory()">清空</button></summary>
    <div id="history"></div>
  </details>

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
function lockScroll(){ document.body.style.overflow = (!$('biliPanel').hidden || !$('accountModal').hidden || !$('splitModal').hidden) ? 'hidden' : ''; }
function openAccount(){ $('accountModal').hidden = false; lockScroll(); }
function closeAccount(){ $('accountModal').hidden = true; lockScroll(); }
function toggleManual(){ $('manualBox').hidden = !$('manualBox').hidden; }
function toggleMore(){ $('more').classList.toggle('open'); }
function focusInput(){ $('input').focus(); }

// 顶部分类: 音乐(B站) / 播客(小宇宙), 云盘/进度/历史共用
let curTab = 'music';
function switchTab(t) {
  curTab = t === 'pod' ? 'pod' : 'music';
  try { localStorage.setItem('bili2ncm.tab', curTab); } catch (e) {}
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === curTab));
  const pod = curTab === 'pod';
  $('input').placeholder = pod
    ? '粘贴小宇宙播客单集链接（xiaoyuzhoufm.com/episode/…），可一次粘贴多期'
    : '粘贴 B 站视频/合集页链接或 BV 号，可一次粘贴多个';
  $('seasonWrap').hidden = pod;
  $('podHint').hidden = !pod;
  $('searchCard').hidden = pod;
  setSplit(!pod && searchItems.length > 0);
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
function confirmSplit(){ closeSplit(); doUpload(true); }

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
  } catch (e) { $('qrstate').textContent = e.message; }
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
// 表单记忆: 只存偏好项(音质/整理歌名/歌名/歌手); 上传全部/整个合集属场景开关不记忆, 防误触发大批量
const FORM_KEY = 'bili2ncm_form_v1';
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
async function loadList() {
  const box = $('list');
  try {
    const j = await (await fetch('/api/list')).json();
    const fmtSize = n => n >= 1073741824 ? (n/1073741824).toFixed(1)+' GB' : (n/1048576).toFixed(1)+' MB';
    $('stats').textContent = '共 ' + j.count + ' 首 · ' + fmtSize(j.size) + (j.maxSize ? ' / 容量 ' + fmtSize(j.maxSize) : '');
    if (j.error) { box.innerHTML = '<div class="empty">' + esc(j.error) + '<br><button onclick="loadList()">重试</button></div>'; return; }
    cloudSongs = j.songs || []; cloudLoaded = true;
    if (searchItems.length) refreshSearchDup();
    if (!j.songs.length) { box.innerHTML = '<div class="empty">云盘还是空的<br><button onclick="focusInput()">去上传第一首</button></div>'; return; }
    box.innerHTML = j.songs.map(s =>
      '<div class="song"><div class="s-name">' + esc(s.name) + '</div><div class="s-artist">' + esc(s.artist) + '</div>'
      + '<div class="s-meta">' + (s.bitrate ? Math.round(s.bitrate/1000)+'kbps' : '-') + ' · ' + (s.size ? (s.size/1048576).toFixed(1)+'MB' : '-') + '</div>'
      + '<button class="s-del" data-id="' + s.songId + '" data-name="' + esc(s.name) + '">删除</button></div>').join('');
  } catch (e) {
    box.innerHTML = '<div class="empty">加载失败<button onclick="loadList()">重试</button></div>';
  }
}
$('list').addEventListener('click', e => {
  const b = e.target.closest('.s-del'); if (!b) return;
  if (!confirm('确定从云盘删除《' + b.dataset.name + '》?')) return;
  fetch('/api/del', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({songId:+b.dataset.id}) }).then(loadList);
});
// 多链接输入: Enter 提交(Shift+Enter 换行)
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doUpload(); } });
function uploadBV(bvid) { $('input').value = bvid; doUpload(); }
// B站搜索: 结果与云盘曲目对照, 已收录的标出来, 可只看未导入的
let searchItems = [], onlyNew = false;
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
    return n === t || (n.length >= 2 && t.indexOf(n) > -1);
  }) || null;
}
function refreshSearchDup() {
  searchItems.forEach(v => { v.cloud = !!cloudMatch(v.title); });
  renderSearch();
}
function renderSearch() {
  const box = $('sres');
  const total = searchItems.length;
  const dup = searchItems.filter(v => v.cloud).length;
  const list = onlyNew ? searchItems.filter(v => !v.cloud) : searchItems;
  setSplit(total > 0);
  const head = '<div class="sr-head"><span>找到 ' + total + ' 首' + (dup ? ' · 云盘已有 ' + dup + ' 首' : '')
    + '</span><label class="chk"><input type="checkbox" id="onlyNew"' + (onlyNew ? ' checked' : '') + '>只看可导入</label></div>';
  if (!list.length) {
    box.innerHTML = head + '<div class="empty">' + (total ? '这些歌云盘里都已经有了' : '没有找到相关内容')
      + '<br><button class="mini" data-act="pop">在页面内搜B站</button></div>';
    return;
  }
  box.innerHTML = head + '<div id="pv" hidden></div>' + list.map(v =>
    '<div class="sr"><div class="sr-l"><div class="sr-t">' + esc(v.title) + (v.cloud ? '<span class="badge">云盘已有</span>' : '') + '</div>'
    + '<div class="sr-m">' + esc(v.author) + ' · ' + esc(v.duration) + ' · ' + fmtPlay(v.play) + '次播放</div></div>'
    + '<div class="sr-a"><button class="mini" data-act="preview" data-bv="' + esc(v.bvid) + '">试听</button>'
    + (v.cloud ? '<button class="mini" disabled>已导入</button>'
      : '<button class="mini" data-act="upload" data-bv="' + esc(v.bvid) + '">上传</button>')
    + '</div></div>'
  ).join('');
}
async function doSearch() {
  const kw = $('skw').value.trim();
  if (!kw) { $('skw').focus(); return; }
  const box = $('sres');
  box.hidden = false;
  if (!biliLogged) { showBiliLoginPrompt(box); return; }
  box.innerHTML = '<div class="empty">搜索中...</div>';
  try {
    if (!cloudLoaded) await loadList();
    const j = await (await fetch('/api/search?kw=' + encodeURIComponent(kw))).json();
    if (j.needLogin) { showBiliLoginPrompt(box); return; }
    if (j.error) { searchItems = []; setSplit(false); box.innerHTML = '<div class="empty">B站登录可能已过期 <button class="mini" data-act="qr">扫码登录B站</button> <button class="mini" data-act="pop">在页面内搜B站</button></div>'; return; }
    searchItems = (j.items || []).map(v => Object.assign({}, v, { cloud: !!cloudMatch(v.title) }));
    renderSearch();
  } catch (e) {
    searchItems = [];
    setSplit(false);
    box.innerHTML = '<div class="empty">搜索失败, 请稍后再试 <button class="mini" data-act="pop">在页面内搜B站</button></div>';
  }
}
function showBiliLoginPrompt(box) {
  searchItems = [];
  setSplit(false);
  box.innerHTML = '<div class="empty">搜索需要先登录B站<br><button class="mini" data-act="qr">扫码登录B站</button> <button class="mini" data-act="pop">在页面内搜B站</button></div>';
}
// 搜索结果按钮统一用事件委托, 避免内联引号在模板字符串中被提前转义
$('sres').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'preview') previewBV(b.dataset.bv);
  else if (act === 'upload') uploadBV(b.dataset.bv);
  else if (act === 'qr') showQr('bili');
  else if (act === 'pop') popSearch();
});
$('sres').addEventListener('change', e => {
  if (e.target.id !== 'onlyNew') return;
  onlyNew = e.target.checked;
  renderSearch();
});
function fmtPlay(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }
// 左右对照: 有搜索结果时把搜索框与音乐云盘并排, 同时查看已有哪些歌
function setSplit(on) {
  $('compare').classList.toggle('split', on);
  document.querySelector('main').classList.toggle('split', on);
}
// 内嵌B站搜索: 覆盖在本页内, 无需切换窗口; 找到视频复制链接回来粘贴即可
let bpKw = '';
function popSearch() {
  bpKw = $('skw').value.trim();
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
  if (!$('splitModal').hidden) closeSplit();
  else if (!$('accountModal').hidden) closeAccount();
  else if (!$('biliPanel').hidden) closeBiliPanel();
});
function previewBV(bvid) {
  const pv = $('pv');
  if (pv.dataset.bv === bvid) { pv.hidden = !pv.hidden; if (pv.hidden) pv.innerHTML = ''; return; }
  pv.dataset.bv = bvid; pv.hidden = false;
  pv.innerHTML = '<iframe src="https://player.bilibili.com/player.html?bvid=' + bvid + '&autoplay=1&danmaku=0" allowfullscreen></iframe>';
}
$('skw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
async function doUpload(split) {
  const input = $('input').value.trim();
  if (!input) { $('input').focus(); return; }
  split = split === true;
  const btn = $('go');
  btn.disabled = true; btn.textContent = '上传中';
  lastTotal = 0;
  $('progress').hidden = false;
  $('running').hidden = false; $('finished').hidden = true;
  $('pErrs').hidden = true; $('pErrs').textContent = '';
  $('rawlog').textContent = '';
  $('pTitle').textContent = split ? '正在拆分上传' : '正在上传'; $('pNow').textContent = '准备中';
  $('pCount').textContent = ''; $('pBar').style.width = '3%';
  saveForm();
  try {
    const res = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ input, allPages: true, split, season: $('season').checked,
        clean: $('clean').checked, song: $('song').value.trim(), artist: $('artist').value.trim() }) });
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
      }
    }
  } catch (e) {
    step('✗ ' + e.message, true);
    $('running').hidden = true; $('finished').hidden = false;
    $('pDone').innerHTML = '上传失败<span>' + esc(e.message.slice(0, 80)) + '</span>';
  }
  btn.disabled = false; btn.textContent = '上传';
}
restoreForm(); loadStatus(); loadList(); loadHistory();
try { switchTab(localStorage.getItem('bili2ncm.tab') === 'pod' ? 'pod' : 'music'); } catch (e) { switchTab('music'); }
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
    fs.writeFileSync(BILI_COOKIE_FILE, cookie);
    return { state: 'done' };
  }
  return { state: code === 86090 ? 'scanned' : code === 86038 ? 'expired' : 'wait' };
}
async function ncmQrCreate() {
  const r = await weapiRaw('/api/login/qrcode/unikey', { type: 1 });
  if (r.json.code !== 200 || !r.json.unikey) throw new Error('获取登录码失败: ' + (r.json.message || r.json.code));
  return { text: r.json.unikey, key: r.json.unikey };
}
async function ncmQrPoll(key) {
  const r = await weapiRaw('/api/login/qrcode/client/login', { key, type: 1 });
  const c = r.json.code;
  if (c === 803) {
    // 803时凭证在响应体cookie字段, 部分情况下在Set-Cookie
    const cookie = r.json.cookie || r.setCookie.map(s => s.split(';')[0]).join('; ');
    if (!/MUSIC_U=[^;\s]+/.test(cookie)) throw new Error('登录成功但未取得凭证, 请重试');
    fs.writeFileSync(NCM_COOKIE_FILE, cookie);
    return { state: 'done' };
  }
  return { state: c === 802 ? 'scanned' : c === 800 ? 'expired' : 'wait' };
}

// ---------- 服务器 ----------
http.createServer((rq, rs) => {
  const url = rq.url.split('?')[0];
  if (rq.method === 'GET' && url === '/') {
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return rs.end(PAGE);
  }
  if (rq.method === 'GET' && url === '/api/status') {
    withTimeout(ncmAccount(), 30000, '登录态检测超时(30秒)')
      .then(ncm => {
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ncm, bili: /SESSDATA/.test(readBiliCookie()) }));
      }).catch(e => {
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ ncm: { ok: false, timeout: /检测超时/.test(e.message), error: e.message }, bili: /SESSDATA/.test(readBiliCookie()) }));
      });
    return;
  }
  if (rq.method === 'GET' && url === '/api/qr/svg') {
    try {
      const text = new URL(rq.url, 'http://x').searchParams.get('text') || '';
      rs.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      rs.end(qrSvg(text));
    } catch (e) { rs.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); rs.end(e.message); }
    return;
  }
  for (const kind of ['bili', 'ncm']) {
    if (rq.method === 'GET' && url === '/api/qr/' + kind + '/create') {
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      (async () => {
        try {
          const j = await (kind === 'bili' ? biliQrCreate() : ncmQrCreate());
          rs.end(JSON.stringify({ ok: true, text: j.text, key: j.key }));
        } catch (e) { rs.end(JSON.stringify({ ok: false, error: e.message })); }
      })();
      return;
    }
    if (rq.method === 'GET' && url === '/api/qr/' + kind + '/poll') {
      const key = new URL(rq.url, 'http://x').searchParams.get('key') || '';
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      (async () => {
        try {
          rs.end(JSON.stringify(await (kind === 'bili' ? biliQrPoll(key) : ncmQrPoll(key))));
        } catch (e) { rs.end(JSON.stringify({ state: 'error', error: e.message })); }
      })();
      return;
    }
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
  if (rq.method === 'DELETE' && url === '/api/history') {
    try {
      fs.writeFileSync(HISTORY_FILE, '[]');
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ok: true }));
    } catch (e) {
      rs.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      rs.end(JSON.stringify({ ok: false, error: e.message }));
    }
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
        rs.end(JSON.stringify({ items: [], error: e.message }));
      }
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
        // 多任务: input 可为字符串(空白/逗号分隔多个链接或BV号)或数组, 含合集页链接时自动走合集模式
        const inputs = parseInputs(opts.input);
        if (!inputs.length) throw new Error('未提供视频链接或BV号');
        const results = await runJobs(inputs, opts, send);
        rs.end(JSON.stringify({ type: 'done', results }) + '\n');
      } catch (e) {
        rs.end(JSON.stringify({ type: 'error', msg: e.message, needSplit: e.needSplit || null }) + '\n');
      }
    });
    return;
  }
  rs.writeHead(404); rs.end('not found');
}).listen(PORT, HOST, () => {
  console.log(`bili2ncm 已启动: http://${HOST}:${PORT}`);
  console.log('免责声明: 仅供技术学习与个人使用, 云盘内容仅限本人收听');
});
