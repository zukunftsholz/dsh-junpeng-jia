# Junpeng Jia — 设计蓝图（DSH WebUI/Desktop 插件）

> 项目代号沿用需求给定的 **Junpeng Jia**（包名 `dsh-junpeng-jia`）。UI 文案保持正式，不出现人名卡片。

## 0. 需求判定（已与用户确认）

| 议题 | 结论 |
| --- | --- |
| 检测深度 | 清单声明 + 运行时符号探测（不执行第三方插件代码） |
| 催更通道 | 两者都做：默认生成 GitHub 预填草稿，可开启 PAT 自动提交 |
| 触发策略 | 分级：单侧问题=黄；双侧同时成立=红，红才可提交 |
| 去重 | 按 `(仓库, 插件, 不兼容签名)` 只提一次，30 天后可重提（可配置） |
| 交付 | 工作区完整可安装 bundle + 尝试安装进 desktop profile |
| 命名 | 包名/仓库名保留 Junpeng Jia；UI 全正式 |

## 1. 当前运行版本分析：0.2.1-rc.2

运行环境事实（本机实测）：

- Desktop runtime `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.2**，Cordis **4.0.5**，Loader **1.0.6**。
- Profile：`desktop`（`C:\Users\Mutou\.dsh\profiles\desktop`），已装第三方 bundle：
  `dsh-zgit@0.2.2`、`dsh-searxng@0.4.x`、`dsh-sekaisync-connect@0.3.9-alpha`、`dsh-reasoning-effort`。
- 目标插件在 profile 中声明 `dsh.bundle.patch`，由 `plugin_manager` 安装；Host 代码在进程内运行。

### 1.1 本插件必须用到的新特性（0.2.x 才有）

1. **Plugins 页扩展槽位**（`@deepseek-ai/dsh-client-ui-plugin-manager`）
   - `plugins.detail.badge`（list）：详情页标题后的标签，props 为 `{ subject }`。
   - `plugins.detail.section`（list）：详情页正文后的分区，props 为 `{ subject }`。
   - `plugins.detail.actions`（list）：详情页头部动作。
   - `plugins.tab`（list）：Installed 之后的新标签页，owner props 提供 `install()` / `openPackage()`。
   - `subject` 三种形态：`{kind:'bundle',pkg}`、`{kind:'row',pkg,row}`、`{kind:'item',id}`。
   - 这是"在第三方插件列表里加入检测与催更"的唯一正确落点：列表卡片 → 详情页 → badge + section。
2. **`pluginManager` Host 服务**（`@deepseek-ai/dsh-plugin-manager`）
   - `listBundles(): BundleInfo[]`：`name/version/official/installed/enabled/source/error/rows/availability`。
   - `listPlugins(): PluginInfo[]`：`entryId/moduleName/enabled/fiberPhase/patchId|readOnlyReason`。
   - `listVersionExemptions()` / `setVersionExemption()`：**DSH 自身的兼容性判断**与其豁免记录，
     是"双重因素"里 factor B 的官方数据源（`compatibility.json`）。
   - 拒绝码 `incompatible-version` + `IncompatiblePlugin{name,version,runtimeVersion,requirements}`。
3. **`plugin-manager/changed` 事件**：安装/启停/组合变化后刷新检测缓存。
4. **`clientModules` Host 服务**：`graph()` 给出浏览器模块图，用于校验 `dsh.client.inject` 依赖是否真实存在。
5. **Typert Remote（手写贡献）**：官方客户端是编译期生成，但第三方零构建插件可手写
   `TYPERT_REMOTE` 描述符 + `ctx.remote.$mount()`，在 `ctx.remote.junpengjia.*` 上暴露方法。
   本机 `dsh-sekaisync-connect` 已验证该路径在 0.2.1-rc.2 可用（strict codec 只校验 `mode`，
   不调用 `create()`；Host 侧 SRC 回退要求**单标识符形参**）。
6. **Host 侧手动打 Remote 标记**：`TypertRemoteService` + `Remote(name)` 装饰器的 ES 协议手动调用，
   无需构建步骤（`registerRemoteMethods` 模式）。
7. **`ctx.credentials`**：`credentialRef('JUNPENG_JIA_GITHUB_TOKEN')` + `set/resolve/describe/unset`，
   PAT 不进配置文件、不进会话日志。
8. **`ctx.settings.update` / Config `.volatile()`**：面板设置写回 profile 的 `cordis.patch.yml`。
9. **`ctx.webServer`**（可选降级通道）：若 typert 贡献在目标版本不可用，改用 `register({kind:'exact'})` 路由。
10. **`ctx.locale.register(ns, dicts)` + slot `locale` 选项**：中英文文案随 UI 语言切换。

### 1.2 官方兼容性准入语义（`dsh-app-boot` README 权威口径）

启动时 DSH 用 `getDshRuntimeVersion()` 返回的**单一运行时版本**判定每个包：

1. 若清单声明了 `engines.dsh`，**只有它生效，`peerDependencies` 被完全忽略**；
2. 否则，`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的每条 peer 范围都必须匹配；
3. **预发布版本参与范围匹配**（`0.2.1-rc.2` 可以满足 `>=0.2.0-rc.1 <0.3.0-0`）；
4. 两者都未声明 = 不施加约束；`engines.dsh` 为空/非法 = 不兼容；
5. 拒绝记录按 `engines.dsh` 或 DSH peer 包名给出 `IncompatiblePlugin{name,version,runtimeVersion,requirements}`；
6. 豁免存于 profile 的 `compatibility.json`，键为精确 `package@version` → 精确运行时版本列表。

本插件的检测引擎必须**复刻这套语义**（factor B 的判定依据），否则会与 DSH 自身结论矛盾。

### 1.3 明确不用的东西

- 不 import `@deepseek-ai/dsh-client-ui-primitives` 等 Harness Client 包（会随版本漂移）。
- 不向 session 追加自定义事件类型（会破坏会话重开）。
- 不在渲染期读别的插件的 DOM/样式。
- 不执行第三方插件代码做"探测"（只读清单、模块导出文本、Loader 真实状态）。

## 2. 架构

```
dsh-junpeng-jia (bundle)
├─ Host (Node, 进程内)
│  ├─ lib/index.js          apply(ctx, config)：注册服务 / 工具 / 事件
│  ├─ lib/config.js         Schemastery Config（volatile 设置项）
│  ├─ lib/host/runtime.js   运行版本 + 依赖解析（多路探测）
│  ├─ lib/host/semver.js    零依赖 semver range 判定
│  ├─ lib/host/inspect.js   四层检测引擎 → Report
│  ├─ lib/host/github.js    仓库解析 + issue 草稿/提交
│  ├─ lib/host/store.js     去重与催更历史（JSON，profile 内）
│  └─ lib/host/service.js   TypertRemoteService（namespace `junpengjia`）
└─ Client (浏览器)
   └─ lib/client.js         槽位注册：badge / section / tab + 组件与样式
```

### 2.1 检测引擎（四层，只读）

| 层 | 内容 | 判定 |
| --- | --- | --- |
| L1 manifest | `engines.dsh`、`peerDependencies`（`@deepseek-ai/*`）、`dsh.bundle.patch` 存在性、`dsh.client.platform` | 硬失败 |
| L2 resolution | 每个 peer 依赖在本机运行时的实际解析版本；缺失/越界 | 硬失败 |
| L3 symbols | 从入口产物静态提取 `export const inject=[...]`，与活 Context 的服务表比对；`dsh.client.inject` 与 `clientModules.graph()` 比对 | 硬失败 |
| L4 activation | `fiberPhase==='failed'`、bundle `error`、`readOnlyReason`、被禁用 | 证据 |

**双重因素**：

- **Factor A（插件侧）** = L1+L2+L3 的 fail/warn 汇总。
- **Factor B（DSH 自身判断）** = `compatibility.json` 豁免状态 + 启动准入（未豁免的越界=拒绝）
  + Loader 真实装载状态。
- **等级**：A、B 都出现 `fail` → **red（可催更）**；其余非全通过组合（含 `warn` 参与）→ **yellow**；
  都通过 → **green**。`warn` 表示探测不确定，不构成"向维护者催更"的证据，因此不能把另一侧的 `fail` 升级为 red。

### 2.2 催更

- 仓库来源：`package.json.repository.url`（`git+https://github.com/owner/repo.git`）或 `bugs.url`；
  只接受 GitHub；支持 Config 里的 `repoOverrides` 手工映射。
- 内容：环境（DSH 版本/平台/OS/Node）、插件（名/版本/仓库）、失败项表格（code + expected/actual）、
  DSH 准入结论、复现步骤、建议修复方向、生成器声明。**不含本机路径、用户名、会话内容**。
- 模式：
  - `draft`（默认）：生成 `https://github.com/<o>/<r>/issues/new?title=&body=` 预填链接，UI 打开 + 可复制。
  - `auto`（显式开启 + 已配置 PAT）：`POST /repos/{owner}/{repo}/issues`，处理 401/403/404/410/422/429。
- 去重：`signature = sha256(pkg@version|runtime|sorted(fail codes)|missing symbols digest)`，
  记录 `(repo, pkg, signature)`；同键 30 天内不重复；`renudgeAfterDays` 可配。
- 频率上限：`maxIssuesPerDay`（默认 3）。

### 2.3 UI

1. **详情页 badge**：`Compatible` / `Needs attention` / `Incompatible` / `Not checked`，颜色用状态 token。
2. **详情页 section**：等级摘要、运行时版本、四层结果、逐条 finding、按钮「深度检测」「生成催更草稿」
   （auto 模式显示「提交 issue」）、最近一次催更记录。
3. **Plugins 新标签页「Compatibility」**：列出全部第三方 bundle 的等级与操作，
   「全部检测」按钮；空状态说明检测口径。
4. 全部文案走 `ctx.locale`（zh/en），样式只用 `--dsw-alias-*` 主题 token。

### 2.4 数据

- 设置：Cordis `Config`（profile patch 可覆盖）+ `ctx.settings.update` 在线保存。
- 状态：`<profile>/.junpeng-jia/state.json`（去重键、历史、缓存报告），原子写、损坏可降级重建。
- PAT：`ctx.credentials`，引用名 `JUNPENG_JIA_GITHUB_TOKEN`。

## 3. 契约（Host ⇄ Client）

Remote 命名空间 `junpengjia`，服务键 `junpengjia`，方法（单标识符形参）：

- `overview()` → `{ runtimeVersion, runtimeSource, profile, checkedAt, settings, bundles[] }`
- `inspect(name)` → `{ ok:true, report } | { ok:false, error }`
- `nudge(name, mode)` → `{ ok:true, outcome:'drafted'|'filed'|'duplicate'|'blocked', url?, number?, message } | { ok:false, error }`
- `settings()` → `SettingsView`
- `saveSettings(patch)` → `{ ok, settings }`
- `setToken(token)` → `{ ok, tokenConfigured }`
- `history()` → `{ entries[] }`

Agent 工具：`junpengjia`，参数 `{ action: 'status'|'check'|'nudge', name?, mode? }`，与 UI 共用同一服务方法。

## 4. 失败模式

| 情况 | 行为 |
| --- | --- |
| 运行版本探测失败 | `runtimeSource` 标注 `unknown`，等级降为 `unknown`，禁止自动提交 |
| 无 `repository` / 非 GitHub | badge 正常显示，催更按钮禁用并说明原因 |
| 网络失败 | 草稿链接仍生成；auto 模式返回可读错误，不重试刷屏 |
| PAT 未配置 | auto 模式自动降级为 draft，并提示 |
| 状态文件损坏 | 备份为 `.corrupt-<ts>` 后重建 |
| 检测超时 | 单插件 5s 预算，超时项标记 `skip`，不阻塞列表 |

## 5. 团队与验收

| 角色 | 负责 | 写作用域 |
| --- | --- | --- |
| Lead | 蓝图、清单、locale/icon、契约、集成、安装验证、最终审查 | `docs/`、`package.json`、`cordis.patch.yml`、`locale/`、`icon.svg`、`lib/contract.js` |
| host-engine | 检测引擎、运行版本解析、semver、GitHub 客户端、去重存储、Remote 服务、Agent 工具 | `lib/index.js`、`lib/config.js`、`lib/host/` |
| client-ui | badge / section / tab、组件、样式、i18n 绑定 | `lib/client.js` |
| qa-verify | 单测、fixture、静态校验脚本、安装验证、README | `test/`、`scripts/`、`README.md` |

验收标准：

1. `node --check` 全部通过；`node test/*.test.mjs` 全绿。
2. `plugin_manager install_bundle` 返回 `application: applied`（若审批被拒则如实记录并给出命令）。
3. `cordis_inspect_query` 能看到新插件的 slot 注册（badge/section/tab）。
4. UI 在 127.0.0.1:51811 刷新后可见（无浏览器控制时如实标注）。
5. 对一个真实第三方插件跑出非 unknown 的 Report，且 `inspect` 幂等。
