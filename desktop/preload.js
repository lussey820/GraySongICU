// 歌词窗预加载：只暴露锁定开关，渲染层不接触 Node
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GrayIPC', {
  setLock: v => ipcRenderer.send('lyric:set-lock', !!v),
  onLockState: fn => ipcRenderer.on('lyric:lock-state', (e, v) => fn(!!v)),
});
