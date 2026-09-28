/**
 * compatibility-check — 迁移兼容性门（静态检查，零 token 消耗）。
 *
 * ## 这个模块为什么不是「扫描配置里的 `system` / `cache_control` 字段」
 *
 * 设计初稿要求：读 profile 配置，若 `system` 是内容块数组则判失败、若出现
 * `cache_control` 则判失败。**核实后发现这个前提在本 harness 上不成立**，两条都错：
 *
 *   1. **`system` 恒为内容块数组，且这是对的。** eval-runner 生成了
 *      `api: 'anthropic-messages'`（见 `model-router.ts`），该协议下 pi-ai
 *      **无条件**把 system 构造成 `[{type:'text', text, cache_control?}]`
 *      —— 见 `@earendil-works/pi-ai/dist/api/anthropic-messages.js` 的
 *      `else if (context.systemPrompt)` 分支。没有「字符串形态」可选。
 *      而本仓库三批次共 90 次内层运行**全部成功**打到
 *      `https://api.deepseek.com/anthropic`，**实测证伪了「数组会 400」**。
 *      `AnthropicMessagesCompat` 里也**没有**任何控制 system 形状的开关。
 *   2. **`cache_control` 不在配置里，它是运行时生成的。** 同一份代码里
 *      `getCacheControl()` 默认返回 `{ type: 'ephemeral' }`（retention 默认
 *      `'short'`），于是它被挂到**系统块、最后一条消息块、最后一个工具**上，
 *      每次请求都发。**扫描配置文件永远扫不到它** —— 那样写出来的检查会对
 *      一个真实存在的风险报「通过」，比没有检查更糟。
 *
 * 所以本模块改成检查**「harness 会发什么」与「端点声明接受什么」是否对得上**，
 * 这才是静态能判定的东西。
 *
 * ## 三条设计约束
 *
 *   1. **零 token**：只读配置与已知的协议事实，不发任何请求。
 *   2. **`not_checked` 不是 `pass`**：静态判不了的事必须显式标出来，不许默认通过。
 *      这是接受门里唯一一处刻意保守的地方，也是本模块存在的意义。
 *   3. **不猜**：每条 detail 都要能追到代码或数据，不写「可能大概」。
 */

import { ROUTE_API } from './model-router.js'

/** 一条兼容性检查的结果。 */
export interface CompatibilityResult {
  /** 稳定标识（YAML 开关名与之对应）。 */
  key: string
  /** 报告里显示的中文名。 */
  name: string
  /**
   * - `pass`       已检测且通过
   * - `fail`       已检测且不通过（一票否决）
   * - `not_checked` **没查**，不是「查过了没问题」
   */
  status: 'pass' | 'fail' | 'not_checked'
  detail: string
  /**
   * 风险清单里用的**短**说法（可选）。
   *
   * `detail` 是给兼容性门那一段的完整解释（含依据、旁证、下一步），四五行；
   * 判定层的风险清单要把同样的内容挤进报告最顶部，必须是一句话。
   * 缺省时判定层退回用 `detail`。
   *
   * 只在 `fail` / `not_checked` 时被判定层取用 —— 那两种状态本来就要进风险清单。
   */
  riskText?: string
  /**
   * **无论 `status` 是什么都要进风险清单**的一条 ℹ️ 说明（可选）。
   *
   * 存在的理由是「成本类发现」这个夹缝：探针（`cache-probe.ts`）可能验出
   * "端点接受 `cache_control` 但不兑现前缀缓存"。这**不影响请求能否发出**，
   * 所以按本仓库的口径它不能一票否决（把成本写进否决是范畴错误，见 `verdict.ts`），
   * 状态只能给 `pass`；可它又确实是个该被看见的问题 —— `pass` 会让它从
   * 风险清单里消失。`infoText` 就是给这种情况留的**不受状态影响的**出口。
   */
  infoText?: string
}

/** 兼容性门的整体结论。 */
export interface CompatibilityReport {
  results: CompatibilityResult[]
  /** 聚合判定，供接受门使用。 */
  verdict: 'pass' | 'fail' | 'not_checked'
  /** 未检测项的显示名，供风险清单使用。 */
  unchecked: string[]
  /** 失败项的显示名，供回退用例清单使用。 */
  failed: string[]
}

/**
 * 一条后端路由的兼容性输入。
 *
 * 不是「读某个 profile 文件」—— 评测跑在内层子进程里，路由是 `buildPatchConfig`
 * 按套件 YAML 现生成的，**套件 YAML 才是权威来源**。
 */
export interface CompatRoute {
  /** 路由名（= 后端 id）。 */
  name: string
  /** 协议。`buildPatchConfig` 目前恒为 `anthropic-messages`。 */
  api: string
  /** 端点。 */
  baseUrl: string
  /** 模型 id。 */
  model: string
}

/** 套件 YAML 顶层的 `compatibility` 开关。两项默认都开。 */
export interface CompatibilityConfig {
  check_system_field_format?: boolean
  check_cache_control?: boolean
  /**
   * 是否为 `cache_control` 一项跑**探针请求**（v1.1）。默认开。
   *
   * 这是本插件里**唯一会额外花钱**的开关：探针真发 4 个请求（约 2.5k token 前缀 × 4），
   * 实耗会写进报告里那一项的 `detail`。关掉它就退回静态的 `not_checked`
   * —— 省下几个 token，代价是判定出不了「可迁移」。
   *
   * `check_cache_control: false` 时本开关无意义：那一项已经不检查了，自然不探。
   */
  probe_cache_control?: boolean
}

/**
 * 端点是否**自称** Anthropic 兼容。
 *
 * 只看两个不猜的信号：主机是 api.anthropic.com，或路径里带 `anthropic`
 * （DeepSeek 的兼容端点是 `https://api.deepseek.com/anthropic`）。
 * 这**只是声明**，不是验证 —— 所以它最多支撑 `pass` 到「端点自称兼容」这一档。
 */
function looksAnthropicCompatible(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl)
    if (u.hostname === 'api.anthropic.com' || u.hostname.endsWith('.anthropic.com')) return true
    return /(^|\/)anthropic(\/|$)/.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * 检查项一：`system` 字段形态。
 *
 * 这一项**静态判得了**，判的是「harness 发什么」与「端点声明收什么」这一对：
 *
 *   - harness 侧：`anthropic-messages` 下恒以内容块数组发送 `system` —— 这是读
 *     pi-ai 源码得到的事实，不是推测。
 *   - 端点侧：`baseUrl` 是否**自称** Anthropic 兼容（主机或路径带 anthropic）。
 *
 * 两者对不上就是**确定的配置错误** —— 把一个 Anthropic 形状的请求体发给一个
 * 不声称接受它的端点。所以这一档判 `fail` 而不是 `not_checked`：证据足够。
 *
 * （真正的"自称兼容但不真兼容"只能靠 v1.1 的探针请求，本项判不了，也不假装判得了。）
 */
export function checkSystemFieldFormat(
  route: CompatRoute,
  enabled: boolean
): CompatibilityResult {
  const name = 'system 字段格式'
  if (!enabled) {
    return {
      key: 'check_system_field_format',
      name,
      status: 'not_checked',
      detail: '套件 YAML 显式关闭了本检查项',
      riskText: '检查项已在套件 YAML 中关闭（关闭 ≠ 通过）',
    }
  }
  if (route.api !== ROUTE_API) {
    return {
      key: 'check_system_field_format',
      name,
      status: 'fail',
      detail:
        `本评测的判据基于 Anthropic 语义，但路由「${route.name}」声明的协议是 ` +
        `${JSON.stringify(route.api)}，不是 ${ROUTE_API}`,
      riskText: `路由声明的协议是 ${JSON.stringify(route.api)}，与 Anthropic 语义的判据不匹配`,
    }
  }
  const shape = `将以内容块数组发送 system（[{type:'text', text}]，pi-ai 在 ${ROUTE_API} 下无条件如此）`
  if (!looksAnthropicCompatible(route.baseUrl)) {
    return {
      key: 'check_system_field_format',
      name,
      status: 'fail',
      detail:
        `${shape}，但端点 ${route.baseUrl} 未自称 Anthropic 兼容 —— ` +
        '把 Anthropic 形状的请求体发往非 Anthropic 端点，会触发 400',
      riskText: `端点 ${route.baseUrl} 未自称 Anthropic 兼容，Anthropic 形状的请求体会被拒（400）`,
    }
  }
  return {
    key: 'check_system_field_format',
    name,
    status: 'pass',
    detail: `${shape}；端点 ${route.baseUrl} 自称 Anthropic 兼容`,
  }
}

/**
 * 检查项二：`cache_control` 是否被兑现。
 *
 * **这一项静态判不了，所以永远是 `not_checked`（除非协议根本不发它）。**
 * 不是偷懒：`cache_control` 由 harness 运行时生成、每次请求必发，配置文件里
 * 根本没有它可查；而「端点收到后是否真的据此建立前缀缓存」只有发请求才能验。
 *
 * 已知的实测证据写在 detail 里，供人工判断 —— 但**证据不等于判定**：
 * DeepSeek 本身有自动前缀缓存，所以「命中率高」无法归因到显式的 `cache_control`
 * 标记上，换一个不做自动缓存的端点结论就会变。
 */
export function checkCacheControlUsage(
  route: CompatRoute,
  enabled: boolean
): CompatibilityResult {
  const name = 'cache_control 使用'
  if (!enabled) {
    return {
      key: 'check_cache_control',
      name,
      status: 'not_checked',
      detail: '套件 YAML 显式关闭了本检查项',
      riskText: '检查项已在套件 YAML 中关闭（关闭 ≠ 通过）',
    }
  }
  if (route.api !== ROUTE_API) {
    return {
      key: 'check_cache_control',
      name,
      status: 'not_checked',
      detail: `协议 ${JSON.stringify(route.api)} 不发送 cache_control，本项不适用`,
      riskText: '当前协议不发送 cache_control，本项不适用',
    }
  }
  return {
    key: 'check_cache_control',
    name,
    status: 'not_checked',
    detail:
      'harness 必然发送 cache_control（系统块 / 末条消息 / 末个工具，retention 默认 short），' +
      '但端点是否据此建立前缀缓存**无法静态判定**。' +
      '旁证（不等于判定，且自身就不稳定）：多批次连续运行时输入 token 的 94–99% 按命中价计费，' +
      '而一次相隔数小时的孤立运行是 **0% 命中**（成本恰好等于全价）—— 缓存会过期，冷启动必然全价。' +
      '另：DeepSeek 本身有自动前缀缓存，无法把功劳归给显式标记。' +
      '**本次未取得探针结论**（未提供该后端的密钥、套件关闭了本项探针，' +
      '或设了 `DSH_EVAL_NO_PROBE=1`），' +
      '所以仍按"没查"记 —— 这不是"查过了没问题"。' +
      '能验它的只有探针：见 `src/cache-probe.ts`（会真发 4 个请求，非零 token）。',
    riskText:
      '静态检查无法判定端点是否兑现，且本次未跑探针（未提供密钥或已关闭本项）',
  }
}

/**
 * 把若干检查项聚合成兼容性门结论。
 *
 * 聚合规则（与接受门一致）：
 *   - 任一 `fail` → `fail`（一票否决）
 *   - 否则任一 `not_checked` → `not_checked`（最多只能判「有条件迁移」）
 *   - 否则 → `pass`
 *
 * 单独导出，是因为 `cache-probe.ts` 会**回填**其中一项（把静态的 `not_checked`
 * 换成探针实测的结论），换完必须重新聚合一次 —— 两处用同一份规则，不能各写一遍。
 */
export function aggregateCompat(results: CompatibilityResult[]): CompatibilityReport {
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.name)
  const unchecked = results.filter((r) => r.status === 'not_checked').map((r) => r.name)
  const verdict = failed.length > 0 ? 'fail' : unchecked.length > 0 ? 'not_checked' : 'pass'
  return { results, verdict, unchecked, failed }
}

/**
 * 用一项新结果替换报告里的同 `key` 项，并重新聚合。
 *
 * 探针结果的落点：静态检查先跑（零 token、不发请求，缺 key 时也有内容），
 * 拿到 key 后再用探针的结论盖掉 `check_cache_control` 那一项。
 * 找不到该 `key` 时原样返回 —— 替换目标不存在不该把整趟评测搞崩。
 */
export function replaceCompatResult(
  report: CompatibilityReport,
  key: string,
  next: CompatibilityResult
): CompatibilityReport {
  if (!report.results.some((r) => r.key === key)) return report
  return aggregateCompat(report.results.map((r) => (r.key === key ? next : r)))
}

/**
 * 跑完两个检查项，聚合成兼容性门结论。
 *
 * **本函数是同步的、零 token 的**。`check_cache_control` 在这里恒为 `not_checked`；
 * 要把它变成实测结论，得由调用方在拿到密钥后再跑 `probeCacheControl()`
 * （见 `cache-probe.ts`）并用 `replaceCompatResult()` 回填。
 */
export function runCompatibilityChecks(
  route: CompatRoute,
  cfg: CompatibilityConfig | undefined
): CompatibilityReport {
  return aggregateCompat([
    checkSystemFieldFormat(route, cfg?.check_system_field_format !== false),
    checkCacheControlUsage(route, cfg?.check_cache_control !== false),
  ])
}
