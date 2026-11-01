// 歌词窗预加载：只暴露锁定开关，渲染层不接触 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GrayIPC', {
  setLock: v => ipcRenderer.send('lyric:set-lock', !!v),
  onLockState: fn => ipcRenderer.on('lyric:lock-state', (e, v) => fn(!!v)),
  // 渲染层自己判断鼠标是否在歌词/按钮上，据此开关鼠标穿透
  setIgnore: v => ipcRenderer.send('lyric:set-ignore', !!v),
  dragStart: () => ipcRenderer.send('lyric:drag-start'),
  dragEnd: () => ipcRenderer.send('lyric:drag-end'),
});
