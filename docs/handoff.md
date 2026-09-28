# 交接文档 / Handoff（2026-09-28）

给下一个接手这个项目的会话看的。**先读这一份，再读其他文档。**

---

## 一、这个项目是什么

`dsh-agent-eval` 是一个 **DeepSeek Harness (dsh) 工具插件**，注册一个工具
`eval_run_dual`：跑「双后端对比评测」，用来回答**迁移接受门**的问题——
候选模型（如 `deepseek-flash`）能不能替代基线模型（如 `deepseek-v4-pro`）。

它的产出是**给迁移决策用的证据**，不是 benchmark 排名。

仓库：`/Users/mac/dsh-agent-eval`（个人独立仓库，非 git 远程托管）

---

## 二、当前状态

### 已完成

| 阶段 | 内容 | 证据 |
|---|---|---|
| v0.1 | 插件骨架：`defineTool` 注册、路径守卫、预算分发 | 离线回归第 1–8 组 |
| v1.0 | `runOneBackend` 真实实现：NDJSON 解析、断言、峰谷计价、优雅降级 | 离线回归全绿 |
| v1.0 | 整趟预算池（baseline 花钱后 candidate 用余额） | 离线第 9 组 + `budget-probe.yml` |
| v1.0 | **工作区快照**：baseline 后 / candidate 后各留一份物证 | 离线第 10 组 |
| v1.0 | 5 个多步套件（单步 / 两步 / 多文件 / 工具链 / 失败恢复） | `suites/multi-step/` |
| v1.0 | 波动测量协议 + 05 三次波动数据 | `docs/eval-design-constraints.md` 第三阶段 |
| v1.0 | **双后端对比数据 v1**（v4-pro vs flash，15 组，人工核对产物） | `docs/backend-comparison.md` 一~六节 |
| v1.0 | 成本渲染精度从 4 位改 6 位 | `src/compare-reporter.ts` |
| v1.1 | **产物断言**：6 种类型 + 三层安全边界 | `src/artifact-assert.ts`，离线第 11–12 组 |
| v1.1 | 5 个套件的 `assert` 全部改写为产物判据 | `suites/multi-step/*.yml` |
| v1.1 | **双后端对比 v2**：自动判定 + 6 位成本，并推翻 v1 的步数结论 | `docs/backend-comparison.md` 第七节 |
| v1.1 | **双后端对比 v3 + 三批次并列**：步数不稳定、成本稳定（15/15） | `docs/backend-comparison.md` 第八节 |
| v1.1 | 接受门判定分层定稿：**步数门删除**，只做批内对比 | `docs/acceptance-gate-design.md` 一、二节 |

**离线回归：12 组 75 项断言，全绿。** 这是唯一零成本的回归手段，改动后必跑。

### 未完成

| 待办 | 说明 |
|---|---|
| 接受门实现 | 判定逻辑已设计（`docs/acceptance-gate-design.md`），**未写代码** |
| 兼容性检查项 | system 字段格式、cache_control 忽略——**均为占位，未实现**，见该文档第五节 |
| 接受门端到端验证 | 需要一次真实模型调用（那时才动 key） |

### 产物断言已就绪（原「最大缺口」已补）

`src/artifact-assert.ts` 提供 6 种断言，`checkAssertions` 已接线。5 个套件的 `1/1`
现在**携带正确性信息**——不再是空壳护栏。

| 类型 | 用在哪 |
|---|---|
| `file_exists` / `file_not_exists` | 05：`FAILURE.md` 在、`config/deploy.json` **不在** |
| `file_content_contains` | 05：报告必须点出 `deploy.json` |
| `file_json_equals` | 04：`report.json` 语义等于 `{topSku:"B-207", qty:48}`（键序/空白无关） |
| `command_output_contains` / `command_output_equals` | 03 / 02：跑工作区内自检脚本比对 stdout |

安全边界三层：`shell: false`、解释器白名单 + argv 恰好 2 元素（挡 `node -e`）、
路径必须落在 `workspace` 内。**残留风险**：工作区脚本是模型改过的，执行它等于执行
模型代码——这与"允许 agent 在工作区跑代码"是同一件事，属套件固有边界。

### ⚠️ 最重要的一个发现：批次效应

三批次各相隔约 20 分钟、配置完全相同：

| 指标 | 三批次结果 |
|---|---|
| **步数** | **不稳定** —— 03 三批三个判定（v1 pro 多 / v2 flash 多 / v3 不显著），05 三批两个判定 |
| **成本** | **稳定** —— 5 套件 × 3 批次 = **15/15 判定完全一致**，无一例外 |

03 的 pro 批次中位是 `7 / 5 / 7`（批间极差 2），而它要测的差距本身只有 1–2 步
——**信噪比 ≈ 1，这个指标没有测量能力**。

**轮内零散度 ≠ 测量稳定。** 同一配置三批三个判定，说明 n=3 的"区间不重叠"判据
对批次漂移毫无抵抗力，**加大 n 也救不了**（得在同一批内加）。

→ **步数不进任何判据**（`docs/acceptance-gate-design.md` 的步数门已删除）；
→ **只做批内对比，输出相对值**（"同批内 flash 比 pro 少 N 步、成本低 M%"）；
→ 成本是唯一能跨批用的指标（差距来自**单价**，单价不随批次漂移）。

**不查根因**（服务侧不透明，查不出也控制不了），只在设计里规避。
详见 `docs/backend-comparison.md` 第七.3、八节。

### 已解决：成本精度（v1 遗留）

v1 的成本列取自 `toFixed(4)` 时代的渲染结果，flash 在 01 上真实成本 `0.00007`
被量化成 `0.0001`（相对误差 ~40%）。

**重新解析 NDJSON 无法改善它**：成本是以**渲染后的文本**存进 `tool_result.result`
的，`usage`/`cost` 没有落进外层 NDJSON（已核实 `tool_result` 只有
`type, callId, status, result` 四个字段）。只能重跑——**v2 就是这么做的**，
v2/v3 的成本列是 6 位精度。v1 的旧值原样保留在原文里，未追溯修改。

---

## 三、关键约束（不要违反）

1. **不改 `eval_run_dual` 的工具签名**（参数就是 `suite` 一个）
2. **不改 `compare-reporter.ts` 的 `SuiteResult` 接口**（冻结；要挂新数据就挂到
   `DualBackendReport` 报告层，快照就是这么做的）
3. **不引入新依赖**
4. **不引入 `dsh-eval-harness`**
5. **不提交原始 NDJSON**（里面有 key 的痕迹——理论上没有，但保险起见）
6. **不读 `~/.dsh/sessions/` 下的 trace**
7. **不把 API key 写进任何文件、log、`console.log`**

### Key 政策

- key 存在 `~/.zshrc` 的 **`ANTHROPIC_AUTH_TOKEN`**
- **`source ~/.zshrc` 取不到**（非交互 shell 提前 return），必须只 eval 那一行
- **作废时机**：接受门端到端跑通、`docs/handoff.md` 写完、所有数据入库——**那时才作废**

---

## 四、已知的 DSH 坑

### 插件开发

1. **相对导入必须带 `.js` 扩展名**。tsconfig 是 `moduleResolution: bundler`，
   tsc 不补扩展名，而 Node ESM 解析 `dist/` 时要求显式扩展名。
2. **`defineTool` 的 `output.schema` 是必填**，且 `additionalProperties` 必须显式写成
   `true`/`false`，否则 `UNSUPPORTED_SCHEMA`。
3. **`defineTool` 可以脱离宿主单独调用** —— 离线回归就靠这点。
4. **加载顺序靠服务依赖不靠文件顺序**：`export const inject = ['tools']`。
5. **`@deepseek-ai/cordis` 只 import type**（编译期擦除），运行时 `ctx` 由宿主传入。

### 路由与配置

6. **`ANTHROPIC_*` 环境变量对 dsh 是惰性的**（实测无效）。要换路由只能走 `--patch`。
7. **`--patch` 会整体替换目标行的整个 `config`**，不是深度合并。
8. **换模型必须同时 patch `agent-default-model` 那一行**，否则外层 agent 仍走旧模型。
9. **`--patch` 是启动器 flag，必须写在应用参数（`headless ...`）之前**。
10. **headless 需要独立 profile**，且该 profile 不能自带默认模型配置
    （会和每次注入的 patch 抢 `agent-default-model` 那一行）。
11. **bundle 的 `cordis.patch.yml` 里 `name` 是包名**，不是相对路径。

### 事件流（NDJSON）

12. **`tool_call` 事件形状是 `{type, callId, tool, input}`** —— 不是 `name`/`arguments`。
13. **`tool_result` 形状是 `{type, callId, status, result}`**，`result` 是渲染后的文本。
14. **提取必须按 `callId` 匹配**，不能取"最后一个非空 `tool_result`"——
    外层 agent 可能在你调完工具之后又去翻文件系统。
15. **截断**：单个字符串/对象键 **8 KiB**（截断后标 `truncated`），单行事件 **32 KiB**；
    **`final` 事件不设上限**。→ 想对长输出做断言要查 `final.text`，别查 `tool_result`。
16. **失败原因在 `turn_end.reason.error.message`**，只取 `kind` 会把 401 的详情丢掉。
17. **插件自己的 `console.log` 会混进 stdout**，解析时非 JSON 行要跳过而不是报错。

### 环境

18. **`os.tmpdir()` 在 macOS 是 `/var/folders/.../T`，不是 `/tmp`**。别猜快照路径，从报告里读。
19. **`DSH_EVAL_DSH_BIN` 是模块加载期常量** —— 换桩要换模块实例（用 `?case=N` 绕 ESM 缓存）。
20. **`session` 的 trace 是多 frame zstd**，Node 内置 zstd（sync 和 stream）**只解第一帧**。
    要读得靠 `zstd` CLI 或 python `zstandard`。（本项目的立场是**不读 trace**。）
21. **macOS 没有 `timeout` 命令**（exit 127）。
22. **沙箱**：`workspace-write` 允许写工作区根 + 平台临时目录；`approval.policy` 是 `ask`
    但**不阻断 headless 的工具调用**（实测）。

---

## 五、数据文件位置

| 文件 | 内容 |
|---|---|
| `docs/eval-design-constraints.md` | 四条设计约束 + 未验证的两条 + **第三阶段测量协议** |
| `docs/variance-2026-09-28.txt` | 第一轮波动汇总（v4-pro 自对比，单步） |
| `docs/multi-step-observation.md` | 5 套件观测跑 + **05 三次波动** + 两个污染点修法 |
| `docs/backend-comparison.md` | **v4-pro vs flash 双后端对比**（15 组） |
| `docs/acceptance-gate-design.md` | 接受门设计草案（未实现） |
| `docs/handoff.md` | 本文 |

**原始数据（未入库，在 `/tmp`，重启会丢）**：

| 位置 | 内容 |
|---|---|
| `/tmp/backend-compare/*.ndjson` | 15 组双后端对比（含 `.stderr`，全空） |
| `/tmp/backend-compare/run.sh` | 驱动脚本（含环境接线，不含 key） |
| `/tmp/backend-compare/extract.mjs` | NDJSON → 结构化指标提取器（按 callId 匹配） |
| `/tmp/multi-step-observation/` | 5 套件观测跑 + 首轮快照 |
| `os.tmpdir()/dsh-agent-eval-snapshots/` | 所有工作区快照，按套件+时间戳分目录 |

---

## 六、下一步待办

按优先级：

1. ~~补产物断言类型~~ → **已完成**（`src/artifact-assert.ts`，离线第 11–12 组）。
2. **实现两个兼容性检查项**（system 字段格式、cache_control 忽略）。
   **这是当前唯一的判定缺口**——它不实现，接受门永远只能输出「有条件迁移」。
3. **实现接受门**（新工具读报告做判定，不改 `eval_run_dual` 签名）。
   判定分层与采样规则已定稿（`docs/acceptance-gate-design.md`）。
4. **端到端验证接受门**（这时才需要 key）。
5. **key 作废**（文档已写完，只剩端到端验证需要它）。

**v1.5 想法（记录在案，本期不做）**：套件池扩到覆盖编码谱系（长上下文、多轮对话、
大范围重构、并发工具调用）；再跑一对模型（v4-pro vs Claude）验证
"成本差异稳定、步数差异不可复现"这个模式是否普遍。

---

## 七、一句话总结

**能用、有数据、有断言，判定规则已定稿。** 质量门（产物断言，已可自动判定）+
兼容性门（仍是空的）一票否决，成本门建议性（跨批稳定省 53–78%），
**步数门已删除**（同一配置三批三个判定，信噪比 ≈ 1，没有测量能力）。

批次效应**不查根因**（服务侧不透明），只在设计里规避：**只做批内对比，
输出相对值而非绝对值**。接受门可以动工了——第一步是实现两个兼容性检查项。
