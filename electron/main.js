// GraySongICU 桌面外壳：启动本机服务、主窗口、托盘与桌面歌词
const { app, BrowserWindow, Tray, Menu, screen, globalShortcut, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Electron 在某些开发启动方式下 app.isPackaged 也会返回 true,
// 用主进程代码是否在 app.asar 内判断更可靠
const IS_PACKAGED = __dirname.includes('app.asar');
const DEV_ROOT = path.resolve(__dirname, '..');
// 打包后服务端和图标放在 resources 根目录；开发时就是仓库根目录
const RES_ROOT = IS_PACKAGED ? process.resourcesPath : DEV_ROOT;
const SERVER_JS = path.join(RES_ROOT, 'server.js');
const ICON = path.join(IS_PACKAGED ? process.resourcesPath : __dirname, 'icon.png');
// 打包后用户数据写到 %APPDATA%\GraySongICU；开发时沿用项目目录，方便复用现有 cookie
const DATA_DIR = IS_PACKAGED ? path.join(process.env.APPDATA || app.getPath('appData'), 'GraySongICU') : DEV_ROOT;
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const MAIN_LOG = path.join(DATA_DIR, 'main.log');
// 登录凭据用系统 DPAPI 加密保存, 明文 cookie 不再落盘
const COOKIE_ENC_FILE = path.join(DATA_DIR, 'cookie.enc');
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');
let cookieStore = { ncm: '', bili: '' };
const LYRIC_STATE = path.join(DATA_DIR, 'lyric-window.json');
// 离线歌词组件默认放在用户数据目录, 避免安装到 Program Files 后无写权限
const EXE_DIR = path.dirname(process.execPath);
const ASR_PACK_DIR = IS_PACKAGED ? path.join(DATA_DIR, 'asr-pack') : '';
const ASR_ASKED = IS_PACKAGED ? path.join(DATA_DIR, '.asr-asked') : '';
// 安装器里勾选了「离线补歌词」时写入的标记, 首次启动看到就自动下载
const ASR_REQUEST = IS_PACKAGED ? path.join(EXE_DIR, '.asr-request') : '';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { if (IS_PACKAGED) app.setPath('userData', DATA_DIR); } catch (e) {}

let mainWin = null, tray = null, lyricWin = null, locked = false;
let isQuitting = false, serverProc = null, serverPort = 0, hookPort = 0, hookServer = null, logStream = null;
let balloonShown = false;
let dragTimer = null, dragFrom = null, dragWin = null;

function logLine(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try { fs.appendFileSync(MAIN_LOG, line); } catch (e) {}
  try { if (logStream) logStream.write(line); } catch (e) {}
}
// 日志轮转: 单个超过 5MB 就改名归档, 归档超过 90 天自动删除
function logStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function rotateLog(file) {
  try {
    if (fs.statSync(file).size <= 5 * 1024 * 1024) return;
    fs.renameSync(file, file.replace(/\.log$/, '-' + logStamp() + '.log'));
  } catch (e) {}
}
function cleanOldLogs(dir, keepDays) {
  try {
    const limit = keepDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^(main|server)-\d{8}-\d{6}\.log$/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > limit) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}
process.on('uncaughtException', e => logLine('主进程异常: ' + (e && e.stack || e)));
process.on('unhandledRejection', e => logLine('未处理 Promise: ' + (e && e.stack || e)));

// 首次启动时自动建桌面/开始菜单快捷方式, 让用户不用找 exe
function ensureShortcut() {
  if (!IS_PACKAGED) return;
  const opts = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: 'GraySongICU 音乐工具',
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: 'com.graysongicu.app',
  };
  const targets = [
    path.join(app.getPath('desktop'), 'GraySongICU.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GraySongICU.lnk'),
  ];
  for (const lnk of targets) {
    try {
      const exists = fs.existsSync(lnk);
      if (exists) {
        let cur = null;
        try { cur = shell.readShortcutLink(lnk); } catch (e) {}
        // 已经指向当前程序就不用重写
        if (cur && cur.target && path.resolve(cur.target) === path.resolve(process.execPath)) continue;
      }
      shell.writeShortcutLink(lnk, exists ? 'replace' : 'create', opts);
      logLine('已创建快捷方式: ' + lnk);
    } catch (e) {
      logLine('创建快捷方式失败: ' + (e && e.message || e));
    }
  }
}

// 单选一个空闲端口，避免 3210 被占用时启动失败
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function waitPort(port, timeoutMs = 25000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - started > timeoutMs) return reject(new Error('本机服务启动超时'));
        setTimeout(tick, 300);
      });
      s.setTimeout(1500, () => s.destroy());
    };
    tick();
  });
}

// ---------- 登录凭据加密 ----------
function legacyCookiePaths(name) {
  return [path.join(DATA_DIR, name), path.join(path.dirname(DATA_DIR), name)];
}
function deleteLegacyCookies(name) {
  for (const p of legacyCookiePaths(name)) {
    try { fs.unlinkSync(p); } catch (e) {}
  }
}
function persistCookieStore() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    fs.writeFileSync(COOKIE_ENC_FILE, safeStorage.encryptString(JSON.stringify(cookieStore)));
    return true;
  } catch (e) {
    logLine('登录凭据加密保存失败: ' + (e && e.message));
    return false;
  }
}
function prepareCookies() {
  // 优先读加密文件; 再迁移旧的明文 cookie
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const obj = JSON.parse(safeStorage.decryptString(fs.readFileSync(COOKIE_ENC_FILE)));
      cookieStore = { ncm: String(obj.ncm || ''), bili: String(obj.bili || '') };
    } catch (e) { /* 没有加密文件, 走下面的迁移 */ }
  }
  let migrated = false;
  if (!cookieStore.ncm) {
    for (const p of legacyCookiePaths('cookie.txt')) {
      try { cookieStore.ncm = fs.readFileSync(p, 'utf8').trim(); if (cookieStore.ncm) { migrated = true; break; } } catch (e) {}
    }
  }
  if (!cookieStore.bili) {
    for (const p of legacyCookiePaths('bilibili_cookie.txt')) {
      try { cookieStore.bili = fs.readFileSync(p, 'utf8').trim(); if (cookieStore.bili) { migrated = true; break; } } catch (e) {}
    }
  }
  if ((cookieStore.ncm || cookieStore.bili) && persistCookieStore()) {
    deleteLegacyCookies('cookie.txt');
    deleteLegacyCookies('bilibili_cookie.txt');
    if (migrated) logLine('已把明文登录凭据迁移为系统加密存储');
  } else if (migrated) {
    logLine('系统加密不可用, 登录凭据仍以明文保存');
  }
}
function saveCookieSecure(kind, value) {
  if (kind !== 'ncm' && kind !== 'bili') return { ok: false, error: '未知的登录类型' };
  cookieStore[kind] = String(value || '').trim();
  if (!persistCookieStore()) return { ok: false, error: '系统加密不可用' };
  deleteLegacyCookies(kind === 'ncm' ? 'cookie.txt' : 'bilibili_cookie.txt');
  return { ok: true };
}

// 服务端通过这个本机钩子开关歌词窗，避免再启动第二套 Electron
function startHookServer() {
  return new Promise((resolve, reject) => {
    hookServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method !== 'POST') { res.statusCode = 404; res.end('{"ok":false}'); return; }
      if (String(req.headers['x-gsi-hook-token'] || '') !== HOOK_TOKEN) {
        res.statusCode = 403; res.end('{"ok":false}'); return;
      }
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { u = null; }
      if (!u) { res.statusCode = 400; res.end('{"ok":false}'); return; }
      if (u.pathname === '/lyric/open') { res.end(JSON.stringify(openLyricWindow())); return; }
      if (u.pathname === '/lyric/close') { closeLyricWindow(); res.end(JSON.stringify({ ok: true, running: false })); return; }
      if (u.pathname === '/lyric/state') { res.end(JSON.stringify({ ok: true, running: !!(lyricWin && !lyricWin.isDestroyed()) })); return; }
      if (u.pathname === '/cookie/set') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 16384) req.destroy(); });
        req.on('end', () => {
          try {
            const { kind, value } = JSON.parse(body);
            res.end(JSON.stringify(saveCookieSecure(kind, value)));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
          }
        });
        return;
      }
      res.statusCode = 404;
      res.end('{"ok":false}');
    });
    hookServer.on('error', reject);
    hookServer.listen(0, '127.0.0.1', () => {
      hookPort = hookServer.address().port;
      resolve();
    });
  });
}

async function startServer() {
  serverPort = await freePort();
  cleanOldLogs(DATA_DIR, 90);
  rotateLog(MAIN_LOG);
  rotateLog(LOG_FILE);
  prepareCookies();
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  serverProc = spawn(process.execPath, [SERVER_JS], {
    cwd: RES_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GRAYSONGICU_PORT: String(serverPort),
      GRAYSONGICU_DATA_DIR: DATA_DIR,
      GRAYSONGICU_APP_DIR: RES_ROOT,
      GRAYSONGICU_ASR_DIR: ASR_PACK_DIR,
      GRAYSONGICU_LYRIC_HOOK: 'http://127.0.0.1:' + hookPort,
      GRAYSONGICU_HOOK_TOKEN: HOOK_TOKEN,
      GRAYSONGICU_VERSION: app.getVersion(),
      GRAYSONGICU_NCM_COOKIE: cookieStore.ncm,
      GRAYSONGICU_BILI_COOKIE: cookieStore.bili,
    },
  });
  serverProc.stdout.on('data', d => logStream && logStream.write(d));
  serverProc.stderr.on('data', d => logStream && logStream.write(d));
  serverProc.on('error', e => logLine('服务启动失败: ' + (e && e.message)));
  serverProc.on('exit', (code, signal) => {
    serverProc = null;
    if (isQuitting) return;
    logLine('服务退出 code=' + code + ' signal=' + signal);
    dialog.showErrorBox('GraySongICU 服务已停止', '本机服务意外退出，请重新打开应用。\n\n日志：' + LOG_FILE);
    isQuitting = true;
    app.quit();
  });
  await waitPort(serverPort);
  logLine('服务已就绪 http://127.0.0.1:' + serverPort);
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.show();
  mainWin.focus();
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'GraySongICU',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWin.setMenu(null);
  mainWin.loadURL('http://127.0.0.1:' + serverPort + '/');
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || isQuitting) return;
    logLine('页面加载失败 ' + code + ' ' + desc + ' ' + url);
    dialog.showErrorBox('页面加载失败', '主界面没有加载成功，请重新打开应用。\n\n日志：' + LOG_FILE);
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1:' + serverPort)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  mainWin.on('close', e => {
    if (isQuitting) return;
    e.preventDefault();
    mainWin.hide();
    if (tray && !balloonShown) {
      balloonShown = true;
      try { tray.displayBalloon({ title: 'GraySongICU', content: '已最小化到托盘，双击图标可重新打开' }); } catch (err) {}
    }
  });
}

function loadLyricState() {
  try { return JSON.parse(fs.readFileSync(LYRIC_STATE, 'utf8')); } catch (e) { return {}; }
}
function saveLyricState() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  try { fs.writeFileSync(LYRIC_STATE, JSON.stringify(lyricWin.getBounds())); } catch (e) {}
}

function applyLock(v) {
  locked = !!v;
  if (lyricWin && !lyricWin.isDestroyed()) {
    try { lyricWin.webContents.send('lyric:lock-state', locked); } catch (e) {}
    if (!locked) lyricWin.showInactive();
  }
  updateTray();
}

function openLyricWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.showInactive();
    return { ok: true, running: true };
  }
  const st = loadLyricState();
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.max(Number(st.width) || 900, 520), area.width);
  const h = Math.min(Math.max(Number(st.height) || 190, 120), area.height);
  const x = Number.isFinite(st.x)
    ? Math.min(Math.max(st.x, area.x), area.x + area.width - w)
    : Math.round(area.x + (area.width - w) / 2);
  const y = Number.isFinite(st.y)
    ? Math.min(Math.max(st.y, area.y), area.y + area.height - h)
    : area.y + area.height - h - 90;
  lyricWin = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    thickFrame: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'GraySongICU 桌面歌词',
    icon: ICON,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  lyricWin.setMenu(null);
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  lyricWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lyricWin.loadURL('http://127.0.0.1:' + serverPort + '/desktop-lyrics');
  lyricWin.webContents.on('did-finish-load', () => {
    try { lyricWin.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
    try { lyricWin.webContents.send('lyric:lock-state', locked); } catch (e) {}
  });
  lyricWin.once('ready-to-show', () => {
    if (lyricWin && !lyricWin.isDestroyed()) lyricWin.showInactive();
  });
  lyricWin.on('moved', saveLyricState);
  lyricWin.on('closed', () => { lyricWin = null; updateTray(); });
  updateTray();
  return { ok: true, running: true };
}

function closeLyricWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    try { lyricWin.close(); } catch (e) {}
  }
  lyricWin = null;
  updateTray();
}

function buildTrayMenu() {
  const lyricOpen = !!(lyricWin && !lyricWin.isDestroyed());
  return Menu.buildFromTemplate([
    { label: '打开主界面', click: showMain },
    { type: 'separator' },
    { label: lyricOpen ? '关闭桌面歌词' : '开启桌面歌词', click: () => { lyricOpen ? closeLyricWindow() : openLyricWindow(); } },
    { label: '解锁歌词（Ctrl+Alt+Shift+L）', enabled: lyricOpen && locked, click: () => applyLock(false) },
    { label: '锁定歌词（鼠标穿透）', enabled: lyricOpen && !locked, click: () => applyLock(true) },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
    { label: '退出 GraySongICU', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(ICON);
    tray.setToolTip('GraySongICU');
    tray.on('click', showMain);
    tray.on('double-click', showMain);
    updateTray();
  } catch (e) {
    tray = null;
    logLine('托盘创建失败: ' + (e && e.message));
  }
}

// ---------- 首次启动: 询问是否安装离线补歌词组件 ----------
function apiJson(method, apiPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : '';
    const r = http.request({
      host: '127.0.0.1', port: serverPort, path: apiPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('本机服务返回异常')); } });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('本机服务没有响应')));
    if (data) r.write(data);
    r.end();
  });
}
function msgBox(opts) {
  return (mainWin && !mainWin.isDestroyed()) ? dialog.showMessageBox(mainWin, opts) : dialog.showMessageBox(opts);
}
function asrInstalled() {
  return !!(ASR_PACK_DIR
    && fs.existsSync(path.join(ASR_PACK_DIR, 'whisper', 'whisper-cli.exe'))
    && fs.existsSync(path.join(ASR_PACK_DIR, 'ggml-base.bin')));
}
function setTaskProgress(v) {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(v); } catch (e) {}
}
async function watchAsrInstall() {
  const started = Date.now();
  while (!isQuitting && Date.now() - started < 20 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    let s = null;
    try { s = await apiJson('GET', '/api/asr/status'); } catch (e) { continue; }
    if (!s) continue;
    if (s.installing) {
      if (s.total) setTaskProgress(Math.min(1, Number(s.loaded) / Number(s.total)));
      continue;
    }
    setTaskProgress(-1);
    if (s.ready) {
      msgBox({ type: 'info', title: '离线补歌词已就绪', message: '以后遇到没有歌词的歌，点「补时间轴」就能自动补上。' });
    } else if (s.error) {
      msgBox({ type: 'warning', title: '离线补歌词没有装好', message: '不影响正常使用，之后可以到「补时间轴」里重新下载。', detail: String(s.error) });
    }
    return;
  }
  setTaskProgress(-1);
}
async function startInstallAsr() {
  try {
    if (tray && !tray.isDestroyed()) {
      try { tray.displayBalloon({ title: 'GraySongICU', content: '正在下载离线补歌词组件（约 150MB），期间可以正常使用' }); } catch (e) {}
    }
    const started = await apiJson('POST', '/api/asr/install', {});
    if (!started || !started.ok) throw new Error((started && started.error) || '下载没有启动');
    if (!started.ready) await watchAsrInstall();
  } catch (e) {
    logLine('离线组件安装失败: ' + (e && e.message || e));
    setTaskProgress(-1);
    msgBox({ type: 'warning', title: '离线补歌词没有装好', message: '不影响正常使用，之后可以到「补时间轴」里重新下载。', detail: String((e && e.message) || e) });
  }
}
async function askInstallAsr() {
  if (!IS_PACKAGED) return;
  if (asrInstalled()) {
    // 安装器可能勾选过离线组件, 但本机已经有了, 清掉标记避免残留
    if (ASR_REQUEST && fs.existsSync(ASR_REQUEST)) {
      try { fs.unlinkSync(ASR_REQUEST); } catch (e) {}
    }
    return;
  }
  // 安装器里勾选过「离线补歌词」: 首次启动不再追问, 直接开始下载
  if (ASR_REQUEST && fs.existsSync(ASR_REQUEST)) {
    logLine('安装时已勾选离线补歌词, 自动开始下载');
    try { fs.unlinkSync(ASR_REQUEST); } catch (e) {}
    try { fs.writeFileSync(ASR_ASKED, ''); } catch (e) {}
    return startInstallAsr();
  }
  if (fs.existsSync(ASR_ASKED)) return;
  logLine('首次启动: 询问是否安装离线补歌词组件');
  const r = await msgBox({
    type: 'question',
    title: '离线补歌词（可选）',
    message: '要不要安装「离线补歌词」？',
    detail: '有些歌没有歌词。安装后可以让电脑自己听一遍，补上歌词和时间轴。\n\n'
      + '大约 150MB，只下载一次，保存在用户数据目录。\n\n'
      + '现在不装也没关系，上传、音质和正常歌词都不受影响。',
    buttons: ['现在安装（约 150MB）', '以后再说'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (r.response !== 0) {
    logLine('用户选择: 以后再说');
    try { fs.writeFileSync(ASR_ASKED, ''); } catch (e) {}
    return;
  }
  logLine('用户选择: 安装离线补歌词组件');
  return startInstallAsr();
}

// 歌词窗拖动：渲染层按下歌词文字后，主进程跟随鼠标移动窗口
function endDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragFrom = null;
}
ipcMain.on('lyric:set-lock', (e, v) => applyLock(v));
ipcMain.on('lyric:set-ignore', (e, v) => {
  if (lyricWin && !lyricWin.isDestroyed()) {
    try { lyricWin.setIgnoreMouseEvents(!!v, { forward: true }); } catch (err) {}
  }
});
ipcMain.on('lyric:drag-start', () => {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  endDrag();
  const cur = screen.getCursorScreenPoint();
  const b = lyricWin.getBounds();
  dragFrom = { x: cur.x, y: cur.y };
  dragWin = { x: b.x, y: b.y };
  dragTimer = setInterval(() => {
    if (!lyricWin || lyricWin.isDestroyed() || !dragFrom) return;
    const c = screen.getCursorScreenPoint();
    lyricWin.setPosition(dragWin.x + (c.x - dragFrom.x), dragWin.y + (c.y - dragFrom.y));
  }, 16);
});
ipcMain.on('lyric:drag-end', endDrag);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.graysongicu.app');
    try {
      ensureShortcut();
      logLine('启动阶段: 启动歌词钩子');
      await startHookServer();
      logLine('启动阶段: 启动本机服务');
      await startServer();
      logLine('启动阶段: 创建主窗口');
      createMainWindow();
      createTray();
      globalShortcut.register('CommandOrControl+Alt+Shift+L', () => applyLock(!locked));
      logLine('启动完成');
      setTimeout(() => { askInstallAsr().catch(e => logLine('询问离线组件失败: ' + (e && e.message || e))); }, 1200);
    } catch (e) {
      logLine('启动失败: ' + (e && e.stack || e && e.message || e));
      dialog.showErrorBox('GraySongICU 启动失败', '应用没有启动成功。\n\n' + (e && e.message || e) + '\n\n日志：' + LOG_FILE);
      isQuitting = true;
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    try { globalShortcut.unregisterAll(); } catch (e) {}
    // 退出时销毁托盘, 避免通知区域留下残影
    if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch (e) {} }
    tray = null;
    if (lyricWin && !lyricWin.isDestroyed()) { try { lyricWin.destroy(); } catch (e) {} }
    if (serverProc) { try { serverProc.kill(); } catch (e) {} }
    if (hookServer) { try { hookServer.close(); } catch (e) {} }
    if (logStream) { try { logStream.end(); } catch (e) {} }
  });

  // 主窗口关闭时只是隐藏到托盘，不退出应用
  app.on('window-all-closed', () => {});
}
