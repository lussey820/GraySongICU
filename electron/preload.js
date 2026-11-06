// 歌词窗预加载：只暴露锁定开关与拖动，渲染层不接触 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GrayIPC', {
  setLock: v => ipcRenderer.send('lyric:set-lock', !!v),
  onLockState: fn => ipcRenderer.on('lyric:lock-state', (e, v) => fn(!!v)),
  setIgnore: v => ipcRenderer.send('lyric:set-ignore', !!v),
  dragStart: () => ipcRenderer.send('lyric:drag-start'),
  dragEnd: () => ipcRenderer.send('lyric:drag-end'),
});
