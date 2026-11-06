// GraySongICU 桌面歌词窗：无边框 + 透明 + 置顶，支持锁定（鼠标穿透）
const { app, BrowserWindow, screen, Tray, Menu, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'http://127.0.0.1:3210/desktop-lyrics';
// 调试时才开 CDP, 正式运行不暴露调试端口
if (process.env.GRAYSONGICU_DEBUG_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.GRAYSONGICU_DEBUG_CDP);
}
let win = null;
let tray = null;
let locked = false;

function stateFile() {
  return path.join(app.getPath('userData'), 'lyric-window.json');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; }
}
function saveState() {
  if (!win) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch (e) {}
}

function applyLock(v) {
  locked = !!v;
  if (win && !win.isDestroyed()) {
    // 是否鼠标穿透由渲染层按"鼠标是否在歌词/按钮上"决定, 这里只同步锁定状态
    try { win.webContents.send('lyric:lock-state', locked); } catch (e) {}
    if (!locked) win.showInactive();
  }
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '解锁歌词（Ctrl+Alt+Shift+L）', enabled: locked, click: () => applyLock(false) },
    { label: '锁定歌词（鼠标穿透）', enabled: !locked, click: () => applyLock(true) },
    { type: 'separator' },
    { label: '隐藏歌词', click: () => { if (win) win.hide(); } },
    { type: 'separator' },
    { label: '退出桌面歌词', click: () => app.quit() },
  ]));
}

function createWindow() {
  const st = loadState();
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(Math.max(Number(st.width) || 900, 520), area.width);
  const h = Math.min(Math.max(Number(st.height) || 190, 120), area.height);
  const x = Number.isFinite(st.x)
    ? Math.min(Math.max(st.x, area.x), area.x + area.width - w)
    : Math.round(area.x + (area.width - w) / 2);
  const y = Number.isFinite(st.y)
    ? Math.min(Math.max(st.y, area.y), area.y + area.height - h)
    : area.y + area.height - h - 90;

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
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
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setMenu(null);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(APP_URL);
  // 默认整窗穿透, 鼠标移到歌词/按钮上时由渲染层发 IPC 关闭穿透
  win.webContents.on('did-finish-load', () => {
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {}
  });
  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', saveState);
  win.on('closed', () => { win = null; if (tray) { tray.destroy(); tray = null; } });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    tray.setToolTip('GraySongICU 桌面歌词');
    tray.on('click', () => {
      applyLock(false);
      if (win && !win.isDestroyed()) win.showInactive();
    });
    updateTrayMenu();
  } catch (e) { tray = null; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    applyLock(false);
    if (win && !win.isDestroyed()) win.showInactive();
  });

  ipcMain.on('lyric:set-lock', (e, v) => applyLock(v));
  ipcMain.on('lyric:set-ignore', (e, v) => {
    if (win && !win.isDestroyed()) {
      try { win.setIgnoreMouseEvents(!!v, { forward: true }); } catch (err) {}
    }
  });
  // 拖动窗口: 渲染层按下歌词文字 -> 主进程用全局光标位置跟随移动
  let dragTimer = null, dragFrom = null, dragWin = null;
  const endDrag = () => { if (dragTimer) { clearInterval(dragTimer); dragTimer = null; } dragFrom = null; };
  ipcMain.on('lyric:drag-start', () => {
    if (!win || win.isDestroyed()) return;
    endDrag();
    const cur = screen.getCursorScreenPoint();
    const b = win.getBounds();
    dragFrom = { x: cur.x, y: cur.y };
    dragWin = { x: b.x, y: b.y };
    dragTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !dragFrom) return;
      const c = screen.getCursorScreenPoint();
      win.setPosition(dragWin.x + (c.x - dragFrom.x), dragWin.y + (c.y - dragFrom.y));
    }, 16);
  });
  ipcMain.on('lyric:drag-end', endDrag);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.graysongicu.lyric');
    createWindow();
    createTray();
    // 锁定时窗口鼠标穿透，快捷键只作为备用（避开网易云 Ctrl+Alt+L 的"我喜欢"）
    globalShortcut.register('CommandOrControl+Alt+Shift+L', () => applyLock(!locked));
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
