/**
 * eval-runner — 真实 Agent 驱动的落点。
 *
 * 用 `dsh headless --json` 驱动一个后端跑完 suite 的每个 step，解析 NDJSON 事件流，
 * 汇总成 `SuiteResult`。
 *
 * ## 数据来源：只用 `--json`，不读落盘 trace
 *
 * NDJSON 里 token 用量、工具调用、最终回复、步数全都有。落盘 trace
 * （`~/.dsh/sessions/<项目>/<sessionId>/session.v4.jsonl.zstd`）有三个坑，
 * 绕开它就都不必处理：
 *   1. 是多 frame zstd（实测 32 frame），Node 内置的 `zstdDecompressSync` 与
 *      `createZstdDecompress()` **都只解第一个 frame**。
 *   2. 每个 usage 对象在 trace 里出现两次（`data.usage` 与 `data.stream[N].chunk`），
 *      朴素递归求和会得到**正好 2 倍**。
 *   3. 需要额外依赖（`fzstd`）或外部 `zstd` CLI。
 *
 * ## token 口径
 *
 * `SuiteResult` 只有 `inputTokens` / `outputTokens` 两个字段，没有 cache 字段。
 * 本实现把 `inputTokens` 记为**输入侧全部 token**（未命中 + 命中 + 写入），
 * 因为报告的「输入Token」一列若只算未命中，会漏掉实测中占比 85% 的 cacheRead，
 * 让 Token 对比失真。**成本不受此影响**——`computeCostUSD` 拿的是分档明细。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
// 相对导入必须带 `.js`：tsconfig 是 moduleResolution: bundler，tsc 不补扩展名，
// 而 Node ESM 解析 dist/ 时要求显式扩展名。
import { buildPatchConfig } from './model-router.js'
import type { BackendConfig } from './model-router.js'
import { checkArtifactAssert, isArtifactAssertType } from './artifact-assert.js'
import { computeCostUSD, USD_TO_CNY } from './pricing.js'
import type { TokenUsage } from './pricing.js'
import { SKIPPED_PREFIX } from './compare-reporter.js'
import type { SuiteResult } from './compare-reporter.js'
// 只 import 类型：兼容性检查与判定都在 `index.ts` 的 execute 里跑（它们管的是
// 整趟评测，不是单个后端），runner 只需要认识 YAML 里那几个字段的形状。
import type { CompatibilityConfig } from './compatibility-check.js'
import type { CostGate } from './verdict.js'

/** 套件 YAML 里的 `historicalCost` 一节 —— 就是判定层的 `CostGate`。 */
export type HistoricalCost = CostGate

/** 本包根目录（`dist/eval-runner.js` 的上一级）。 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 套件 prompt 里的 `{suiteRoot}` → 本包的实际安装路径。
 *
 * **为什么由插件填而不是写在 YAML 里**：会改工作区的套件，prompt 第一步要跑
 * `suites/<dir>/fixtures/reset-all.mjs` 把工作区恢复原状（见该脚本头部注释）。
 * 套件是**发布出去给别人跑的**，把绝对路径写死进 prompt，只有作者那台机器能跑 ——
 * 别人装完包，agent 去执行一个不存在的路径，工作区不会被重置，baseline 跑完
 * candidate 看到的是已经改好的文件，步数会塌成 1。**那不是模型行为，是污染的读数。**
 *
 * 插件知道自己装在哪，所以由插件来填。纯字符串替换，prompt 的其余部分原样不动。
 * 不认别的占位符 —— 未知的花括号原样保留，免得和 prompt 里正常的 `{}` 冲突。
 */
function renderPrompt(prompt: string): string {
  return prompt.replaceAll('{suiteRoot}', PKG_ROOT)
}

/** suite YAML 的一个 step。 */
export interface SuiteStep {
  prompt: string
  assert: Array<Record<string, unknown>>
}

/** suite YAML 的顶层结构。 */
export interface SuiteYaml {
  name: string
  /** 单个后端的预算上限（人民币）。不填 = 无上限。 */
  budgetCNY?: number
  /** 单个 step 的超时秒数。默认 120。 */
  timeoutSec?: number
  /**
   * 被测 agent 会改动的工作区目录（绝对路径）。两个用途：
   *
   *   1. **快照**：baseline 跑完、candidate 跑完后各拍一份，路径写进报告 ——
   *      否则"baseline 做对了没有"只能靠步数推断。
   *   2. **产物断言的根**：`file_*` / `command_*` 断言里的相对路径都相对它解析。
   *      用了产物断言却没声明 workspace，断言**直接判失败**（不回退到 cwd）。
   *
   * 不填则不拍快照、也不能用产物断言。
   */
  workspace?: string
  /**
   * 兼容性门的开关。两项默认都开，可显式关闭：
   *
   * ```yaml
   * compatibility:
   *   check_system_field_format: true
   *   check_cache_control: true
   * ```
   *
   * 关掉一项会让它变成 `not_checked`（**不是** `pass`）—— 用户能说"我知道这项没问题"，
   * 但不能说"这项算通过了"。判定因此最多到「有条件迁移」，风险清单里会列出它。
   */
  compatibility?: CompatibilityConfig
  /**
   * 本套件是**烟雾测试**（环境探针）：只验证插件能加载注册、YAML 能解析、
   * 模型能发现并调用 `eval_run_dual`，**不参与迁移判定**。
   *
   * 只有 `01-single-step` 是 `true`。它没有工作区、没有产物，唯一判据查的是
   * **措辞**，而措辞正是本设计论证过不该进断言的东西 —— 把它的 1/1 当质量证据
   * 会读出一个不存在的结论。
   */
  smokeTest?: boolean
  /**
   * 成本门的**历史区间数据**（跨批合并）。见 `src/verdict.ts` 的 `CostGate`。
   *
   * 为什么写死在 YAML 里而不是从本次运行算：成本是唯一能跨批使用的指标
   * （三批次 15/15 判定一致），而**单次跑给不出区间**。数据来源见
   * `docs/backend-comparison.md` 第八节的合并区间表。
   *
   * 不填 → 判定层认为成本门「数据不足，未判定」（**不否决**，只少一条建议）。
   */
  historicalCost?: HistoricalCost
  backends: {
    baseline: BackendConfig
    candidate: BackendConfig
  }
  steps: SuiteStep[]
}

const DEFAULT_TIMEOUT_SEC = 120

/** dsh 可达二进制。评测环境若不在 PATH 上，用这个覆盖。 */
const DSH_BIN = process.env.DSH_EVAL_DSH_BIN ?? 'dsh'

/**
 * 跑评测用的 profile。**必须独立于日常使用的 profile**：
 * 它不能自带默认模型配置，否则会和每次运行注入的 patch 抢 `agent-default-model` 这一行。
 */
const RUNNER_PROFILE = process.env.DSH_EVAL_PROFILE ?? 'eval-runner'

/** stderr 只用于诊断，留一份截断副本即可，避免异常输出撑爆内存。 */
const STDERR_CAP = 4000

/** NDJSON 事件的松散形状。只声明我们真正读的字段。 */
interface NdjsonEvent {
  type?: string
  phase?: string
  turn?: number
  step?: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  reason?: { kind?: string; error?: { message?: string; code?: string } }
  text?: string
  message?: string
}

/** 单个 step 的 headless 运行结果。 */
interface StepRun {
  usage: TokenUsage
  /** agent 内部步数 = `step_end` 事件条数 */
  steps: number
  /** `final` 事件的 text。断言只认它。 */
  finalText: string
  /** 整体失败原因；undefined 表示这次运行本身是完整的。 */
  failure?: string
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 启动一次 headless 运行，流式解析 NDJSON。
 *
 * 流式而非等进程结束再解析，是因为预算上限要靠每条 `step_end` 的 usage 实时判断，
 * 超限时立刻 SIGTERM。
 */
function runHeadless(
  prompt: string,
  backend: BackendConfig,
  apiKey: string,
  patchPath: string,
  timeoutSec: number,
  budgetUSD: number | undefined
): Promise<StepRun> {
  return new Promise<StepRun>((resolve) => {
    const usage = emptyUsage()
    let steps = 0
    let finalText = ''
    let errorEvent: string | undefined
    let turnReason: string | undefined
    // 失败细节挂在 `turn_end.reason.error.message` 上，不是独立的 error 事件。
    // 只取 kind 会把 401 这类真正的病因丢成一句「turn 未正常结束：error」。
    let turnError: string | undefined
    let aborted: string | undefined
    let settled = false

    const child = spawn(
      DSH_BIN,
      // 启动器的 flag（--profile / --patch）必须写在应用参数（headless ...）之前：
      // 切分是位置式的，启动器遇到的第一个不认识的 token 就是内层参数的起点。
      ['--profile', RUNNER_PROFILE, '--patch', patchPath, 'headless', '--json', prompt],
      {
        // 密钥只在这里、只以环境变量形式进入子进程 —— 不进 patch 文件、不进日志。
        env: { ...process.env, [backend.apiKeyEnv]: apiKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    const timer = setTimeout(() => {
      if (settled) return
      aborted = `超时（${timeoutSec}s）`
      child.kill('SIGTERM')
    }, timeoutSec * 1000)

    let stdoutBuf = ''
    let stderrTail = ''

    const handleLine = (raw: string): void => {
      const line = raw.trim()
      if (!line) return
      let ev: NdjsonEvent
      try {
        ev = JSON.parse(line) as NdjsonEvent
      } catch {
        // 插件自己的 console.log 会混进 stdout（例如注册自检那一行）。
        // 非 JSON 行是预期内的噪声，跳过即可，不是错误。
        return
      }

      if (ev.type === 'status') {
        if (ev.phase === 'step_end') {
          steps += 1
          usage.inputTokens += num(ev.usage?.inputTokens)
          usage.outputTokens += num(ev.usage?.outputTokens)
          usage.cacheReadTokens += num(ev.usage?.cacheReadTokens)
          usage.cacheWriteTokens += num(ev.usage?.cacheWriteTokens)
          if (budgetUSD !== undefined && !aborted) {
            const { usd } = computeCostUSD(backend.model, usage)
            if (usd > budgetUSD) {
              aborted = '预算超限中断'
              child.kill('SIGTERM')
            }
          }
        } else if (ev.phase === 'turn_end') {
          turnReason = ev.reason?.kind
          turnError = ev.reason?.error?.message
        }
      } else if (ev.type === 'final') {
        finalText = ev.text ?? ''
      } else if (ev.type === 'error') {
        errorEvent = ev.message ?? '（无 message）'
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let idx: number
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx)
        stdoutBuf = stdoutBuf.slice(idx + 1)
        handleLine(line)
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_CAP)
    })

    const settle = (failure: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ usage, steps, finalText, failure })
    }

    child.on('error', (err: Error) => {
      settle(`无法启动 ${DSH_BIN}：${err.message}`)
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (stdoutBuf.trim()) handleLine(stdoutBuf)

      // 判定顺序按「信息量」排：turn 失败的 reason 比退出码具体得多，
      // 所以先报它，退出码只作为兜底。
      let failure: string | undefined
      if (aborted) {
        failure = aborted
      } else if (turnReason !== undefined && turnReason !== 'completed') {
        failure =
          turnError !== undefined
            ? `turn 未正常结束（${turnReason}）：${turnError}`
            : `turn 未正常结束：${turnReason}`
      } else if (errorEvent !== undefined) {
        failure = `后端返回 error 事件：${errorEvent}`
      } else if (code !== 0) {
        failure = `退出码 ${code}${stderrTail ? `（stderr 尾部：${stderrTail.trim().slice(-300)}）` : ''}`
      }
      settle(failure)
    })
  })
}

/**
 * 执行一个 step 的断言，返回失败描述列表（空 = 全通过）。
 *
 * 两类断言，判据来源完全不同：
 *   - 对话类（`output_contains` / `max_steps`）查 `final.text` 与步数
 *   - **产物类**查工作区文件系统，实现见 `artifact-assert.ts`
 *
 * 产物断言在这里（而非整趟跑完之后）执行是**刻意的**：baseline 的断言在
 * candidate 启动之前就跑完了，此时工作区里放的是 baseline 的产物。
 * 若挪到整趟结束后统一跑，两次运行共用一个工作区，看到的永远是 candidate 的结果。
 */
function checkAssertions(
  asserts: Array<Record<string, unknown>>,
  run: StepRun,
  workspace: string | undefined
): string[] {
  const failures: string[] = []
  for (const a of asserts) {
    const type = String(a.type ?? '')
    if (type === 'output_contains') {
      const want = String(a.text ?? '')
      // 只查 final.text。tool_result 在 NDJSON 里超 8 KiB 会被截断并标 `truncated`，
      // 拿它做包含判断会把「输出了但被截断」误判成失败。final 不设上限。
      if (!run.finalText.includes(want)) {
        failures.push(`输出未包含 ${JSON.stringify(want)}`)
      }
    } else if (type === 'max_steps') {
      const max = Number(a.value)
      if (Number.isFinite(max) && run.steps > max) {
        failures.push(`步数 ${run.steps} 超过上限 ${max}`)
      }
    } else if (isArtifactAssertType(type)) {
      const f = checkArtifactAssert(a, workspace)
      if (f !== undefined) failures.push(f)
    } else {
      // 未知断言类型按失败计：静默跳过会让一个写错的断言看起来像通过了。
      failures.push(`未知断言类型 ${JSON.stringify(type)}`)
    }
  }
  return failures
}

function caseLabel(index: number, prompt: string, reason: string): string {
  const head = prompt.length > 30 ? `${prompt.slice(0, 30)}…` : prompt
  return `步骤 ${index + 1}「${head}」: ${reason}`
}

/**
 * 跑一个后端的全部 step，汇总为 `SuiteResult`。
 *
 * @param suitePath - suite YAML 的绝对路径。**在此重新读取**：函数签名是冻结的，
 *   step 列表只能从文件拿，而不是从调用方传进来。
 * @param backend - 后端配置。
 * @param budgetCNY - 「**这一个**后端最多花多少」（人民币），超出即以 SIGTERM 中断该 step。
 *   本函数不关心它是总量还是余量 —— 一趟评测共享预算池的逻辑在调用方（`eval_run_dual`
 *   的 `execute`）里：先跑的后端花掉的钱，会从传给后跑后端的额度里扣掉。
 * @returns 汇总结果。缺 key 时返回「未配置」哨兵结果，**不抛异常**。
 */
export async function runOneBackend(
  suitePath: string,
  backend: BackendConfig,
  budgetCNY?: number
): Promise<SuiteResult> {
  const suite = load(readFileSync(suitePath, 'utf-8')) as SuiteYaml

  const apiKey = process.env[backend.apiKeyEnv] || ''
  if (!apiKey) {
    // 优雅降级：没有 key 不是错误，是「这个后端本次不参与」。
    // 报告层据此把整列渲染成 `—` 而不是 0，避免把「没跑」读成「跑了得零分」。
    return {
      backendId: backend.id,
      passed: 0,
      total: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      failedCases: [`${SKIPPED_PREFIX}${backend.apiKeyEnv}`],
      avgSteps: 0,
    }
  }

  const timeoutSec = suite.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const budgetUSD = budgetCNY !== undefined ? budgetCNY / USD_TO_CNY : undefined
  const steps = suite.steps ?? []

  // patch 只含端点、模型 id 与**环境变量名**，不含密钥本身。
  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-migration-eval-'))
  const patchPath = join(tmpDir, 'route.patch.yml')
  writeFileSync(patchPath, buildPatchConfig(backend), 'utf-8')

  try {
    const totals = emptyUsage()
    const failures: string[] = []
    let passed = 0
    let totalSteps = 0

    for (const [i, step] of steps.entries()) {
      const run = await runHeadless(
        renderPrompt(step.prompt),
        backend,
        apiKey,
        patchPath,
        timeoutSec,
        budgetUSD,
      )

      totals.inputTokens += run.usage.inputTokens
      totals.outputTokens += run.usage.outputTokens
      totals.cacheReadTokens += run.usage.cacheReadTokens
      totals.cacheWriteTokens += run.usage.cacheWriteTokens
      totalSteps += run.steps

      if (run.failure) {
        failures.push(caseLabel(i, step.prompt, run.failure))
        continue
      }

      const stepFailures = checkAssertions(step.assert ?? [], run, suite.workspace)
      if (stepFailures.length === 0) {
        passed += 1
      } else {
        for (const f of stepFailures) failures.push(caseLabel(i, step.prompt, f))
      }
    }

    const { usd, priced } = computeCostUSD(backend.model, totals)
    if (!priced) {
      // 计价表里没有这个模型时成本记 0 是「没价格」，不是「不要钱」。
      // 报告的数字会因此偏小，必须显式说出来。
      failures.push(`⚠️ 计价表缺少模型 ${JSON.stringify(backend.model)}，成本按 0 计`)
    }

    return {
      backendId: backend.id,
      passed,
      total: steps.length,
      // 输入侧全部 token（未命中 + 命中 + 写入），见文件头「token 口径」。
      inputTokens: totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
      outputTokens: totals.outputTokens,
      costUSD: usd,
      failedCases: failures,
      avgSteps: steps.length > 0 ? totalSteps / steps.length : 0,
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
