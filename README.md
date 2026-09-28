# dsh-migration-eval

> **把一个 Agent 从 Claude 切到 DeepSeek，你怎么知道能不能切？**
> 这个工具回答的就是这一个问题 —— 它是一座**迁移接受门**。
>
> A **migration acceptance gate** for DeepSeek Harness (dsh): dual-backend
> comparison evaluation that answers "can we switch?" — not "which model is better?"
> MIT licensed.

注册一个 dsh 工具 `eval_run_dual`：同一套件下跑**双后端对比**，
输出判定（`可迁移` / `有条件迁移` / `不可迁移` / `不判定`）+ 风险清单。

---

# 第一部分：用户指南

## 它回答什么问题

| 它回答 | 它**不**回答 |
|---|---|
| 候选模型**能不能**替代基线模型 | 哪个模型**更好**（那是 benchmark 的活） |
| 换过去会**丢什么**（产物判据） | 该不该换（无跨模型的价值判断） |
| 换过去**省多少钱**（成本门） | —— |
| **还差什么**没验证（风险清单） | —— |

## 安装

```sh
# 1. 装进一个 dsh profile（在插件的父目录执行 —— 相对路径锚定调用目录）
dsh plugin --profile eval-runner add dsh-migration-eval

# 2. 确认注册成功
dsh --profile eval-runner --dump-config | grep dsh-migration-eval
# 启动时也应看到：[dsh-migration-eval] registered "eval_run_dual" — listed=true
```

> **尚未发布到 npm？** 用本地路径装：`dsh plugin --profile eval-runner add ../dsh-migration-eval`，
> 或在包目录里先 `pnpm build` 再 `npm pack` 拿到 tgz 后 `add ./dsh-migration-eval-1.1.0.tgz`。

> **headless 需要独立 profile**，且该 profile 不能自带默认模型配置 ——
> 插件会按套件 YAML 现生成路由 patch 去填 `agent-default-model` 那一行，两者会抢。

## 跑一次

```sh
eval "$(grep -E '^export ANTHROPIC_AUTH_TOKEN=' "$HOME/.zshrc")"   # 或你自己的 key 来源
export DEEPSEEK_API_KEY="$ANTHROPIC_AUTH_TOKEN"
unset ANTHROPIC_AUTH_TOKEN

dsh --profile eval-runner headless --json \
  "只调用 eval_run_dual，suite 填 multi-step/05-failure-report，拿到结果后原样输出，不要做任何其他操作"
```

**环境接线有三个坑**（都实测踩过）：

1. **`ANTHROPIC_*` 环境变量对 dsh 是惰性的**（实测无效）。唯一生效的机制是
   `--patch` 声明式路由，插件已内部生成。所以要把 key 的值**改名**成
   `apiKeyEnv` 里声明的那个变量（本仓库套件用 `DEEPSEEK_API_KEY`）。
2. **`source ~/.zshrc` 取不到 key**（非交互 shell 提前 return）—— 必须只 `eval` 那一行。
3. **变量后面不要紧跟全角标点**（写 `${suite}，` 而不是 `$suite，`）——
   zsh 会把多字节字符吃进变量名，`set -u` 下直接报 unbound variable。

## 输出长什么样

真实运行输出（`multi-step/05-failure-report`，**v1.0 交付跑，探针尚未实现**）：

> ⚠️ 这是一份**历史输出**，逐字未改。里面 `cache_control 使用` 显示 **⚠️ 未检测**，
> 是 v1.0 的实情 —— 当时只能静态判，所以判定被压在「有条件迁移」。
> **v1.1 起默认会跑探针**（下面紧跟的就是它的真实输出）。
> 保留原文是因为它是**真的跑出来的**，改掉就成编的了。

v1.1 起同一处长这样（**2026-09-29 真实运行**，`multi-step/01-single-step`，
`dsh --profile eval-runner headless --json`，探针默认开启）：

```
🔒 兼容性门
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  system 字段格式       ✅ 通过
    ↳ 将以内容块数组发送 system（[{type:'text', text}]，pi-ai 在 anthropic-messages 下无条件如此）；端点 https://api.deepseek.com/anthropic 自称 Anthropic 兼容
  cache_control 使用    ✅ 通过
    ↳ 端点兑现了前缀缓存。带标记分支：第 1 次 cache_write=0 / cache_read=0，第 2 次（同一前缀）cache_read=2304；但**对照分支（不发 cache_control）第 2 次也命中**（cache_read=2304）—— 说明该端点有自动前缀缓存，命中无法归因给显式标记。对迁移的结论不变：缓存会生效、成本优势成立；只是这份优势不依赖 cache_control 标记。（本项探针实耗输入 10100 / 输出 4 token —— 探针不是零 token，静态两项才是）
──────────────────────────────────────────────
✅ 兼容性门全部已检测且通过
```

**这一行是本项目最关键的一个结论**：端点接受并兑现前缀缓存，但**功劳属于它自己的
自动缓存，`cache_control` 的边际贡献为零**。详见
[`docs/v1.1-release.md`](docs/v1.1-release.md) 第四节。

（`01-single-step` 是环境探针套件，所以判定仍是 `➖ 不判定`。要看判定变成 `✅ 可迁移`，
跑 `multi-step/02`–`05` 里任意一个，或参考 v1.0 那份输出把这一行换成上面的。）

```
🎯 迁移判定：⚠️ 有条件迁移
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
风险清单：
  ℹ️  成本门：基于历史区间数据（n=9，3 个批次），候选省 53.2%；单次跑给不出区间，故采信历史数据
  ⚠️  cache_control 使用：静态检查无法判定端点是否兑现，需 v1.1 探针请求（实测缓存命中率在 0%–99% 间波动）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 双后端评测对比
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
指标            deepseek-v4-pro deepseek-flash
──────────────────────────────────────────────
通过率           1/1             1/1
输入Token       63606           58121
输出Token       1681            1681
成本(USD)       0.005946        0.001655
成本(CNY)       0.042219        0.011748
平均步数          9.0             8.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 成本说明：以上为 USD，按谷时/峰时计价（谷时半价）；CNY 按 1 USD ≈ 7.1 CNY 折算
通过率变化：+0.0%
成本节省：72.2%
Token变化：-8.4%
✅ 无回退用例

🔒 兼容性门
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  system 字段格式       ✅ 通过
    ↳ 将以内容块数组发送 system（[{type:'text', text}]，pi-ai 在 anthropic-messages 下无条件如此）；端点 https://api.deepseek.com/anthropic 自称 Anthropic 兼容
  cache_control 使用    ⚠️ 未检测
    ↳ harness 必然发送 cache_control（系统块 / 末条消息 / 末个工具，retention 默认 short），但端点是否据此建立前缀缓存**无法静态判定**。旁证（不等于判定，且自身就不稳定）：多批次连续运行时输入 token 的 94–99% 按命中价计费，而一次相隔数小时的孤立运行是 **0% 命中**（成本恰好等于全价）—— 缓存会过期，冷启动必然全价。另：DeepSeek 本身有自动前缀缓存，无法把功劳归给显式标记。`cache_control` 的真实效力因此只能靠 v1.1 的探针请求验。
──────────────────────────────────────────────
⚠️ 存在未检测项 → 本趟最多判定「有条件迁移」
   未检测项：cache_control 使用
   （"未检测"不等于"通过"——静态检查判不了运行时行为）

📁 工作区快照（两次运行共用一个工作区，分别留证）
  baseline 后：/var/folders/.../after-baseline
  candidate 后：/var/folders/.../after-candidate
```

**报告的读法**：

- **判定在最顶部。** 三个门各说各话是数据面板，压成一个结论才是决策工具。
- **`⚠️ 未检测` 与 `✅ 通过` 是两回事。** "我们没查"绝不显示成"查过了没问题"。
- **`01-single-step` 会显示 `➖ 不判定`** —— 它是环境探针，不是质量判据。
- **步数只记录、不判定。** 它没有测量能力，见下。

## 三个门

| 门 | 性质 | 判什么 |
|---|---|---|
| **质量门** | 一票否决 | 工作区**产物**判据（文件存在/不存在、JSON 语义相等、命令输出） |
| **兼容性门** | 一票否决 | `system` 字段格式（静态，零 token）+ `cache_control` 使用（**探针请求**） |
| **成本门** | **建议性，从不否决** | 候选成本显著更低 |
| ~~步数门~~ | **已删除** | 没有测量能力，只作诊断字段 |

### 兼容性门里的探针请求（v1.1）

`cache_control` 由 harness 运行时生成、每次请求必发，**配置文件里根本没有它可查** ——
"扫配置"式检查恒返回"没扫到"，而它其实每次都在发，那是个**假通过**。所以这一项
改为真发请求：向候选端点发 **4 个**，两分支对照（带 `cache_control` / 不带，各发两次同一前缀）。

**为什么要对照组**：只看"第二次请求命中了"证明不了是标记起的作用 ——
DeepSeek 这类端点自带自动前缀缓存。没有对照，得到的结论是"缓存生效了"，
而不是"标记生效了"。四种组合各有确定含义，见 `src/cache-probe.ts` 头部。

**它的两种负面结果分属两个范畴，处置不同**（这是本工具最容易被误读的一处）：

| 探针发现 | 判定 | 为什么 |
|---|---|---|
| 端点**拒收** `cache_control`（HTTP 4xx） | ❌ **不可迁移**（一票否决） | **正确性**问题：harness 每次请求必发它，拒收等于一次对话都发不出去 |
| 端点**接受但不兑现**前缀缓存 | ✅ 通过 + ℹ️ 风险，**不否决** | **成本**问题：请求发得出去、任务做得完，只是省钱的优势不成立。把成本写进否决是**范畴错误** |

**探针不是零 token**（静态两项才是）：4 个请求、每次前缀约 2.5k token，实耗会写进
报告那一项的 `detail` 里。想一分钱不花就跑：套件里写 `probe_cache_control: false`，
或设环境变量 `DSH_EVAL_NO_PROBE=1`（离线回归与 CI 用的就是这个）。两者都只会让判定
**更保守**（退回「未检测」，最多「有条件迁移」），不会多报"通过"。

**探针大约多花 2–5 秒**（两个分支并行，冷热之间必须等 2 秒）。那 2 秒不是保守估计，
是实测要求：端点把缓存**写进去**到让下一次请求**读得到**之间有延迟，
紧贴着发第二次会读到 `cache_read=0` —— 而缓存其实是好的。详见 `src/cache-probe.ts` 头部。

**每次探针用新前缀**（种子带当次的随机量）。固定前缀会让第二次运行的"冷"请求
直接命中上一次留下的缓存，既观察不到缓存的**建立**，也可能在端点已经停止缓存时
仍然报"生效"——那是个假通过。

判定顺序：

```
① 质量门有失败项？          → 不可迁移
② 兼容性门有 fail 项？      → 不可迁移（与质量门/成本门结果无关）
③ 兼容性门有 not_checked？  → 有条件迁移
④ 其余（两门全过）          → 可迁移
```

**成本门为什么不否决**：一个把任务做错的模型可能非常便宜，一个贵 3 倍的模型也可能
完全正确。把成本写进否决是**范畴错误** —— 它决定"值不值得迁"，不决定"能不能迁"。

## 为什么要读一下「设计约束」

这个工具的核心论点不是"我实现了三个门"，而是 **"只做批内对比"**：

- **步数没有测量能力。** 同一配置、相隔 20 分钟的三批次，套件 03 给出**三个不同的
  判定**（pro 多 / flash 多 / 不显著）。而它要测的差距本身只有 1–2 步 —— **信噪比 ≈ 1**。
- **成本是唯一能跨批使用的指标。** 三批次 5 套件 **15/15 判定完全一致**，
  因为它来自**单价**（配置常量），不随批次漂移。
- **绝对成本跨轮不可比**（前缀缓存有 TTL；实测命中率在 0%–99% 间波动），
  可比的是**同一趟内两列的相对关系**。

批次效应**查不出根因也控制不了**（源于模型服务侧：路由、负载、缓存状态）。
所以设计上不查，只规避：**只做批内对比，输出相对值而非绝对值。**

完整论证、原始数据、以及"为什么每条限制都是设计边界而不是 TODO"，
见 [`docs/v1-release.md`](docs/v1-release.md) 与
[`docs/backend-comparison.md`](docs/backend-comparison.md)。

## 套件

| 目录 | 用途 |
|---|---|
| `suites/multi-step/01`–`05` | 5 个套件：单步 / 两步 / 多文件 / 工具链 / 失败恢复 |
| `suites/dual-backend/basic.yml` | 最小示例（单步问答） |

套件是 YAML，可自行增删。顶层字段：

```yaml
name: "套件名"
budgetCNY: 2              # 整趟预算（人民币），两个后端共享一个池子
timeoutSec: 300           # 单个 step 超时
workspace: /tmp/xxx       # 被测 agent 会改动的工作区（产物断言的根 + 快照）
smokeTest: true           # 可选：环境探针，不参与判定
compatibility:            # 可选：兼容性门开关，三项默认都开
  check_system_field_format: true
  check_cache_control: true
  probe_cache_control: true   # v1.1：为 cache_control 一项真发 4 个请求（会花钱）
historicalCost:           # 可选：成本门的历史区间数据
  baselineRangeUSD: [0.003065, 0.007100]
  candidateRangeUSD: [0.001148, 0.002733]
  savingsPercent: 53.2
  batches: 3
  samples: 9
backends:
  baseline: { id: ..., baseUrl: ..., model: ..., apiKeyEnv: ... }
  candidate: { id: ..., baseUrl: ..., model: ..., apiKeyEnv: ... }
steps:
  - prompt: "..."
    assert:
      - type: file_exists
        path: FAILURE.md
```

`apiKeyEnv` 是**变量名，不是密钥** —— 密钥只在运行时注入子进程环境，**永不落盘**。

**prompt 里的 `{suiteRoot}`**：由插件在把 prompt 交给 agent **之前**替换成本包的实际
安装路径。会改工作区的套件靠 prompt 第一步跑 `{suiteRoot}/suites/.../fixtures/reset-all.mjs`
来重置工作区 —— 写死绝对路径的话，套件发出去只有作者那台机器能跑（agent 执行不存在的
路径 → 工作区不重置 → baseline 跑完 candidate 看到改好的文件，步数塌成 1）。
只认这一个占位符，别的花括号原样保留。

## 安全边界

- **不执行任意 shell**：产物断言走 `spawnSync` + `shell: false`，
  解释器白名单（只 `node`）+ argv 必须**恰好两个元素**（挡 `node -e "<任意代码>"`），
  路径必须落在 `workspace` 内。
- **不写密钥**：密钥只经环境变量注入子进程，不进 patch 文件、不进日志、不进报告。
  探针请求（v1.1）**是唯一一处插件自己直接发 HTTP 的地方**，密钥以 `x-api-key`
  头发给**同一个端点** —— 不新增任何第三方，也不落盘。
- **不读 trace**：`~/.dsh/sessions/` 下的会话 trace 不读。

---

# 第二部分：开发者指南

## 架构

```
src/
├── index.ts                 插件注册 + execute（路径守卫、预算分发、门与判定的接线）
├── eval-runner.ts           runOneBackend：spawn dsh 子进程、解析 NDJSON、跑断言、计价
├── compare-reporter.ts      报告渲染（判定 → 对比表 → 兼容性门 → 失败用例 → 快照）
├── verdict.ts               判定层：三门口径 → 一个结论 + 风险清单（纯函数、零 token）
├── compatibility-check.ts   兼容性门：一个静态检查项（零 token）+ 结果聚合与探针结果回填
├── cache-probe.ts           兼容性门的探针请求（v1.1）：真发 4 个请求，两分支对照，冷热之间等 2s
├── artifact-assert.ts       6 种产物断言 + 三层安全边界
├── model-router.ts          按套件 YAML 生成 pi-ai 路由 patch
├── pricing.ts               三档计价 + 峰谷系数 + 节假日表
└── workspace-snapshot.ts    工作区快照（baseline 后 / candidate 后各留一份物证）
```

**插件 API 五个必知**（都是实测得出的）：

1. 注册用 `defineTool`（`@deepseek-ai/dsh-tools`），**`output.schema` 是必填**，
   且 `additionalProperties` 必须显式写 `true`/`false`，否则 `UNSUPPORTED_SCHEMA`。
2. `output.render` 把 `execute` 返回的**规范值**投影成 model-facing 内容块。
3. **相对导入必须带 `.js` 扩展名** —— tsconfig 是 `moduleResolution: bundler`，
   tsc 不补扩展名，Node ESM 解析 `dist/` 时要求显式扩展名。
4. **加载顺序靠服务依赖不靠文件顺序**：`export const inject = ['tools']`。
5. `@deepseek-ai/cordis` **只 import type**（编译期擦除），运行时 `ctx` 由宿主传入。

## 约束（不要违反）

1. **不改 `eval_run_dual` 的工具签名**（参数只有 `suite` 一个）
2. **不改 `compare-reporter.ts` 的 `SuiteResult` 接口**（冻结；新数据挂到
   `DualBackendReport` 报告层，`snapshots` / `compatibility` / `judgement` 都是这么挂的）
3. **不引入新依赖**
4. **不把 API key 写进任何文件、log、`console.log`**
5. **不提交原始 NDJSON**（有 key 痕迹的保险考虑）

## 开发

```sh
pnpm install
pnpm build            # tsc → dist/
pnpm test:offline     # 离线回归：16 组 152 项断言，零成本、不联网（会先自动 build）
```

**`pnpm test:offline` 是改动后必跑的回归手段，不需要 key。**
它用桩 `dsh`（`test/stubs/`）喂入按**真实事件形状**构造的 NDJSON，驱动 `runOneBackend`
与 `eval_run_dual` 走完全程。

它"不联网、不花钱"不是靠自觉，有两道**结构性**兜底（`test/run-offline.mjs` 顶部）：

1. **毒药 `fetch`**：全局 `fetch` 被换成一个"调用即记账 + 抛错"的函数。
   任何逃过桩的请求都会让测试**失败**，而不是静默发生。
2. **`DSH_EVAL_NO_PROBE=1`**：全局关掉 v1.1 的探针。文件里有 6 处端到端测试会调
   `execute()`；逐个去改它们的套件 YAML 太脆，以后新增一个就会悄悄开始联网。

> **写新的端到端测试时注意**：如果你要验探针接线，像第 14 组那样自己把
> `globalThis.fetch` 换成桩、并临时撤掉全局开关，用完在 `finally` 里还原。
> 这条规矩是踩出来的 —— 见 `CHANGELOG.md` 1.1.0 的 Fixed 一节。

真正需要联网验证的只有一件事：路由能否打通后端。

## 已知限制 —— **这些是设计边界，不是未完成的 TODO**

> 每一条都**不是**"差几个功能就完美"，而是这个工具在当前设计下**原理上做不到、
> 或刻意不做**的事。判断"工具在什么条件下成立"请据此，不要猜"还有什么没做完"。

1. **`cache_control` 的效力要靠探针请求验**（v1.1 起默认会跑，已实测完成）。
   它由 harness 运行时生成、每次请求必发，不在任何配置文件里。"扫配置"式检查恒返回
   "没扫到"，而它其实每次都在发 —— 那会是个**假通过**。所以改为真发 4 个请求做两分支
   对照（带标记 / 不带标记，各发两次同一前缀）。
   **实测结论：端点接受并兑现前缀缓存，但功劳是它自己的自动缓存的，标记的边际贡献为零**
   —— 只看"第二次命中了"确实证明不了是标记的功劳，对照组正是为此存在。
   不过**"没探成"仍然不算"查过"**：没给密钥、套件关掉本项、或设了
   `DSH_EVAL_NO_PROBE=1` 时仍退回「未检测」，判定仍最多「有条件迁移」。
   另外它验的是**最小请求**（前缀约 2.5k token、单轮、非流式），
   真实负载下的行为不覆盖；缓存"有没有"验得了，缓存"有多少"仍跨轮不可比。
2. **步数没有测量能力。** 同一配置三批三个判定，信噪比 ≈ 1。已从判据删除，只作诊断。
3. **绝对成本跨轮不可比。** 前缀缓存有 TTL。可比的是同一趟内两列的相对关系。
4. **套件池不覆盖编码谱系。** 无长上下文（>100k）、多轮对话、大范围重构、
   并发工具调用、真实仓库规模的任务。**适用范围必须声明为"当前套件池覆盖的任务类型"**，
   不能读成"这两个模型在任何任务上等价"。
5. **只有 1 对模型的数据**（`deepseek-v4-pro` vs `deepseek-flash`）。
   「成本差异稳定、步数不可复现」是否普遍，**未知**。
6. **`01-single-step` 不参与任何判定。** 它是环境探针，唯一判据查的是**措辞**，
   而措辞正是本设计论证过不该进断言的东西。
7. **无跨模型的价值判断。** 只回答"能不能换"。

完整版见 [`docs/v1-release.md`](docs/v1-release.md) 第四节。

## 贡献

欢迎反馈，尤其是 **你那里的批次效应有多严重**。当前数据是 DeepSeek 内部两个模型
之间的对比；跨厂商迁移（Claude→DeepSeek、GPT→Kimi）的批次效应可能更大或更小。

改动请附 `pnpm test:offline` 全绿的结果。若新增断言类型或门，请同时补离线测试组。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/v1.1-release.md`](docs/v1.1-release.md) | **v1.1 交付说明**：探针的真实端点验证结果、交叉验证、判定口径最终版 |
| [`docs/v1-release.md`](docs/v1-release.md) | **v1.0 交付说明**（历史快照）：状态、三门口径、已知限制、复现指引 |
| [`docs/handoff.md`](docs/handoff.md) | 交接文档：现状、约束、DSH 坑、待办 |
| [`docs/backend-comparison.md`](docs/backend-comparison.md) | 三批次双后端对比原始数据与结论 |
| [`docs/acceptance-gate-design.md`](docs/acceptance-gate-design.md) | 接受门设计：判定分层、采样策略、兼容性检查项 |
| [`docs/eval-design-constraints.md`](docs/eval-design-constraints.md) | 评测设计约束与测量协议 |
| [`docs/publish-checklist.md`](docs/publish-checklist.md) | 发布步骤清单 |

## License

MIT
