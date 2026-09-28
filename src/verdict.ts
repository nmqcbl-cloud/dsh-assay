/**
 * verdict — 迁移接受门：判定层。
 *
 * **纯函数，零依赖，零 token，零模型调用。** 输入三个门的结果，输出判定 + 风险清单。
 *
 * ## 为什么要有这一层
 *
 * 三个门各说各话的报告是**数据面板**，不是**决策工具**。"质量门 54/54、兼容性门
 * 一项未检测、成本门省 73%"——读完这句话的人仍然不知道该不该迁。判定层是插件
 * 之所以叫「迁移接受门」的理由：它把那三行数字压成一个可执行的结论，并把
 * **不确定的部分明写成风险**。
 *
 * ## 判定顺序（短路）
 *
 * ```
 * ① 质量门有失败项？          → 不可迁移
 * ② 兼容性门有 fail 项？      → 不可迁移（一票否决，与质量门/成本门无关）
 * ③ 兼容性门有 not_checked？  → 有条件迁移
 * ④ 其余（两门全过）          → 可迁移
 * ```
 *
 * **成本门从不参与一票否决。** 它只决定"值不值得迁"，不影响"能不能迁"——
 * 一个把任务做错的模型可能非常便宜，一个贵 3 倍的模型也可能完全正确。
 * 把成本写进否决是**范畴错误**。
 *
 * ## 「未检测」不等于「通过」
 *
 * 这是本设计里唯一一处刻意保守的地方，也是判定层存在的意义：`not_checked`
 * 会把判定压到「有条件迁移」，并把那一项写进风险清单。宁可说"我们还不知道"，
 * 也不把"没查"说成"查过了没问题"。
 */

/** 迁移判定。`不判定` 只用于烟雾测试套件（见下）。 */
export type Verdict = '可迁移' | '有条件迁移' | '不可迁移' | '不判定'

/**
 * 一条风险。
 *
 * `level` 让渲染层能确定性地选图标 —— 不用靠字符串匹配猜哪条该配 ⚠️ 哪条配 ℹ️。
 *
 * - `warn`：真风险（失败项、未检测项、某项没能判定）
 * - `info`：说明性信息（数据来源、口径），不是问题
 */
export interface Risk {
  level: 'warn' | 'info'
  text: string
}

/** 质量门：产物判据的通过情况。 */
export interface QualityGate {
  passed: number
  total: number
  /** 失败详情（哪个套件、哪条判据、期望 vs 实际）。 */
  failures: string[]
}

/** 兼容性门的一项。形状与 `compatibility-check.ts` 的 `CompatibilityResult` 一致。 */
export interface CompatGateItem {
  name: string
  status: 'pass' | 'fail' | 'not_checked'
  detail: string
  /**
   * 风险清单里用的**短**说法。风险清单要挤在报告最顶部，`detail` 那四五行放不下；
   * 缺省时退回用 `detail`。见 `compatibility-check.ts` 的同名字段。
   *
   * 只在 `fail` / `not_checked` 时被取用。
   */
  riskText?: string
  /**
   * **无论 `status` 是什么都要写进风险清单**的一条 ℹ️ 说明（可选）。
   *
   * 给"成本类发现"留的出口：探针可能验出"端点接受 `cache_control` 但不兑现前缀缓存"。
   * 这不影响请求能否发出，按本文件的论证**不能一票否决**，状态只能是 `pass`；
   * 但 `pass` 会让它从风险清单里消失，而它确实该被看见。见
   * `compatibility-check.ts` 的 `infoText`。
   */
  infoText?: string
}

/**
 * 成本门（可选）。
 *
 * 采信**跨批区间**而不是本次单跑的点值：成本是唯一能跨批使用的指标（三批次
 * 15/15 判定一致），而单次跑给不出区间。数据来源见 `docs/backend-comparison.md` 第八节。
 */
export interface CostGate {
  /** 基线历史成本区间（USD），跨批合并。 */
  baselineRangeUSD: [number, number]
  /** 候选历史成本区间（USD），跨批合并。 */
  candidateRangeUSD: [number, number]
  savingsPercent: number
  /** 批次总数（如 v1/v2/v3 共 3 批）。 */
  batches: number
  /** 合并样本量（如 3 批 × 3 次 = 9）。 */
  samples: number
}

export interface GateResult {
  /**
   * 本套件是否烟雾测试。
   *
   * `01-single-step` 验证的是**环境可用**（插件能被加载注册、YAML 能解析、模型
   * 能发现并调用工具），不验证质量：它没有工作区、没有产物，唯一判据是
   * `output_contains: "Harness"`——查的是**措辞**，而措辞正是本设计论证过
   * 不该进断言的东西。所以它**不参与判定**，判定返回 `不判定`。
   */
  smokeTest?: boolean
  quality: QualityGate
  compatibility: CompatGateItem[]
  cost: CostGate | null
}

export interface Judgement {
  verdict: Verdict
  risks: Risk[]
}

/**
 * 判定。
 *
 * @param gates - 三个门的结果。`cost` 为 `null` 表示无历史区间数据。
 * @returns 判定与风险清单（顺序即渲染顺序）。
 */
export function judge(gates: GateResult): Judgement {
  const { quality, compatibility, cost } = gates

  // 烟雾测试不进判定。它的 1/1 是"环境通了"的读数，不是质量证据 ——
  // 把它渲染成「有条件迁移」会让人以为这个套件被判定过。
  if (gates.smokeTest === true) {
    return {
      verdict: '不判定',
      risks: [
        {
          level: 'info',
          text: '本套件是烟雾测试（环境探针），只验证插件加载与工具调用链路，不参与迁移判定',
        },
      ],
    }
  }

  const risks: Risk[] = []

  // ① 质量门失败 —— 一票否决。产物判据不通过 = 任务没做对，别的都不用看了。
  if (quality.failures.length > 0) {
    for (const f of quality.failures) risks.push({ level: 'warn', text: f })
    return { verdict: '不可迁移', risks }
  }

  // 质量门**没能判定**（后端因缺 key 被跳过，total 为 0）。
  // 这和"未检测"同理：不能说"没跑过"等于"跑过了没问题"。
  const qualityUnjudged = quality.total === 0

  // ② 兼容性门失败 —— 一票否决，与质量门/成本门结果无关。
  const compatFailed = compatibility.filter((c) => c.status === 'fail')
  if (compatFailed.length > 0) {
    for (const c of compatFailed) {
      risks.push({ level: 'warn', text: `${c.name}：${c.riskText ?? c.detail}` })
    }
    if (qualityUnjudged) {
      risks.push({ level: 'warn', text: '质量门：后端未运行（缺配置），未判定' })
    }
    return { verdict: '不可迁移', risks }
  }

  // 未检测项 —— 压到「有条件迁移」，逐条写进风险清单。这是刻意的保守。
  const compatUnchecked = compatibility.filter((c) => c.status === 'not_checked')

  // ③ 成本门。**不否决** —— 缺数据只是"少一条建议"，不改"能不能迁"。
  if (cost === null) {
    risks.push({ level: 'info', text: '成本门：数据不足，未判定' })
  } else {
    risks.push({
      level: 'info',
      text:
        `成本门：基于历史区间数据（n=${cost.samples}，${cost.batches} 个批次），` +
        `候选省 ${cost.savingsPercent.toFixed(1)}%；` +
        '单次跑给不出区间，故采信历史数据',
    })
  }

  // 兼容性门里"状态是 pass、但有话要说"的项（目前只有探针验出的成本类发现）。
  // 不受状态影响 —— 这正是 `infoText` 存在的理由，见 `CompatGateItem` 的注释。
  for (const c of compatibility) {
    if (c.infoText !== undefined) risks.push({ level: 'info', text: c.infoText })
  }

  if (compatUnchecked.length > 0) {
    for (const c of compatUnchecked) {
      risks.push({ level: 'warn', text: `${c.name}：${c.riskText ?? c.detail}` })
    }
    if (qualityUnjudged) {
      risks.push({ level: 'warn', text: '质量门：后端未运行（缺配置），未判定' })
    }
    return { verdict: '有条件迁移', risks }
  }

  if (qualityUnjudged) {
    risks.push({ level: 'warn', text: '质量门：后端未运行（缺配置），未判定' })
    return { verdict: '有条件迁移', risks }
  }

  // ④ 两个一票否决门全过。成本门是否通过不影响判定，只影响建议。
  return { verdict: '可迁移', risks }
}
