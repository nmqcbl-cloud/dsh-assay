// dsh-agent-eval — 双后端对比评测插件（Claude vs DeepSeek 迁移接受门）。
//
// ⚠️ 与 SPEC.md 第五节 5.3 的差异（仅为适配真实 DSH 插件 API，行为不变）：
//   1. 注册用 `defineTool`（`@deepseek-ai/dsh-tools`），不是裸对象 —— 真实
//      registry 只接受 ToolDefinition。
//   2. `parameters` 是纯对象 schema，不是 `schemastery` 的 `Schema.object()`。
//   3. 必须有 `output.schema` + `output.render`；`execute` 返回**规范值**，
//      不是 `{ content }`。报告文本经由 render 投影成 model-facing 内容块。
//   4. 类型从 `@deepseek-ai/cordis` 导入（`import type`，编译期擦除）。
//   5. suiteDir 相对路径按**本包根目录**解析，而非 process.cwd() —— 否则
//      从 `dsh web`（cwd 为 profile 目录）调用时找不到 YAML。
//
// 第二阶段：`runOneBackend` 的真实实现落在 `src/eval-runner.ts`，本文件只负责
// 注册工具、做路径守卫、读套件配置并把预算上限传下去。工具签名与
// `runOneBackend` 签名均保持不变。
//
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
// 注意：相对导入必须带 `.js` 扩展名。tsconfig 为 `moduleResolution: bundler`，
// tsc 不会补扩展名，而 Node ESM 解析 `dist/` 时要求显式扩展名。
import { runOneBackend } from './eval-runner.js'
import type { SuiteYaml } from './eval-runner.js'
import { generateComparison, renderReport } from './compare-reporter.js'
import { runCompatibilityChecks } from './compatibility-check.js'
import { ROUTE_API } from './model-router.js'
import { USD_TO_CNY } from './pricing.js'
import { snapshotRoot, snapshotWorkspace } from './workspace-snapshot.js'

// 插件显示名，出现在 loader 诊断信息里。
export const name = 'dsh-agent-eval'

// 等宿主工具注册表就绪后再运行。
export const inject = ['tools']

export interface Config {
  suiteDir: string
}

const DEFAULT_CONFIG: Config = { suiteDir: './suites' }

/**
 * 一趟评测的默认预算上限（人民币，**整趟**，两个后端共享）。
 *
 * 套件 YAML 顶层可用 `budgetCNY` 覆盖；想关掉上限就写一个足够大的数
 * （不提供"不填即无限"的语义 —— 一个会失控花钱的默认值不是好默认值）。
 */
const DEFAULT_BUDGET_CNY = 1

/** 本包根目录（dist/index.js 的上一级）。 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx: Context, config: Config = DEFAULT_CONFIG) {
  const suiteRoot = isAbsolute(config.suiteDir)
    ? config.suiteDir
    : resolve(PKG_ROOT, config.suiteDir)

  ctx.tools.register(
    defineTool({
      name: 'eval_run_dual',
      description: '运行双后端对比评测（Claude vs DeepSeek），输出迁移接受门报告',

      parameters: {
        suite: {
          type: 'string',
          required: true,
          description: '套件名称，相对于 suiteDir，如 dual-backend/basic',
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            report: {
              type: 'string',
              required: true,
              description: '渲染后的双后端对比报告（纯文本）。',
            },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },

      async execute(args) {
        // `suite` 来自模型生成的参数，必须限制在 suiteRoot 之内 —— 否则
        // `../../etc/passwd` 这类输入能读到包外的任意文件。
        const suitePath = resolve(suiteRoot, `${args.suite}.yml`)
        const rel = relative(suiteRoot, suitePath)
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(
            `suite 必须位于 ${suiteRoot} 之内，收到：${JSON.stringify(args.suite)}`
          )
        }

        const yaml = load(readFileSync(suitePath, 'utf-8')) as SuiteYaml

        // 兼容性门：**在跑双后端之前**执行。零 token —— 只读套件 YAML 与
        // 已知的协议事实（`buildPatchConfig` 恒以 `ROUTE_API` 生成路由），
        // 不发任何请求。所以即便下面的运行因缺 key 被跳过，这一节也有内容。
        //
        // 判的是 **candidate**（迁移目标）：迁移要回答的是"换过去行不行"，
        // baseline 是既成事实，它的兼容性不是本次要判的东西。
        const cand = yaml.backends.candidate
        const compatibility = runCompatibilityChecks(
          {
            name: cand.displayName ?? cand.id,
            api: ROUTE_API,
            baseUrl: cand.baseUrl,
            model: cand.model,
          },
          yaml.compatibility
        )

        // 预算上限是套件级属性，放在 YAML 顶层，语义是**整趟**（两个后端共享一个池子）。
        // `runOneBackend` 的第三个参数语义不变 —— 它始终是「这个后端最多花多少」，
        // 只是调用方传的是**剩余**预算：先跑的后端花得多，后跑的可用额度就少。
        const totalCNY = yaml.budgetCNY ?? DEFAULT_BUDGET_CNY

        // 两次运行共用同一个工作区，只在跑完后拍一次快照的话，看到的是 candidate 的
        // 结果 —— "baseline 做对了没有"就只能靠步数推断。所以在两次之间补拍一份。
        const workspace = yaml.workspace
        const snapRoot = workspace !== undefined ? snapshotRoot(args.suite) : undefined

        const baseline = await runOneBackend(suitePath, yaml.backends.baseline, totalCNY)
        const afterBaseline =
          workspace !== undefined && snapRoot !== undefined
            ? snapshotWorkspace(workspace, snapRoot, 'after-baseline')
            : undefined

        const spentCNY = baseline.costUSD * USD_TO_CNY
        const remainingCNY = Math.max(0, totalCNY - spentCNY)
        const candidate = await runOneBackend(suitePath, yaml.backends.candidate, remainingCNY)
        const afterCandidate =
          workspace !== undefined && snapRoot !== undefined
            ? snapshotWorkspace(workspace, snapRoot, 'after-candidate')
            : undefined

        const report = {
          baseline,
          candidate,
          comparison: generateComparison(baseline, candidate),
          compatibility,
          snapshots:
            afterBaseline !== undefined || afterCandidate !== undefined
              ? { afterBaseline, afterCandidate }
              : undefined,
        }

        return { report: renderReport(report) }
      },
    })
  )

  // 自检：确认工具真的进了注册表。
  console.log(
    `[dsh-agent-eval] registered "eval_run_dual" — listed=${ctx.tools.get('eval_run_dual') !== undefined}, suiteRoot=${suiteRoot}`,
  )
}
