# GraySongICU 项目记忆

> 本文档沉淀项目开发全程的关键结论、协议知识与实测经验，供后续维护与二次开发参考。
> 更新于 2026-10-22。

---

## 一、项目定位

**NeteaseCloudMusicApi 删库、weapi 通道失效后，一个仍能工作的网易云云盘上传器。**

- 专注一件事：B站音频 → 网易云音乐云盘
- 协议独立：客户端现行 eapi 通道，不依赖已死老库
- 单文件 · 零依赖（仅 Node.js ≥16 内置模块）· 仅监听 127.0.0.1
- cookie 直填（不使用账密登录，规避风控）

## 二、网易云协议要点（eapi 通道）

- **加密**：AES-128-ECB，key = `e82ckenh8dichen8`；密文为 `nobody{path}use{json}md5forencrypt` 的 MD5 拼接格式；请求与响应均为加密/hex
- **域名**：`interface.music.163.com/eapi`（明文 /api 与 weapi 已全部失效）
- **登录态**：依赖 `MUSIC_U` cookie；eapi 返回 `code 301` = 登录失效，须明确提示并终止批量
- **云盘上传六步链路**：
  1. `/api/cloud/upload/check` — 预检（临时songId + needUpload 秒传判定）
  2. `/api/nos/token/alloc` — 分配对象存储（bucket = `jd-musicrep-privatecloud-audio-public`）
  3. `wanproxy.127.net/lbs` — 调度上传服务器
  4. `POST {lbs}/{bucket}/{key}` — 文件直传（x-nos-token 认证）
  5. `/api/upload/cloud/info/v2` — 元数据入库（歌名/歌手在此指定，无需处理ID3）
  6. `/api/cloud/pub/v2` — 发布
- **其他接口**：云盘列表 `/api/v1/cloud/get`、删除 `/api/cloud/del`
- **格式限制**：杜比全景声(30250)云盘不支持，需排除；m4a(AAC) 原生支持

## 三、B站协议要点

- view 接口取标题/UP主/分P列表 → playurl（fnval=16, DASH）按音质选 audio m4s → 带 `Referer: bilibili.com` 下载
- **未登录也能拿到高音质**：实测无 cookie 返回 30280 (197kbps)，"未登录仅64k"的旧说法不成立
- **CDN 随机故障**：mcdn/edge 源经常连不上，backup_url 故障转移是必备而非可选
- **分P列表随机截断**：未登录时同一 50P 视频可能只返回 1P/2P，需 videos 字段比对防御并提示配 cookie
- **cookie 失效**：playurl 返回 `-101` = SESSDATA 过期，须终止批量

## 四、实测经验与坑

- **秒传**：相同 md5 内容上传时 needUpload=false，跳过直传直接入库——重传同一合集极快
- **入库频率限制**：连续上传时 info/v2 偶发 `uploadStatus:9, songDfsId:0`（存储同步延迟），等 5 秒重试即恢复
- **风控间隔**：批量上传每首间隔 5 秒；单P失败不中断批量，结束汇总成功/失败
- **云盘列表同步延迟**：上传成功后列表接口可能短暂少显示几首，刷新即恢复
- **重复发布**：歌曲已在云盘时 pub/v2 会失败但返回歌曲信息，视为已存在
- **200MB 硬上限（2026-10-22 实测）**：云盘存储层单文件上限 = 209,715,200 字节；200MB+1KB 直传即返回 413
- **大文件分片绕过已否决**：NOS 分片协议本身可走通（首块响应体返回 `context`，后续块必须放在 URL query `&context=`，放 header 报 400 `does not contains Context, when offset = !0`；253MB 分 4 块全部 200），但随后 info/v2 对 >200MB 单曲返回非 JSON/400，整期入库失败。结论：必须拆成多个 ≤200MB 文件分别入库
- **大文件首次 info/v2 可能 504**：194MB 文件首次入库处理超过网关约 60 秒返回 HTML 504；此时文件已存进 NOS，稍后重试 info/v2 会 0.2 秒返回 200。故入库重试需覆盖"非 JSON 异常"，不能只判断 code

## 五、多渠道调查结论（2026-10，QQ/微云/酷狗均已搁置）

| 渠道 | 结论 | 原因 |
|---|---|---|
| 网易云云盘 | ✅ 主渠道（已完成） | eapi 通道全链路可用 |
| 微云（官方MCP） | ⚠️ 搁置 | OAuth2.0+PKCE+分片轮询协议已打通，但 QQ音乐 App 不索引外部写入微云「QQ音乐」文件夹的文件，只索引 App 自家接口注册的记录 |
| QQ音乐云盘 | ❌ 搁置 | 无任何公开开源实现；官方 OpenAPI 无此能力；私有协议（musics.fcg + zzd sign + qimei）逆向成本极高 |
| 酷狗 | ❌ P2 | 协议不稳定，接入性价比低 |

微云 MCP 上传协议完整存档见 ROADMAP.md 附录（512KB 分块、SHA1 中间态小端序、循环预上传轮询）。

## 六、前端设计共识（2026-10-19）

- 依据 ui-ux-pro-max 设计 skill 检索结论：**Minimalism & Swiss Style**（浅色极简瑞士风）
- 配色：浅灰底 `#f6f6f8` + 白卡片 + 网易云红 `#ec4141`（未采用 skill 推荐的深靛+绿/Poppins，与"网易云配色+朴素"诉求冲突）
- **UX 五规则已落地**：进度指示（批量按 [n/m] 精确驱动/单P按阶段推进）、空态带行动、错误态常驻、焦点可见（:focus-visible）、44px 触达
- 前端为 server.js 内嵌 PAGE 单页；`/api/upload` 支持 `pages` 数组（`1-47` / `1,3,5-8` 语法），优先级 pages > allPages > 单P

## 七、工程约定

- 智能歌名清洗默认开启：去序号/标签/前缀，拆分"歌手-歌名"，专辑字段传空
- 仅监听 127.0.0.1，不暴露公网；cookie/history 等凭证文件全部 .gitignore 排除
- 上传历史本地 history.json，上限 500 条，页面折叠展示
- 全部日志输出经安全审查，禁止泄漏 cookie 等敏感信息
- 零依赖是红线：除非无法实现，不引入任何 npm 包；单文件：server.js 之外不新增源码文件
- 设计参考稿 design/ 与协作工具产物 .workbuddy/ 不进 git

## 八、演进路线速览

- ✅ P0（可开源门槛）：双cookie失效检测、批量韧性、上传历史、日志安全审查
- ✅ 前端 v0.3 首项：浅色极简改版 + 分P范围
- ✅ P1 主体（2026-10-19）：B站合集（合集页链接 sid 走 seasons_archives_list 分页；BV 属 ugc_season 勾选"整个合集"展开，_inner 防递归）、批量粘贴多链接（runJobs 顺序队列+总汇总）、秒传显式反馈、DELETE /api/history、/api/list 透出 maxSize（实测 60GB）
- ⬜ P1 其余：仅 Releases 打包 exe（用户计划最后做）；ffmpeg 兜底 + 表单记忆已于 2026-10-19 完成
- ⬜ P2：歌单灰色歌曲解锁（思路已定：playlist privilege 识别灰歌 → wbi签名B站搜索时长匹配 → 复用上传链路 → /api/cloud/user/upload/match 关联，半自动防风控，match 端点待实测）、定时任务、Dockerfile、更多音频源
- ❌ 非目标：多平台曲库聚合、账密登录、公网部署、本地下载功能

### 合集/多任务要点（2026-10-19 实测）

- B站"50P"视频多为**单视频多分P**（view.ugc_season 为 null），与"合集"（多个独立视频）是两种结构，分P流程不受影响
- 合集页链接格式：`space.bilibili.com/{mid}/channel/collectiondetail?sid={season_id}`，缺 mid 会报错提示
- `seasons_archives_list` 返回 `data.meta.name/total` + `data.archives[].bvid/title`，每页最大 100；空间列表接口字段名是 `items_lists.seasons_list`（非 seasons）
