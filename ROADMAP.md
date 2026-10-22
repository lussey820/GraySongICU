# bili2ncm 定位与目标

> 本文档定义项目定位、当前进度与演进路线，作为开发的北极星。
> 每次大改动前先对照：这个改动是否在定位内？

---

## 一、项目定位（一句话）

**NeteaseCloudMusicApi 删库、weapi 通道失效后，一个仍能工作的网易云云盘上传器。**

具体而言：

- **专注一件事**：任意音频来源（目前是B站）→ 网易云音乐云盘
- **协议独立**：基于当前客户端在用的 eapi 通道（AES-128-ECB + MD5 签名），不依赖任何已死的老库
- **极简部署**：单文件、零依赖（仅 Node.js 内置模块）、双击即用级别
- **本地私密**：只监听 127.0.0.1，cookie 存本地文件，不做公网服务

### 与同类项目的差异

| | Melody | NeteaseCloudMusicApi 系 | bili2ncm |
|---|---|---|---|
| 协议 | weapi（已失效⚠️） | weapi（已失效⚠️） | **eapi（现行✅）** |
| 依赖 | Node+FFmpeg+npm | npm 全家桶 | **零依赖单文件** |
| 功能 | 多平台搜索/解锁/定时 | 全功能API | 只做链路上传 |
| cookie | 账号密码登录（风控严） | 账密/cookie | **cookie 直填** |

**差异化卖点 = 协议能用 + 部署极简**。功能广度不与 Melody 竞争。

---

## 二、当前进度（v0.1，2026-10-15）

### 已完成并实测 ✅

- [x] eapi 加解密全实现（请求加密 + 响应解密）
- [x] 云盘上传六步链路：check → alloc → lbs → 直传 → info/v2 → pub/v2
- [x] 云盘列表 `/api/v1/cloud/get`、删除 `/api/cloud/del`
- [x] B站 DASH 音频提取（view → playurl → 下载，音质自动选最高）
- [x] 上传+删除全流程**真实闭环验证**（测试文件传上去、列出来、删干净）
- [x] Web 界面：实时进度日志 / 云盘列表 / 删除按钮 / 免责声明
- [x] 多P批量逻辑（2秒风控间隔）+ 音质选择（best/192k/132k/64k，不可用自动降级）
- [x] cookie 页面配置（网易云 MUSIC_U / B站 SESSDATA）
- [x] 仅监听 127.0.0.1，cookie 文件被 .gitignore 排除
- [x] **B站→云盘端到端真实视频验证**（2026-10-15: BV1gHp46pER8 → 197kbps 音频 → 云盘 songId 确认）
- [x] CDN 故障转移：baseUrl 连接失败自动切换 backup_url（实测命中过）
- [x] **指定分P上传实测**（?p=N 参数真实视频验证）
- [x] **全部分P批量实测**（50P 合集：秒传跳过 / 真实上传 / 失败重试混合场景）
- [x] 秒传分支实测命中（needUpload=false 直接入库）
- [x] 入库失败自动重试（uploadStatus:9 为频率限制/同步延迟，5秒重试 100% 恢复）
- [x] 单P失败不中断批量 + 结束汇总（成功 X/Y）
- [x] 客户端中途断开保护（send 写失败静默，任务跑完不炸）
- [x] GitHub 私有仓库已推送（lussey820/bili2ncm）

### 关键实测发现

- **未登录 B 站也能拿到高音质音频**：实测无 cookie 时 playurl 返回 30280 (197kbps)，
  "未登录只有 64kbps"的旧说法不成立；SESSDATA 对音频上限的真实作用待进一步确认
- **B 站 DASH 的 baseUrl 经常连不上**（mcdn/edge CDN），backup_url 故障转移是必备而非可选
- **B 站 view 接口未登录时 pages 列表随机截断**：同一 50P 视频三次请求分别返回 1P/2P/50P。
  已加 videos 字段比对防御（提示"列表不完整，配置cookie可改善"）
- **网易云入库接口有频率限制**：连续上传时 info/v2 偶发 `uploadStatus:9, songDfsId:0`
  （存储同步延迟），等待 5 秒重试即可恢复；风控间隔已从 2 秒提升到 5 秒

### 已知未验证 ⚠️

- [ ] 指定 192k/132k 音质在不同账号状态下的边界表现未系统测试
- [ ] weapi 完全失效的结论仅基于 2026-10 实测，未持续跟踪

---

## 三、目标路线

### P0 — 达到"可开源"门槛（v0.2）✅ 已全部完成（2026-10-15）

- [x] 用真实多P视频完整跑通批量上传（50P合集实测：秒传/真实上传/失败重试混合）
- [x] B站 cookie 过期检测：playurl 返回 -101 时明确提示"SESSDATA 失效"并终止批量
- [x] 网易云 cookie 失效处理：eapi 响应 code 301 → 明确报"登录失效"，批量提前终止，不产生半成品
- [x] 失败重试：单P失败不中断批量（入库失败 5 秒重试一次），结束后汇总成功/失败清单
- [x] 上传历史（本地 history.json，.gitignore 排除）：记录时间/来源/歌曲/songId/大小，重复上传提示，上限 500 条
- [x] 日志安全审查：审查全部 send/错误透传/状态接口输出点，确认无 cookie 内容泄漏

### 多渠道调查结论（2026-10-15，QQ音乐/微云渠道搁置）

为评估"多渠道开源"价值做的完整调查，结论如下：

| 渠道 | 结论 | 原因 |
|---|---|---|
| 网易云云盘 | ✅ 主渠道（已完成） | eapi 通道全链路可用 |
| 微云（官方MCP） | ⚠️ 协议通但价值存疑 | OAuth2.0+PKCE+SHA1中间状态+分片轮询上传已全部打通（官方接口），**但 QQ音乐 App「微云音乐网盘」不索引外部写入的文件**：实测 4 个文件（含标准 MP3+ID3 / 标准重封装 M4A）放进微云「QQ音乐」文件夹均不显示——2022-2023 年"放微云文件夹当云盘歌曲"的技巧已失效，现在只索引 App 自家接口注册的记录 |
| QQ音乐云盘 | ❌ 搁置 | 无任何公开开源实现（GitHub 全网搜索确认，唯一"实现"系 AI 编造假端点）；官方 OpenAPI 无云盘上传能力；私有协议走 musics.fcg + zzd sign + qimei 指纹体系，逆向成本高出官方MCP一个数量级且有风控风险；绿钻容量限制（LV8 才 1GB） |
| 酷狗 | ❌ 放 P2 | 同样无公开协议 |

**决策**：多渠道暂缓，聚焦网易云主线。微云 MCP 上传协议代码保留存档（自定义可导出中间状态的 SHA1 实现 + 两阶段分片轮询，官方 OAuth 一年期 token），未来若腾讯恢复文件夹索引或出现官方开放能力可直接复用。

### P1 — 体验完善（v0.3）

- [x] B站合集（season）支持（2026-10-19）：合集页链接(sid+mid)走 `seasons_archives_list` 分页拉取；BV 属 ugc_season 时勾选"整个合集"展开上传（已实测罗翔合集接口 22 条全量拉通）
- [x] 批量粘贴（2026-10-19）：输入框改 textarea，多链接空白/逗号分隔，`runJobs` 顺序队列 + 5秒风控间隔 + 总汇总
- [x] 小改进（2026-10-19）：秒传命中显式反馈并计入汇总、DELETE /api/history 清空历史、/api/list 透出 maxSize 云盘容量（实测 60GB）、修正本节过时项
- [x] ffmpeg 可选检测（2026-10-19）：m4a 上传失败且非登录失效时，检测系统 ffmpeg → 临时文件转 mp3 → 重试一次；未装 ffmpeg 静默降级为提示（实测本机无 ffmpeg，路径待真机验证）
- [x] 表单记忆（2026-10-19）：localStorage 记音质/整理歌名/歌名/歌手；"上传全部""整个合集"为场景开关故意不记，防误触发大批量
- [ ] Releases 发布：GitHub Actions 打包 Windows exe（免 Node 环境运行）— 用户计划最后一步做

### P2 — 能力扩展（v1.0）

- [ ] 网易云歌单灰色歌曲解锁：歌单→变灰歌曲→B站搜索资源→上传→match 关联（对标 Melody 核心功能，eapi 版）
- [ ] 定时任务：每日自动解锁指定歌单
- [ ] Dockerfile
- [ ] 更多音频源：抖音链接
- [ ] 简易 i18n（中/英 README）

### 非目标（明确不做）

- ❌ 多平台曲库搜索/下载聚合（Melody 已做，不重复）
- ❌ 账号密码登录（只用 cookie，规避风控与账号安全风险）
- ❌ 公网部署支持/在线服务（保持本机工具属性）
- ❌ 音乐下载到本地的完整功能（只服务于上传链路）

---

## 四、开源检查单（转 Public 前过一遍）

- [ ] P0 全部完成
- [ ] README 定位描述与实际功能一致
- [ ] 免责声明存在且明确（页面 + README + LICENSE 旁）
- [ ] 全新环境从零跑通（clone → node server.js → 配cookie → 上传成功）
- [ ] 仓库内无任何 cookie/个人信息/调试文件
- [ ] 提交历史干净（无 "test" "tmp" 等垃圾提交，必要时 squash）

---

## 五、附：微云 MCP 上传协议存档（2026-10-15 实测打通，代码已清理）

> 渠道虽搁置，协议知识保留于此备查。endpoint: `https://www.weiyun.com/api/v3/mcpserver`，鉴权 `Authorization: Bearer <access_token>`，JSON-RPC `tools/call`。OAuth2.0+PKCE 公共客户端（token_endpoint_auth_methods:none，access_token 一年期）。

- **分块**：BLOCK_SIZE=512KB；`lastBlockSize=file_size%BLOCK_SIZE||BLOCK_SIZE`；`checkBlockSize=lastBlockSize%128||128`
- **block_sha_list**：共享一个 SHA1 实例流式 update，每个块后导出**内部寄存器 h0-h4 的小端序 hex（40字符）**（标准库做不了，需自实现）；最后一块的 sha 用**标准大端 digest**（=file_sha）
- **check_sha**：SHA1 处理到"最后一块去掉末尾 checkBlockSize 字节"时的中间状态（小端 hex）
- **check_data**：文件末尾 checkBlockSize 字节的 base64；file_md5 可选（秒传辅助）
- **上传循环**（关键：每轮**重新预上传**获取缺口通道，不是一次通道列表传到底）：
  1. 预上传（filename/file_size/file_sha/block_sha_list/check_sha/check_data/pdir_key）→ `file_exist=true` 即秒传完成
  2. 取 `channel_list` 中第一个 `len>0` 的通道，传 `upload_key+channel_list快照+channel_id+ex+file_data(base64)`（分片请求中 block_sha_list 传空数组）
  3. 响应 `upload_state`：1=继续 / 3=等待其他通道 / 2=完成；循环直到 2 或 file_exist
- **retcode 50000**（服务繁忙）等 2~5 秒重试，最多 3 次
- **QQ音乐云盘 = 微云根目录「QQ音乐」文件夹**（用户首次打开 App 云盘页时自动创建）；但 2026-10 实测 QQ音乐 App 不索引外部写入的文件，渠道搁置
- MCP 已知坑：list 的 `dir_key` 才是查目录参数（pdir_key 会被忽略）；search 参数名是 `key`；move_file 用 `dst_pdir_key`；delete 需完整对象数组（beta 有 bug）

---

## 六、原则

1. **零依赖是红线**：除非无法实现，否则不引入任何 npm 包
2. **单文件是特色**：server.js 之外不新增 .js 源码文件
3. **协议先行**：任何新功能先确认接口在 eapi 通道可用
4. **防御性低调**：不做自动化刷量类功能（刷歌/签到），避免项目被平台盯上
5. **个人使用边界**：所有功能默认服务于"本人收听"，不提供批量分发能力
