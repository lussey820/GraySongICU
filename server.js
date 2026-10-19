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
  send(`「${title}」 UP: ${owner.name} | 分P: ${allPages ? '全部 ' + pages.length + 'P' : wantPages ? '指定 ' + targets.length + 'P' : targets[0].page + 'P'}`);

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
  :root{ --red:#ec4141; --red-dark:#d63a3a; --bg:#f6f6f8; --card:#fff; --line:#ebebef; --line-soft:#f2f2f5; --t1:#1f1f22; --t2:#6b6b72; --t3:#9b9ba2; --ok:#2bb673; --bad:#d5453c; }
  *{margin:0;padding:0;box-sizing:border-box}
  [hidden]{display:none !important}
  body{background:var(--bg);color:var(--t1);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  input,select,button{font-family:inherit}
  :focus-visible{outline:2px solid var(--red);outline-offset:2px;border-radius:4px}

  .top{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
  .top-in{max-width:720px;margin:0 auto;height:56px;padding:0 16px;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:15px;font-weight:600;letter-spacing:.2px}
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
  .upload input[type=text]{flex:1;min-width:0;height:44px;padding:0 12px;border:1px solid #e3e3e9;border-radius:8px;background:#fff;font-size:14px;color:var(--t1);outline:none;transition:border-color .15s}
  .upload input::placeholder{color:#b0b0b8}
  .upload input:focus{border-color:var(--red)}
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

  .panel{margin-top:14px;display:none;gap:10px;flex-direction:column}
  .panel.open{display:flex}
  .panel .crow{display:flex;gap:10px}
  .panel input{flex:1;min-width:0;height:40px;padding:0 10px;border:1px solid #e3e3e9;border-radius:7px;font-size:13px;outline:none}
  .panel input:focus{border-color:var(--red)}
  .mini{background:#fff;border:1px solid var(--line);border-radius:7px;padding:9px 14px;font-size:12.5px;color:var(--t2);cursor:pointer}
  .mini:hover{color:var(--red);border-color:#f3c9c9}

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

  .hist{margin-top:14px}
  .hist summary{font-size:13px;color:var(--t2);cursor:pointer;padding:12px 0}
  .h-row{display:flex;gap:12px;padding:9px 0;border-top:1px solid var(--line-soft);font-size:12.5px;color:var(--t2);align-items:baseline}
  .h-time{flex:none;color:var(--t3);font-variant-numeric:tabular-nums}
  .h-name{flex:1;min-width:0;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .h-size{flex:none;color:var(--t3)}

  .foot{margin-top:18px;text-align:center;font-size:12px;color:#b6b6bd;line-height:1.8}

  @media (max-width:560px){
    .upload{flex-wrap:wrap}
    .upload input[type=text]{flex:1 1 100%}
    .upload select{flex:1;width:auto}
    .btn{flex:none;padding:0 22px}
    .song{grid-template-columns:1fr auto;grid-template-areas:"name del" "artist del";row-gap:2px}
    .s-meta{display:none}
    .panel .crow{flex-wrap:wrap}
    .panel input{flex:1 1 100%}
  }
</style>
</head>
<body>

<div class="top">
  <div class="top-in">
    <div class="brand">bili2ncm</div>
    <div class="account" id="account"><span class="dot"></span>检测登录态...</div>
  </div>
</div>

<main>
  <section class="card">
    <div class="upload">
      <input type="text" id="input" placeholder="粘贴 B 站视频链接或 BV 号">
      <select id="quality">
        <option value="best">最高音质</option>
        <option value="192k">192kbps</option>
        <option value="132k">132kbps</option>
        <option value="64k">64kbps</option>
      </select>
      <button class="btn" id="go" onclick="doUpload()">上传</button>
    </div>
    <div class="sub">
      <input type="text" id="pages" placeholder="分P，如 2 或 1-47">
      <label class="chk"><input type="checkbox" id="allPages">上传全部</label>
      <label class="chk" title="去序号/标签, 拆分'歌手-歌名', 歌手字段自动纠正"><input type="checkbox" id="clean" checked>整理歌名</label>
      <button class="link" onclick="toggleMore()" type="button">手动指定歌名</button>
    </div>
    <div class="more" id="more">
      <input type="text" id="song" placeholder="歌名 (留空=自动)">
      <input type="text" id="artist" placeholder="歌手 (留空=自动)">
    </div>
  </section>

  <section class="card panel" id="settings">
    <div class="crow">
      <input type="password" id="ncmCookie" placeholder="网易云 MUSIC_U=F90E1F... (多个cookie分号连接)">
      <button class="mini" onclick="saveCookie('ncm')">保存网易云</button>
    </div>
    <div class="crow">
      <input type="password" id="biliCookie" placeholder="B站 SESSDATA=xxx (可选, 提升音质上限)">
      <button class="mini" onclick="saveCookie('bili')">保存B站</button>
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

  <details class="card hist">
    <summary>上传历史 (本地记录, 最近50条)</summary>
    <div id="history"></div>
  </details>

  <p class="foot">免责声明: 上传内容仅限本人收听, 请遵守B站与网易云音乐的服务条款及版权法规, 请勿用于商业用途。</p>
</main>
<script>
function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const $ = id => document.getElementById(id);
function toggleSettings(){ $('settings').classList.toggle('open'); }
function toggleMore(){ $('more').classList.toggle('open'); }
function focusInput(){ $('input').focus(); }

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
  if (msg.indexOf('获取音频流') > -1) w.style.width = '12%';
  else if (msg.indexOf('下载音频') > -1) w.style.width = '32%';
  else if (msg.indexOf('上传文件到云存储') > -1) w.style.width = '62%';
  else if (msg.indexOf('写入歌曲信息') > -1) w.style.width = '82%';
  else if (msg.indexOf('发布') > -1) w.style.width = '92%';
  else if (msg.indexOf('✓ 完成') > -1) w.style.width = '100%';
}
async function loadStatus() {
  const j = await (await fetch('/api/status')).json();
  const el = $('account');
  if (j.ncm.ok) el.innerHTML = '<span class="dot on"></span>网易云 · <b>' + esc(j.ncm.nickname) + '</b><button class="link" onclick="toggleSettings()">设置</button>';
  else el.innerHTML = '<span class="dot off"></span>网易云未登录<button class="link" onclick="toggleSettings()">去配置</button>';
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
// 空状态带行动 / 加载失败可重试 / grid 行布局
async function loadList() {
  const box = $('list');
  try {
    const j = await (await fetch('/api/list')).json();
    $('stats').textContent = '共 ' + j.count + ' 首 · ' + (j.size/1048576).toFixed(1) + ' MB';
    if (j.error) { box.innerHTML = '<div class="empty">' + esc(j.error) + '<br><button onclick="loadList()">重试</button></div>'; return; }
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
// 解析分P范围: '1-47' / '1,3,5-8' → 有序数组; 空 → null; 格式错 → 'ERR'
function parsePages(s) {
  if (!s.trim()) return null;
  const out = new Set();
  for (const part of s.split(/[,，]/)) {
    const m = part.trim().match(/^(\\d+)(?:\\s*[-~]\\s*(\\d+))?$/);
    if (!m) return 'ERR';
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a,b); i <= Math.max(a,b); i++) out.add(i);
  }
  return Array.from(out).sort((x,y)=>x-y);
}
async function doUpload() {
  const input = $('input').value.trim();
  if (!input) { $('input').focus(); return; }
  const allPages = $('allPages').checked;
  let pages = null;
  if (!allPages) {
    pages = parsePages($('pages').value);
    if (pages === 'ERR') { alert('分P范围格式不对, 示例: 1-47 或 1,3,5-8'); return; }
  }
  const btn = $('go');
  btn.disabled = true; btn.textContent = '上传中';
  lastTotal = 0;
  $('progress').hidden = false;
  $('running').hidden = false; $('finished').hidden = true;
  $('pErrs').hidden = true; $('pErrs').textContent = '';
  $('rawlog').textContent = '';
  $('pTitle').textContent = '正在上传'; $('pNow').textContent = '准备中';
  $('pCount').textContent = ''; $('pBar').style.width = '3%';
  try {
    const res = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ input, quality: $('quality').value, allPages, pages,
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
          step('✗ ' + j.msg, true);
          $('running').hidden = true; $('finished').hidden = false;
          $('pDone').innerHTML = '上传失败<span>请查看错误信息</span>';
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
