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
    }
  }
  if (route.api !== ROUTE_API) {
    return {
      key: 'check_cache_control',
      name,
      status: 'not_checked',
      detail: `协议 ${JSON.stringify(route.api)} 不发送 cache_control，本项不适用`,
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
      '`cache_control` 的真实效力因此只能靠 v1.1 的探针请求验。',
  }
}

/**
 * 跑完两个检查项，聚合成兼容性门结论。
 *
 * 聚合规则（与接受门一致）：
 *   - 任一 `fail` → `fail`（一票否决）
 *   - 否则任一 `not_checked` → `not_checked`（最多只能判「有条件迁移」）
 *   - 否则 → `pass`
 */
export function runCompatibilityChecks(
  route: CompatRoute,
  cfg: CompatibilityConfig | undefined
): CompatibilityReport {
  const results = [
    checkSystemFieldFormat(route, cfg?.check_system_field_format !== false),
    checkCacheControlUsage(route, cfg?.check_cache_control !== false),
  ]
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.name)
  const unchecked = results.filter((r) => r.status === 'not_checked').map((r) => r.name)
  const verdict = failed.length > 0 ? 'fail' : unchecked.length > 0 ? 'not_checked' : 'pass'
  return { results, verdict, unchecked, failed }
}
