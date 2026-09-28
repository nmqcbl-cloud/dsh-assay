import { USD_TO_CNY } from './pricing.js'
import type { WorkspaceSnapshots } from './workspace-snapshot.js'
import type { CompatibilityReport } from './compatibility-check.js'
import type { Judgement } from './verdict.js'

export interface SuiteResult {
  backendId: string
  passed: number
  total: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  failedCases: string[]
  avgSteps: number
}

export interface DualBackendReport {
  baseline: SuiteResult
  candidate: SuiteResult
  comparison: {
    passRateDelta: number
    costSavingsPercent: number
    tokenDeltaPercent: number
    regressedCases: string[]
  }
  /**
   * 工作区快照路径（可选）。只在套件声明了 `workspace` 且该目录存在时才有。
   * 加在**报告**这一层而不是 `SuiteResult` 上 —— 后者是后端结果的形状，快照是
   * 一趟评测的组织方式，两者不该混在一起。
   */
  snapshots?: WorkspaceSnapshots
  /**
   * 兼容性门（可选）。与快照同理，挂在**报告**层而不是 `SuiteResult` 上 ——
   * 它描述的是一趟迁移的可行性，不是某个后端跑出来的结果。
   */
  compatibility?: CompatibilityReport
  /**
   * 迁移判定（可选）。由 `src/verdict.ts` 的 `judge()` 纯函数算出，渲染在报告**最顶部**
   * —— 三个门各说各话是数据面板，压成一个结论才是决策工具。
   */
  judgement?: Judgement
}

/**
 * 「后端未配置」哨兵前缀。
 *
 * `SuiteResult` 没有「不可用」字段，而它的接口是冻结的（不能加字段），
 * 所以后端缺 key 时由 `runOneBackend` 返回 `failedCases: ['未配置：<变量名>']`，
 * 报告层据此把整列渲染成 `—`，而不是把「没跑」伪装成「跑了得 0 分」。
 *
 * 定义在报告层而不是 runner 层，是为了避免两个模块互相 import 形成运行时环。
 */
export const SKIPPED_PREFIX = '未配置：'

/** 该后端是否因缺配置而被跳过。 */
export function isSkipped(r: SuiteResult): boolean {
  return r.failedCases.some((c) => c.startsWith(SKIPPED_PREFIX))
}

export function generateComparison(
  baseline: SuiteResult,
  candidate: SuiteResult
): DualBackendReport['comparison'] {
  const bPass = baseline.total > 0 ? baseline.passed / baseline.total : 0
  const cPass = candidate.total > 0 ? candidate.passed / candidate.total : 0
  const bTokens = baseline.inputTokens + baseline.outputTokens
  const cTokens = candidate.inputTokens + candidate.outputTokens

  const regressedCases = candidate.failedCases.filter(
    (c) => !baseline.failedCases.includes(c)
  )

  return {
    passRateDelta: (cPass - bPass) * 100,
    costSavingsPercent:
      baseline.costUSD > 0
        ? ((baseline.costUSD - candidate.costUSD) / baseline.costUSD) * 100
        : 0,
    tokenDeltaPercent:
      bTokens > 0 ? ((cTokens - bTokens) / bTokens) * 100 : 0,
    regressedCases,
  }
}

/**
 * 按**显示宽度**补齐：CJK 字符占两列，ASCII 占一列。
 *
 * 报告是给人看的终端文本，列歪了会串行。只在兼容性门那一段用 —— 上面那张
 * 指标表用的是 `padEnd`（历史写法，列名固定、不会变），不动它以免改动面外溢。
 */
function padDisplay(s: string, width: number): string {
  const WIDE =
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/
  let w = 0
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

export function renderReport(report: DualBackendReport): string {
  const { baseline, candidate, comparison } = report
  const lines: string[] = []
  const sep = '━'.repeat(46)
  const dash = '─'.repeat(46)

  const bSkip = isSkipped(baseline)
  const cSkip = isSkipped(candidate)
  const anySkip = bSkip || cSkip

  // 被跳过的后端整列渲染成 `—`：0 是「跑了得 0 分」，`—` 是「根本没跑」，两者必须能分辨。
  const cell = (value: string, skipped: boolean): string =>
    (skipped ? '—' : value).padEnd(16)

  // 判定在最顶部 —— 读报告的人第一眼要看到"能不能迁"，而不是先自己把三张表加总。
  const judgement = report.judgement
  if (judgement) {
    const VICON = { 可迁移: '✅', 有条件迁移: '⚠️', 不可迁移: '❌', 不判定: '➖' } as const
    lines.push(`🎯 迁移判定：${VICON[judgement.verdict]} ${judgement.verdict}`)
    lines.push(sep)
    if (judgement.risks.length > 0) {
      lines.push('风险清单：')
      for (const r of judgement.risks) {
        lines.push(`  ${r.level === 'warn' ? '⚠️' : 'ℹ️'}  ${r.text}`)
      }
      lines.push(sep)
    }
    lines.push('')
  }

  lines.push('📊 双后端评测对比')
  lines.push(sep)
  lines.push(
    `${'指标'.padEnd(14)}${baseline.backendId.padEnd(16)}${candidate.backendId.padEnd(16)}`
  )
  lines.push(dash)
  lines.push(
    `${'通过率'.padEnd(14)}${cell(`${baseline.passed}/${baseline.total}`, bSkip)}${cell(`${candidate.passed}/${candidate.total}`, cSkip)}`
  )
  lines.push(
    `${'输入Token'.padEnd(14)}${cell(String(baseline.inputTokens), bSkip)}${cell(String(candidate.inputTokens), cSkip)}`
  )
  lines.push(
    `${'输出Token'.padEnd(14)}${cell(String(baseline.outputTokens), bSkip)}${cell(String(candidate.outputTokens), cSkip)}`
  )
  // 6 位小数，不是 4 位。便宜的模型（如 flash 跑单步套件）真实成本量级在 1e-5，
  // 4 位会把 0.000068 渲染成 0.0001 —— 相对误差 40%，不足以支撑成本判据。
  // 再多的位数没有意义：单价本身的精度也不到那里。
  const COST_DP = 6
  lines.push(
    `${'成本(USD)'.padEnd(14)}${cell(baseline.costUSD.toFixed(COST_DP), bSkip)}${cell(candidate.costUSD.toFixed(COST_DP), cSkip)}`
  )
  // 预算上限是人民币、成本按美元算，两个币种都摆出来，省得心算。
  lines.push(
    `${'成本(CNY)'.padEnd(14)}${cell((baseline.costUSD * USD_TO_CNY).toFixed(COST_DP), bSkip)}${cell((candidate.costUSD * USD_TO_CNY).toFixed(COST_DP), cSkip)}`
  )
  lines.push(
    `${'平均步数'.padEnd(14)}${cell(baseline.avgSteps.toFixed(1), bSkip)}${cell(candidate.avgSteps.toFixed(1), cSkip)}`
  )
  lines.push(sep)
  lines.push(`💡 成本说明：以上为 USD，按谷时/峰时计价（谷时半价）；CNY 按 1 USD ≈ ${USD_TO_CNY} CNY 折算`)

  // 有一侧没跑，三项对比指标都失去意义 —— 宁可显示 `—`，也不输出看起来像结论的数字。
  if (anySkip) {
    lines.push('通过率变化：—')
    lines.push('成本节省：—')
    lines.push('Token变化：—')
    lines.push('⚠️ 回退用例：—（单边运行，无法判定回退）')
  } else {
    lines.push(
      `通过率变化：${comparison.passRateDelta >= 0 ? '+' : ''}${comparison.passRateDelta.toFixed(1)}%`
    )
    lines.push(`成本节省：${comparison.costSavingsPercent.toFixed(1)}%`)
    lines.push(
      `Token变化：${comparison.tokenDeltaPercent >= 0 ? '+' : ''}${comparison.tokenDeltaPercent.toFixed(1)}%`
    )
    if (comparison.regressedCases.length) {
      lines.push(`⚠️ 回退用例：${comparison.regressedCases.join(', ')}`)
    } else {
      lines.push('✅ 无回退用例')
    }
  }

  // 失败用例明细。没有这一段，`passed/total` 只给得出一个数字，
  // 说不出**哪一条**为什么没过 —— 那正是评测最需要的信息。
  for (const side of [baseline, candidate]) {
    if (isSkipped(side)) continue
    const cases = side.failedCases.filter((c) => !c.startsWith(SKIPPED_PREFIX))
    if (!cases.length) continue
    lines.push('')
    lines.push(`失败用例（${side.backendId}）：`)
    for (const c of cases) lines.push(`  · ${c}`)
  }

  if (anySkip) {
    lines.push('')
    for (const side of [baseline, candidate]) {
      if (!isSkipped(side)) continue
      const envName = side.failedCases
        .find((c) => c.startsWith(SKIPPED_PREFIX))
        ?.slice(SKIPPED_PREFIX.length)
      lines.push(`⚠️ ${side.backendId} 未配置（${envName} 为空），已跳过`)
    }
  }

  // 兼容性门。放在对比表之后、快照之前 —— 它是**一票否决**的结论，比快照路径重要。
  const compat = report.compatibility
  if (compat) {
    lines.push('')
    lines.push('🔒 兼容性门')
    lines.push(sep)
    // 三态的图标与措辞都不同，**不能只靠颜色区分**（纯文本报告里没有颜色）。
    // `not_checked` 一律用 ⚠️ + "未检测"："我们没查"和"查过了没问题"必须一眼分得开。
    const ICON = { pass: '✅', fail: '❌', not_checked: '⚠️' } as const
    const LABEL = { pass: '通过', fail: '失败', not_checked: '未检测' } as const
    for (const r of compat.results) {
      // 用显示宽度补齐而不是 `padEnd` —— 检查项名是中文，一个汉字占两列，
      // 按码元补会把状态列推歪两格，读起来会串行。
      lines.push(`  ${padDisplay(r.name, 22)}${ICON[r.status]} ${LABEL[r.status]}`)
      lines.push(`    ↳ ${r.detail}`)
    }
    lines.push(dash)
    if (compat.verdict === 'fail') {
      lines.push(`❌ 兼容性门不通过 → 本趟判定「不可迁移」（一票否决，与质量门/成本门无关）`)
      lines.push(`   失败项：${compat.failed.join('、')}`)
    } else if (compat.verdict === 'not_checked') {
      lines.push(`⚠️ 存在未检测项 → 本趟最多判定「有条件迁移」`)
      lines.push(`   未检测项：${compat.unchecked.join('、')}`)
      lines.push('   （"未检测"不等于"通过"——静态检查判不了运行时行为）')
    } else {
      lines.push('✅ 兼容性门全部已检测且通过')
    }
  }

  // 两次运行共用一个工作区，只有 candidate 跑完后的那份是"最终状态"。
  // 把 baseline 后那份的路径也摆出来，是为了让"baseline 做对了没有"有物证。
  const snaps = report.snapshots
  if (snaps && (snaps.afterBaseline !== undefined || snaps.afterCandidate !== undefined)) {
    lines.push('')
    lines.push('📁 工作区快照（两次运行共用一个工作区，分别留证）')
    if (snaps.afterBaseline !== undefined) lines.push(`  baseline 后：${snaps.afterBaseline}`)
    if (snaps.afterCandidate !== undefined) lines.push(`  candidate 后：${snaps.afterCandidate}`)
    if (snaps.afterBaseline === undefined) {
      lines.push('  ⚠️ baseline 后的快照缺失（工作区在该时点不存在）')
    }
  }

  return lines.join('\n')
}
