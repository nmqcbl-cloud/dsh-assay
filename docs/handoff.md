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
| v1.0 | **双后端对比数据**（v4-pro vs flash，15 组） | `docs/backend-comparison.md` |
| v1.0 | 成本渲染精度从 4 位改 6 位 | `src/compare-reporter.ts` |

**离线回归：10 组 41 项断言，全绿。** 这是唯一零成本的回归手段，改动后必跑。

### 未完成

| 待办 | 说明 |
|---|---|
| **产物断言类型** | ⚠️ **接受门最大缺口。** 见下 |
| 接受门实现 | 判定逻辑已设计（`docs/acceptance-gate-design.md`），**未写代码** |
| 兼容性检查项 | system 字段格式、cache_control 忽略——**均为占位，未实现** |
| 接受门端到端验证 | 需要一次真实模型调用（那时才动 key） |

### ⚠️ 最重要的一个缺口

`checkAssertions`（`src/eval-runner.ts:257`）**只有两种断言**：`output_contains`、
`max_steps`。**没有一种能查工作区产物。**

但 5 个套件验证"任务做对了没有"靠的全是产物（`main.mjs` 输出 PASS、
`report.json` 内容、`FAILURE.md` 与 `deploy.json` 的存在性）。

→ **5 个套件里的 `1/1` 不携带正确性信息**，那个 `1/1` 只是 `max_steps: 20` 护栏没触发。
`docs/backend-comparison.md` 里的 24/24 是**人工核对快照**得出的，不是自动判定的。

实现接受门之前必须先补产物断言类型，详见 `docs/acceptance-gate-design.md` 第四节。

### 一个刚发现、尚未处理的遗留

`docs/backend-comparison.md` 的成本列取自 `toFixed(4)` 时代的渲染结果——
flash 在 01 上真实成本约 `0.00007` 被量化成 `0.0001`（相对误差 ~40%）。

**重新解析 `/tmp/backend-compare/` 下的 NDJSON 无法改善它**：成本是以**渲染后的文本**
存进 `tool_result.result` 的，`usage`/`cost` 这类结构化字段没有落进外层 NDJSON。
要拿到 6 位精度只能重跑那 15 组（内层约 ¥0.36、约 5 分钟）。

实际影响有限（成本门的判定方向是"更便宜/不更便宜"，4 位足够给出方向），
但**要报"节省百分比"就不够**。下次跑对比时用新渲染即可。

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

1. **补产物断言类型**（`file_exists` / `file_absent` / `file_json_equals` /
   `command_output_equals`）。**这是接受门的前置条件**，没有它接受门判不了质量门。
   补完后给 5 个套件写真正的断言，替换掉现在只有 `max_steps: 20` 的空壳。
2. **实现接受门**（新工具读报告做判定，不改 `eval_run_dual` 签名）。
3. **实现两个兼容性检查项**（system 字段格式、cache_control 忽略）。
4. **端到端验证接受门**（这时才需要 key）。
5. **`docs/handoff.md` 更新** + key 作废。

**v1.5 想法（记录在案，本期不做）**：套件池扩到覆盖编码谱系（长上下文、多轮对话、
大范围重构、并发工具调用）；再跑一对模型（v4-pro vs Claude）验证
"成本差异显著、步数差异罕见"这个模式是否普遍；查清 05 基线散度（pro 步数 6–10、
输入 token 差 2 倍）的成因。

---

## 七、一句话总结

**能用、有数据、缺断言。** 判定逻辑已经由真实数据定型（质量门看产物、
兼容性门看静默失败、成本门建议性、步数门仅供参考），
但**把"产物判据"变成可自动执行的断言这件事还没做**——那是下一个会话的第一件事。
