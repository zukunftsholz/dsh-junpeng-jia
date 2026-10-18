# 运行期验证计划（Lead 执行）

## 实测结果（2026-10-18，desktop profile，DSH 0.2.1-rc.2）

| 项目 | 结果 |
| --- | --- |
| `node scripts/verify.mjs` | 27 passed / 0 failed / 0 blocked |
| `node --test "test/*.test.mjs"` | 193 passed / 0 failed |
| `plugin_manager install_bundle` | `application: "applied"`，`dsh-junpeng-jia 0.1.0` |
| Config entry | `include:junpengjia` → `status: schema` |
| `plugins.detail.badge` | occupant `junpengjia-badge`（active） |
| `plugins.detail.section` | occupant `junpengjia-section`（active） |
| `plugins.tab` | occupant `junpengjia-tab`（active） |
| Agent 工具 | `junpengjia` 出现在 `Tool.listTools` |
| `action=status` | 运行时 `0.2.1-rc.2 (source: resolve)`，profile `desktop`，5 个第三方 bundle |
| `action=check dsh-zgit` | `green`，repo `zukunftsholz/dsh-zgit` |
| `action=check dsh-searxng` | `red`（5 项 fail：peer 越界 + bundle `incompatible-version` + `dsh.denied`） |
| `action=nudge dsh-searxng draft` | `drafted`，生成预填 issue URL |
| 再次 `nudge` | `duplicate`（30 天窗口生效） |
| 状态文件 | `<profile>\.junpeng-jia\state.json`，原子写、含去重签名 |
| UI 渲染 | 未人工确认（无浏览器控制），但客户端 bundle 已执行（三个槽位 occupant 均由 `registerUi` 注册且 active） |

已知限制：`dsh-reasoning-effort` 判定为 `yellow`（2 条 warn），属探测不确定，不触发催更。

---

## A. 静态门禁（无需安装）

```powershell
cd C:\dsh_projects\dsh-junpeng-jia
node scripts/verify.mjs
node --test "test/*.test.mjs"
```

> Node 24 rejects a bare directory argument (`node --test test/` → "Cannot find module ...\test");
> the quoted glob is the portable form. Node 20/22 accept both.

期望：`verify` 全绿；测试 0 fail（允许明确的 BLOCKED skip，但交付前必须清零）。

## B. 安装

目标 profile：`desktop`（`C:\Users\Mutou\.dsh\profiles\desktop`）。

```text
plugin_manager install_bundle
  target: C:\dsh_projects\dsh-junpeng-jia
```

判定只看返回体：

- `application: "applied"` → 已生效。
- `application: "restart-required"` → 记录原因，提示重启 Desktop。
- `application: "failed"` → 读 `error.diagnostic`，修复后重试；不覆盖用户 profile 的其他内容。

若工具调用被审批策略拒绝，则记录拒绝原文，并给出等价命令：

```text
dsh plugin --profile desktop add C:\dsh_projects\dsh-junpeng-jia
```

## C. 注册验证（免审批、只读）

1. `cordis_inspect_query` → Host `Config.listConfigs`，`name: "dsh-junpeng-jia"`：
   期望出现 entry，`status` 为 `schema`（可读 Config）且 `packageDir` 指向工作区。
2. `cordis_inspect_query` → Client `Slots.listSubTree`，分别以
   `plugins.detail.badge`、`plugins.detail.section`、`plugins.tab` 为 root：
   期望 `occupants` 出现 `junpengjia-badge` / `junpengjia-section` / `junpengjia-tab`。
3. `cordis_inspect_query` → Host `Tool.listTools`：期望出现 `junpengjia` 工具。

## D. 功能验证

1. 调用 agent 工具 `junpengjia {action:"status"}`：返回 runtimeVersion（应为 `0.2.1-rc.2`）
   与第三方 bundle 列表；等级不得全部为 `unknown`。
2. `junpengjia {action:"check", name:"dsh-zgit"}`：返回四层 Report；`dsh-zgit` 在 0.2.1-rc.2
   上应判定为 `green`（其 peer 范围覆盖 0.2.x）。
3. `junpengjia {action:"nudge", name:"dsh-zgit", mode:"draft"}`：因 grade 非 red，应返回
   `blocked` 且不产生 issue/网络请求；不得写历史记录为 filed。
4. 检查 `<profile>\.junpeng-jia\state.json` 是否被创建、是否原子写、是否无敏感字段。
5. 若时间允许，构造一个本地"故意不兼容"的 fixture bundle 安装后验证 red → draft 链接。

## E. UI 验证（无浏览器控制时）

- 只能验证到"slot 已注册 + Client bundle 已构建/加载"。
- 无法截图或点击；最终报告必须写明"渲染效果未人工确认"，并给出用户自查路径：
  设置/侧栏 → Plugins → 任一第三方插件详情页（badge + section）；Plugins → Compatibility 标签页。

## F. 回滚

```text
plugin_manager remove_bundle  target: dsh-junpeng-jia
```

并删除 `<profile>\.junpeng-jia\`（本插件自有状态，不影响其他插件）。
