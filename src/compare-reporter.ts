import { USD_TO_CNY } from './pricing.js'

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
  lines.push(
    `${'成本(USD)'.padEnd(14)}${cell(baseline.costUSD.toFixed(4), bSkip)}${cell(candidate.costUSD.toFixed(4), cSkip)}`
  )
  // 预算上限是人民币、成本按美元算，两个币种都摆出来，省得心算。
  lines.push(
    `${'成本(CNY)'.padEnd(14)}${cell((baseline.costUSD * USD_TO_CNY).toFixed(4), bSkip)}${cell((candidate.costUSD * USD_TO_CNY).toFixed(4), cSkip)}`
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

  return lines.join('\n')
}
