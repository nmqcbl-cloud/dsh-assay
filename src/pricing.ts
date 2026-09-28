/**
 * pricing — 三档计价 + 峰谷系数。
 *
 * DeepSeek 的输入分「cache 未命中 / cache 命中」两档，两者单价差约 50 倍，
 * 外加输出一档。**必须三档分开算**：实测一次运行里 cacheRead 占了 token 总量
 * 的 85%，但只占成本极小部分，若把它按未命中价计费会严重高估。
 * cache 写入 DeepSeek 未单列价格，按「未命中」价计。
 *
 * 峰谷：DeepSeek 官方定价页把价格写成「谷时 / 峰时」，谷时是峰时的一半。
 * 峰时 = UTC 周一至周五 01:00–04:00 与 06:00–10:00，**不含中国法定节假日**。
 *
 * 注意两处口径边界，实现时刻意选了简单的一侧：
 *   1. 调休上班日（如 2026-02-14 周六、2026-10-10 周六）官方要求上班，
 *      但 DeepSeek 的规则只写「周一至周五」，未提及调休。本实现**不把调休日
 *      当峰时**——它落在周末，按规则就是谷时。
 *   2. 节假日按北京时间（UTC+8）的日历日整日排除。
 *
 * 汇率取固定值，不做实时查询：成本对比看的是**两个后端的相对关系**，
 * 固定汇率不影响结论，实时汇率只会引入不可复现的抖动。
 */

/** 一个模型的八档单价，单位 USD / 1M tokens。无峰谷之分的模型两列填同值。 */
export interface ModelPrice {
  missOffPeak: number
  missPeak: number
  hitOffPeak: number
  hitPeak: number
  writeOffPeak: number
  writePeak: number
  outputOffPeak: number
  outputPeak: number
}

/** 计费用的一次运行 token 汇总（各字段均为整段运行的累加值）。 */
export interface TokenUsage {
  /** cache 未命中的输入 token */
  inputTokens: number
  /** cache 命中的输入 token */
  cacheReadTokens: number
  /** 写入 cache 的输入 token */
  cacheWriteTokens: number
  outputTokens: number
}

export const USD_TO_CNY = 7.1

/**
 * 计价表。键是模型 id，必须与 suite YAML 里 `model` 字段逐字一致。
 *
 * 来源：DeepSeek 官方定价页（api-docs.deepseek.com/quick_start/pricing，2026-09-28 实测抓取）。
 * 表里没有的模型按「未计价」处理，成本记 0 并在报告里显式标注——**不猜价格**。
 */
const PRICE_TABLE: Record<string, ModelPrice> = {
  'deepseek-flash': {
    missOffPeak: 0.15,
    missPeak: 0.3,
    hitOffPeak: 0.003,
    hitPeak: 0.006,
    writeOffPeak: 0.15,
    writePeak: 0.3,
    outputOffPeak: 0.6,
    outputPeak: 1.2,
  },
  'deepseek-v4-pro': {
    missOffPeak: 0.66,
    missPeak: 1.32,
    hitOffPeak: 0.022,
    hitPeak: 0.044,
    writeOffPeak: 0.66,
    writePeak: 1.32,
    outputOffPeak: 1.98,
    outputPeak: 3.96,
  },
  // Anthropic 无峰谷分档；cache 读为未命中的 0.1 倍，写为 1.25 倍。
  'claude-opus-5': {
    missOffPeak: 5,
    missPeak: 5,
    hitOffPeak: 0.5,
    hitPeak: 0.5,
    writeOffPeak: 6.25,
    writePeak: 6.25,
    outputOffPeak: 25,
    outputPeak: 25,
  },
  'claude-sonnet-5': {
    missOffPeak: 3,
    missPeak: 3,
    hitOffPeak: 0.3,
    hitPeak: 0.3,
    writeOffPeak: 3.75,
    writePeak: 3.75,
    outputOffPeak: 15,
    outputPeak: 15,
  },
}

/**
 * 2026 年中国法定节假日（北京时间日历日）。
 *
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》，国办发明电〔2025〕7 号，
 * 2025-11-04 成文。
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * 只含放假日期，不含调休上班日（见文件头注释第 1 条）。
 */
export const CN_HOLIDAYS_2026: readonly string[] = [
  // 元旦：1 月 1 日至 3 日
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  // 春节：2 月 15 日至 23 日（9 天）
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-02-23',
  // 清明节：4 月 4 日至 6 日
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  // 劳动节：5 月 1 日至 5 日
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  // 端午节：6 月 19 日至 21 日
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  // 中秋节：9 月 25 日至 27 日
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  // 国庆节：10 月 1 日至 7 日
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 把 UTC 时刻换算成北京时间的日历日 `YYYY-MM-DD`。 */
function beijingDateKey(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3600_000)
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
}

/**
 * 节假日表。默认用 {@link CN_HOLIDAYS_2026}，可用环境变量
 * `DSH_EVAL_CN_HOLIDAYS`（逗号分隔的 `YYYY-MM-DD`）整体覆盖——
 * 换年份或补调休时不必改代码。
 */
function holidaySet(): ReadonlySet<string> {
  const override = process.env.DSH_EVAL_CN_HOLIDAYS
  if (override !== undefined) {
    return new Set(
      override
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return new Set(CN_HOLIDAYS_2026)
}

/**
 * 判断某时刻是否落在 DeepSeek 的峰时窗口。
 * @param at - 待判断时刻；默认取当前时间。
 * @returns 峰时返回 true。周末与中国法定节假日恒为 false（谷时）。
 */
export function isPeakHour(at: Date = new Date()): boolean {
  if (holidaySet().has(beijingDateKey(at))) return false
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** 一次计费的结果。 */
export interface CostBreakdown {
  /** 成本，美元 */
  usd: number
  /** 该模型是否在计价表里。false 表示 usd 记 0 是「没价格」而非「不要钱」。 */
  priced: boolean
  /** 本次是否按峰时计价 */
  peak: boolean
}

/**
 * 按三档单价计算一次运行的美元成本。
 * @param model - 模型 id，须与计价表的键一致。
 * @param usage - 整段运行的 token 汇总。
 * @param at - 用于判定峰谷的时刻；默认取当前时间。
 */
export function computeCostUSD(
  model: string,
  usage: TokenUsage,
  at: Date = new Date(),
): CostBreakdown {
  const price = PRICE_TABLE[model]
  const peak = isPeakHour(at)
  if (!price) return { usd: 0, priced: false, peak }

  // cache 写入按未命中价计（DeepSeek 未单列写入价）。
  const missInput = usage.inputTokens + usage.cacheWriteTokens
  const hitInput = usage.cacheReadTokens
  const missRate = peak ? price.missPeak : price.missOffPeak
  const hitRate = peak ? price.hitPeak : price.hitOffPeak
  const writeRate = peak ? price.writePeak : price.writeOffPeak
  const outRate = peak ? price.outputPeak : price.outputOffPeak

  const usd =
    (usage.inputTokens * missRate +
      usage.cacheWriteTokens * writeRate +
      hitInput * hitRate +
      usage.outputTokens * outRate) /
    1e6

  return { usd, priced: true, peak }
}
