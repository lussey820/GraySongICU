# bili2ncm

**B站音频 → 网易云音乐云盘** · 单文件 · 零依赖 · 基于客户端 eapi 协议

> [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 删库、weapi 通道失效之后，社区里大量依赖它的云盘上传工具（包括基于它的二开项目）陆续不可用。
> 本项目是对**当前客户端仍在使用的 eapi 协议**的一次独立实现，只专注做好一件事：把 B 站视频的音频提取并上传到你的网易云音乐云盘。

## 特性

- **零依赖**：一个 `server.js`，只需要 Node.js（≥16），不需要 `npm install`、不需要 Docker、不需要 FFmpeg
- **协议新**：云盘全部操作走 `interface.music.163.com` 的 eapi 加密通道（AES-128-ECB + MD5 签名），这是当前 PC 客户端使用的协议
- **多 P / 批量上传**：勾选"上传全部分P"，自动逐个处理并带 5 秒风控保护间隔，单 P 失败自动重试不中断批量
- **音质选择**：最高 / 192k / 132k / 64k（不可用时自动降级）
- **双 cookie 失效检测**：网易云登录失效 / B 站 cookie 过期时明确提示并终止批量，不产生半成品
- **上传历史**：本地记录（上限 500 条），重复上传自动提示
- **Web 界面**：粘贴链接 → 实时进度日志 → 自动刷新云盘列表，支持在云盘列表直接删除
- **cookie 页面配置**：网易云 `MUSIC_U` 与 B 站 `SESSDATA` 都在页面里粘贴保存，无需改文件
- **仅监听本机**：默认 `127.0.0.1:3210`，不暴露到局域网

## 快速开始

```bash
node server.js
```

打开 <http://127.0.0.1:3210>：

1. 在「设置」中粘贴你的网易云 `MUSIC_U` cookie（见下方获取方法）→ 保存
2. （可选）粘贴 B 站 `SESSDATA` cookie 以解锁 192kbps 音质
3. 粘贴 B 站视频链接或 BV 号 → 上传

### 获取网易云 MUSIC_U

1. 浏览器登录 <https://music.163.com>
2. `F12` → `Application` → `Cookies` → `https://music.163.com`
3. 复制 `MUSIC_U` 的值，粘贴到本工具设置中

> `MUSIC_U` 等同于账号登录态：请勿泄露给他人；失效后（App 退出登录/改密码）重新获取一次即可。

### 获取 B 站 SESSDATA（可选）

1. 浏览器登录 <https://www.bilibili.com>
2. `F12` → `Application` → `Cookies` → 复制 `SESSDATA` 的值

不配置也可上传（实测未登录也能拿到 197kbps 音频），配置 SESSDATA 后音质上限更稳定。

## 工作原理

```
BV号 ──▶ B站 view 接口(标题/UP主/分P列表)
     ──▶ playurl 接口(fnval=16, DASH流) ──▶ 按音质选择 audio m4s
     ──▶ 下载音频 (需 Referer: bilibili.com)
     ──▶ 网易云云盘上传链路 (eapi):
          1. /api/cloud/upload/check      上传预检 → 临时songId + needUpload(秒传判定)
          2. /api/nos/token/alloc         分配对象存储 bucket/objectKey/token
          3. wanproxy.127.net/lbs         调度上传服务器
          4. POST {lbs}/{bucket}/{key}    文件直传 (x-nos-token 认证)
          5. /api/upload/cloud/info/v2    元数据入库 (歌名/歌手在此指定, 无需处理ID3)
          6. /api/cloud/pub/v2            发布
     ──▶ /api/v1/cloud/get               云盘列表 / /api/cloud/del 删除
```

关键协议参数（供学习参考）：

- eapi 加密：`AES-128-ECB(key='e82ckenh8dichen8')`，密文为 `nobody{path}use{json}md5forencrypt` 的 MD5 拼接格式，请求与响应均为加密/hex
- 上传预检参数：`{ bitrate:'999000', ext, length, md5, songId:'0', version:1 }`
- 对象存储桶：`jd-musicrep-privatecloud-audio-public`

## FAQ

**Q: 和 Melody / NeteaseCloudMusicApi 有什么区别？**
A: 它们基于 weapi 的老实现，2025 年后该通道已基本失效（请求返回空 body），且原仓库已删库。本项目是 eapi 的独立轻量实现。如果你需要搜索多平台曲库、灰色歌曲解锁等完整功能，建议关注这些项目的后续修复。

**Q: 支持哪些音频格式？**
A: B 站音频流本身是 m4a (AAC)，直接上传，无需转码。网易云云盘原生支持 m4a。

**Q: 上传后没有歌词/封面？**
A: 云盘上传仅存音频文件本身。可在网易云手机 App 中对云盘歌曲执行"关联歌曲"来匹配歌词与封面，这是平台能力限制。

**Q: 会触发风控吗？**
A: 多 P 批量上传时内置了 5 秒间隔保护，入库失败（频率限制）会等待 5 秒自动重试。请勿短时间内大批量上传，以免账号被限制。

## 目录结构

```
bili2ncm/
├── server.js            # 全部代码 (服务 + 协议实现 + 前端页面)
├── cookie.txt           # 网易云cookie (gitignore, 首次在页面保存)
├── bilibili_cookie.txt  # B站cookie (gitignore, 可选)
├── history.json         # 上传历史 (gitignore, 自动生成)
├── ROADMAP.md           # 定位与演进路线
├── LICENSE
└── README.md
```

## 免责声明

- 本项目仅供技术学习与研究使用，上传至云盘的内容**仅限本人收听**
- 请遵守哔哩哔哩、网易云音乐的用户协议、服务条款及相关版权法规
- 不得将本项目或其输出用于任何商业用途
- 使用本项目产生的一切后果由使用者自行承担

## 致谢

- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) — 曾经的社区基石，本项目协议思路的起点
- [Melody](https://github.com/foamzou/melody) — 同类功能项目，功能更全面（基于旧协议）
- [NeteaseCloudMusicApi Enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) — 上传流程参考

## License

[MIT](LICENSE)
