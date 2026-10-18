# 交接文档 — dsh-junpeng-jia（给 Codex）

> 生成时间：2026-10-18 · 交接人：Team Lead（多智能体开发）· 接手人：Codex
> 状态：**功能已实现、已安装进 desktop profile、静态与运行期验证均通过；UI 视觉与真实 GitHub 自动提交尚未人工验收。**

## 0. 一句话现状

一个零构建的 DSH 插件（Host + Client 两半），在 Plugins 页为第三方插件提供「深度兼容性检测」与「分级催更（GitHub issue 草稿/自动提交）」。代码、契约、测试、验证文档齐备；剩余工作集中在**视觉验收、真实 GitHub 端到端、若干健壮性加固**。

## 0.1 发布信息（已推送）

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/zukunftsholz/dsh-junpeng-jia |
| 分支 | `main`（commit `1afb0d2`） |
| Tag | `v0.1.0`（annotated，指向同一提交） |
| 仓库布局 | **仓库根 = 插件包**（`package.json` 在根目录） |
| 安装（git） | `plugin_manager install_bundle {"target": "https://github.com/zukunftsholz/dsh-junpeng-jia"}` |
| 本地安装 | 已从仓库根重装并验证（`application: applied`），插件自报 repo `zukunftsholz/dsh-junpeng-jia` 且为 green |
| 打包产物 | `npm pack` 17 文件 / 59.7 kB（未上传 Release，按用户要求只推代码与 tag） |
## 1. 环境与运行时事实

| 事实 | 值 |
| --- | --- |
| DSH 版本 | `0.2.1-rc.2`（Desktop runtime `@deepseek-ai/dsh-desktop-runtime`） |
| Cordis / Loader | `4.0.5` / `1.0.6` |
| 目标 profile | `desktop`，`C:\Users\Mutou\.dsh\profiles\desktop` |
| Web GUI | `http://127.0.0.1:51811` |
| 工作区 | `C:\dsh_projects\dsh-junpeng-jia` |
| 安装形态 | `pnpm link:` → 插件目录是**工作区实时链接**，改代码后需重载 bundle 才生效 |
| 当前安装状态 | 已安装并启用；Config entry `include:junpengjia`，`status: schema` |
| 状态文件 | `<profile>\.junpeng-jia\state.json`（本次验证后已删除，去重窗口从零开始） |
| 已装第三方插件 | `dsh-zgit@0.2.2`、`dsh-searxng@0.4.0`、`dsh-sekaisync-connect@0.3.9-alpha`、`dsh-reasoning-effort@0.8.1`、`dsh-junpeng-jia@0.1.0` |

> 注意：本机 `dsh` 不在 PATH；不要尝试 `dsh ...` 命令。包管理一律走 `plugin_manager` 工具。

## 2. 交付物地图

```
仓库根 = 插件包（可直接按 git 地址安装）
  package.json        manifest + dsh.bundle.patch / dsh.client / engines.dsh / peerDependencies / repository
  cordis.patch.yml    插入行 id=junpengjia
  locale/{en,zh}.json 显示标题与描述（正式文案，不出现人名）
  icon.svg            64×64 盾牌+气泡
  README.md           安装、设置、隐私、验证、目录说明
  LICENSE             MIT
  lib/
    index.js          Host 入口：注册服务、agent 工具、plugin-manager/changed 失效
    config.js         Schemastery Config（含 .volatile() 可编辑项）
    contract.js       共享常量：命名空间、方法名、finding codes、默认值
    client.js         浏览器半侧（单文件）：badge / section / tab + TYPERT_REMOTE
    host/
      runtime.js      运行版本解析（config→app-boot→dsh→asar→env）+ profile 目录解析 + 包目录解析
      semver.js       零依赖 semver（含预发布参与匹配）
      inspect.js      四层检测引擎 + 分级 + 去重签名
      github.js       仓库解析、issue 生成、草稿 URL、GitHub API 提交与状态映射
      store.js        状态持久化（原子写、损坏备份、去重、历史、报告缓存）
      service.js      TypertRemoteService（namespace junpengjia，7 个方法）
docs/
  BLUEPRINT.md        设计蓝图 + 0.2.1-rc.2 新特性分析 + 官方准入语义
  API-CONTRACT.md     Host⇄Client 契约（方法、返回、分级表）
  VERIFY.md           验证计划 + 本次实测结果快照
  HANDOFF.md          本文档
scripts/verify.mjs    27 项静态门禁（负向控制已验证会红）
test/                 193 个 node:test 用例（semver/inspect/github/runtime）
```

## 3. 设计要点（改代码前必读）

### 3.1 双因素分级（唯一权威：`docs/API-CONTRACT.md` 分级表）

- **Factor A（插件侧）** = `manifest` + `resolution` + `symbols` 三层。
- **Factor B（运行时侧）** = DSH 自身准入：`compatibility.json` 豁免、未豁免的版本越界、Loader 真实 fiber 状态。
- **red 必须两侧都有 `fail`**；任一侧只有 `warn` 或单侧 fail → yellow；两侧通过 → green；运行时版本未知 → unknown。
- 只有 red 才 `eligible`，才允许催更。

### 3.2 官方准入语义（复刻 `dsh-app-boot`，勿改）

1. 声明了 `engines.dsh` → **只有它生效，peerDependencies 被忽略**；
2. 否则 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围必须全部匹配；
3. **预发布参与范围匹配**（`0.2.1-rc.2` 满足 `>=0.2.0-rc.1 <0.3.0-0`），不要用 node-semver 的 same-tuple 排除；
4. 空/非法 `engines.dsh` = 不兼容；两者都未声明 = 无约束（info）；
5. 豁免键是精确 `package@version` → 精确运行时版本列表。

### 3.3 四层检测（只读，不执行第三方代码）

| 层 | 数据源 | 典型 fail |
| --- | --- | --- |
| manifest | 包目录的 `package.json` | peer/engines 越界、patch 缺失、client.platform≠web |
| resolution | 运行时解析到的实际版本 | peer 无法解析/版本缺失 |
| symbols | 入口文本里的 `export const inject=[...]` + 活 `ctx.get(key)`；`dsh.client.external` vs `clientModules.graph()` | 服务缺失、external 模块不在图里 |
| activation | `pluginManager.listBundles/listPlugins` | row fiber failed、bundle error、unaddressable |

### 3.4 催更

- 仓库：`repository.url` / `bugs.url` / Config `repoOverrides`，仅 GitHub。
- 草稿：`https://github.com/<o>/<r>/issues/new?title=&body=`。
- 自动：`POST /repos/{o}/{r}/issues`，映射 401/403/404/410/422/429。
- 去重：`sha256(pkg@version|runtime|sorted fail codes|missing symbols)`，同 `(repo,pkg,signature)` 在 `renudgeAfterDays` 内只提一次；`maxIssuesPerDay` 限流。
- 隐私：issue 正文只含版本/平台/失败项/复现步骤；**不得**出现绝对路径、用户名、会话内容、token。

### 3.5 传输层（第三方零构建插件的关键）

Host 侧 `TypertRemoteService` + **手动** `Remote(name)` 打标（Node 无装饰器语法）；
Client 侧手写 `TYPERT_REMOTE` 描述符（strict codec 占位，网关只校验 `mode` 不调用 `create()`），
`ctx.remote.$mount()` 后在 `ctx.inject(['remote.junpengjia', ...])` 子 fiber 里注册 UI。
**所有 Remote 方法形参必须是单标识符**（SRC 回退按参数名解析）。

## 4. 验证方法（照抄即可）

```powershell
cd C:\dsh_projects\dsh-junpeng-jia
node scripts/verify.mjs
node --test "test/*.test.mjs"    # 注意：Node 24 不接受裸目录参数
```

期望：`27 passed, 0 failed`；`193 tests, 193 pass, 0 fail`。

运行期（免审批、只读）：

- `cordis_inspect_query` Host `Config.listConfigs` `{name:"dsh-junpeng-jia"}` → 应有 entry，`status: schema`
- Client `Slots.listSubTree` 分别以 `plugins.detail.badge` / `plugins.detail.section` / `plugins.tab` 为 root
  → occupants 应含 `junpengjia-badge` / `junpengjia-section` / `junpengjia-tab` 且 `active: true`
- Host `Tool.listTools` → 应含 `junpengjia`

功能（通过 agent 工具，与 UI 共用同一服务）：

```
junpengjia {action:"status"}
junpengjia {action:"check", name:"dsh-zgit"}
junpengjia {action:"nudge", name:"dsh-searxng", mode:"draft"}
```

**改完代码如何生效**：`plugin_manager set_bundle target=dsh-junpeng-jia enabled=false`，再 `enabled=true`。
不要手动改 profile 的 `package.json` / `cordis.patch.yml`，也不要跑 pnpm。

## 5. 本次实测基线（2026-10-18）

| 项 | 结果 |
| --- | --- |
| 静态门禁 | 27/27 |
| 单测 | 193/193 |
| 安装 | `application: applied` |
| 三个槽位 | 全部 occupant active |
| 运行时版本 | `0.2.1-rc.2`，source `resolve` |
| profile 显示 | `desktop` |
| dsh-zgit | green（repo `zukunftsholz/dsh-zgit`） |
| dsh-sekaisync-connect | green |
| dsh-reasoning-effort | yellow（2 warn） |
| **dsh-searxng** | **red**（peer 要求 `<0.2.0`；bundle `incompatible-version`；`dsh.denied`） |
| 催更草稿 | `drafted`，URL 可打开；正文无本机路径 |
| 二次催更 | `duplicate` |
| 状态落盘 | `<profile>\.junpeng-jia\state.json`，含 nudge 历史与签名 |

## 6. 集成期已修复的缺陷（回归红线，勿回退）

1. `runtime.js versionOf()` 必须同时接受 manifest 对象与裸版本字符串（`runtime.json` 的 `desktopVersion`）。
2. Host 进程可能**没有** `DSH_PROFILE_DIR` → `profileDirFromContext()` 多路探测（`ctx.baseDir`/`ctx.baseUrl`/`ctx.root.baseDir`/loader/pluginManager 属性/`DSH_HOME+DSH_PROFILE`）；解析失败时 store 退化为内存态而不是乱写盘。
3. `BundleInfo.source` 是 pnpm spec，**不是目录** → 必须 `resolvePackageDir(name, profileDir)`。
4. `dsh.client.inject` 只排序激活、可指向 baseline 模块 → **只校验 `dsh.client.external`**，否则全员误报。
5. 不要依赖 `ctx.registry` 内部结构 → 用 `ctx.get(key)` 判断服务是否存在。
6. `computeGrade`：red 必须双侧 fail；`warn` 永不升级为 red。
7. semver：预发布参与匹配；空 range 视为非法（不是通配）。
8. `draftUrl` 对空 owner/repo 必须返回 null，不得拼出 `https://github.com//r/...`。
9. `index.js` 只导出具名 `apply/Config/inject`，**不要**再加 default export（避免插件形态歧义）。

## 7. 已知问题与风险（按优先级）

### P0 — 需要人工/真实环境验收

1. **UI 视觉未确认**：无浏览器控制，只能证明槽位注册 active 与客户端 bundle 已执行。需人工在 `127.0.0.1:51811` 打开 Plugins 检查：badge 颜色/暗色主题、section 的按钮态、Compatibility 标签页空状态与长列表、中英文切换。
2. **自动提交未对真实 GitHub 跑过**：仅单测覆盖状态码映射。需用一个测试仓库 + PAT 做端到端（创建 issue、重复检测、429 退避）。当前 `autoNudge=false`、`draftOnly=true`，属安全默认。
3. **PAT 写入未在真实凭据服务上验证**：`setToken` 走 `ctx.credentials`，`credentialRef` 为动态 import + 纯字符串回退。需验证 `describe()` 能读到、重启后仍生效、且不出现在任何日志/状态文件。
4. **profile 目录解析是启发式**：desktop 上已正确；Web/CLI/自定义 profile 需复测。失败时去重窗口只在内存内有效。

### P1 — 产品缺口

5. 状态文件无跨进程锁：多 Host 同时写可能丢更新（原子 rename 只防半文件）。
6. 同一根因重复计数：`activation.bundle-error` 与 `dsh.denied` 常同源（searxng 5 条 fail 中 3 条同源），UI 应聚合展示。
7. `repoOverrides` 已在 Config/契约里，但 UI 无编辑入口（只能改 patch）。
8. 未实现「按仓库聚合/更新已有 issue」与「草稿一键复制」（当前只有 URL）。
9. `checkTimeoutMs` / `maxBundles` 只读且 UI 未展示；`maxIssuesPerDay` 只约束 auto，draft 不计数（设计如此，需在 UI 说明）。
10. `overview()` 全量串行扫描，插件多时首屏慢；可加并发上限与增量缓存。

### P2 — 打磨

11. i18n 仅 zh/en，locale key 无完整性 lint。
12. 图标无暗色变体（宿主默认图同样没有）。
13. README 已合并为仓库根单一文档（原 plugin/README 内容已并入）。

## 8. Codex 接手任务清单

**P0**
- [ ] 人工验收 UI 三项（badge / section / tab），记录截图或明确问题清单。
- [ ] 用测试仓库 + PAT 跑通 `mode:"auto"`：成功建 issue、重复时 duplicate、401/403/422/429 的可读报错、token 不入日志。
- [ ] 验证 `setToken` 在真实凭据服务的写入/读取/重启保持。
- [ ] 在 Web（非 desktop）组合复测 profile 目录与状态落盘。

**P1**
- [ ] 同源 finding 聚合（activation + dsh.denied 合并为一条主因）。
- [ ] `repoOverrides` 的 UI 编辑（走 Config `.volatile()` + `settings.update`）。
- [ ] 状态文件加锁（或退化为「仅单写者 + 读多写少」的显式约束）。
- [ ] overview 并发上限 + 短 TTL 缓存。
- [ ] 草稿一键复制 + 打开链接的 UI 动作。

**P2**
- [ ] locale key lint 加入 `scripts/verify.mjs`。
- [ ] 图标暗色变体。
- [ ] 文档合并。

## 9. 修改守则（不要做）

- 不要用 shell/pnpm 改 profile；只用 `plugin_manager`。
- 不要在 `lib/**` 里 import `@deepseek-ai/dsh-client-*`（版本漂移）。
- 不要执行第三方插件代码做探测（只读清单/入口文本/活服务表）。
- 不要向 session 追加自定义事件类型。
- 不要让 Remote 方法出现解构/默认值/rest 形参。
- 不要把 `warn` 升级为 red，也不要在 `engines.dsh` 存在时再看 peer。
- 不要把绝对路径、用户名、会话内容写进 issue 正文或状态文件。

## 10. 关键决策记录（用户已裁决）

| 议题 | 结论 |
| --- | --- |
| 检测深度 | 清单声明 + 运行时符号探测（不执行代码） |
| 催更通道 | 默认草稿；可开自动（PAT） |
| 触发策略 | 单侧=黄；双侧 fail=红并提交 |
| 去重 | 签名 + 30 天窗口（可配） |
| 交付 | 完整可安装 bundle + 装入 desktop profile |
| UI 命名 | 完全正式，不出现人名（包名/仓库名保留 `dsh-junpeng-jia`） |
| 分级补裁决 | red 必须双侧 fail；`warn` 不构成催更证据 |

## 11. 参考索引

- 官方扩展点：`@deepseek-ai/dsh-client-ui-plugin-manager` README（Detail page extension points / Page tabs）
- 官方准入语义：`@deepseek-ai/dsh-app-boot` README（Profiles）
- 零构建 Host⇄Client 范本：`C:\Users\Mutou\.dsh\profiles\desktop\node_modules\dsh-sekaisync-connect`
  （`lib/client.js` 的 TYPERT_REMOTE 与两段式挂载、`lib/deploy-service.js` 的手动 Remote 打标）
- 本仓库内：`docs/BLUEPRINT.md`、`docs/API-CONTRACT.md`、`docs/VERIFY.md`
