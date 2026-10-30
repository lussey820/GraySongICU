// GraySongICU 桌面歌词窗：无边框 + 透明 + 置顶，支持锁定（鼠标穿透）
const { app, BrowserWindow, screen, Tray, Menu, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'http://127.0.0.1:3210/desktop-lyrics';
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
    win.setIgnoreMouseEvents(locked);
    win.setFocusable(!locked);
    try { win.webContents.send('lyric:lock-state', locked); } catch (e) {}
    if (!locked) win.showInactive();
  }
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '解锁歌词（Ctrl+Alt+L）', enabled: locked, click: () => applyLock(false) },
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
    title: '网易云ICU 桌面歌词',
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
  win.once('ready-to-show', () => win.showInactive());
  win.on('moved', saveState);
  win.on('closed', () => { win = null; if (tray) { tray.destroy(); tray = null; } });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'icon.png'));
    tray.setToolTip('网易云ICU 桌面歌词');
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

  app.whenReady().then(() => {
    app.setAppUserModelId('com.grayicu.lyric');
    createWindow();
    createTray();
    // 锁定时窗口鼠标穿透，必须留一个全局快捷键用于解锁
    globalShortcut.register('CommandOrControl+Alt+L', () => applyLock(!locked));
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
