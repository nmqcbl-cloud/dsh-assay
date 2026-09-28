/**
 * cache-probe — 兼容性门的**探针请求**（v1.1）。
 *
 * ## 它补的是哪个洞
 *
 * `compatibility-check.ts` 的 `cache_control 使用` 一项静态判不了，恒返回
 * `not_checked`，于是整趟判定**出不了「可迁移」**。这是 v1.0 的预期状态
 * （见 `docs/v1-release.md` 第四节）。本模块是让它脱离 `not_checked` 的唯一途径。
 *
 * ## 探的是什么：两分支对照，四请求
 *
 * 静态判不了的原因是**归因**：DeepSeek 这类端点自带自动前缀缓存，所以
 * 「第二次请求命中了」这件事本身证明不了是 `cache_control` 标记起的作用。
 * 只发一对请求，得到的结论是"缓存生效了"，而不是"标记生效了"——**那是个假通过**。
 *
 * 所以本模块跑**两个分支**，每个分支连发两次同一前缀：
 *
 * ```
 *   A 分支（带标记）：POST#1 冷 → POST#2 热     ← 第 2 次的 cache_read 测"有没有缓存"
 *   B 分支（不带标记）：POST#1 冷 → POST#2 热   ← 对照组，测"是不是标记的功劳"
 * ```
 *
 * 两个分支用**不同**的前缀文本，免得互相污染缓存。四种组合各有确定含义：
 *
 * | A 热读 | B 热读 | 含义 |
 * |---|---|---|
 * | >0 | 0 | 标记是缓存生效的必要条件 —— 最好的结果 |
 * | >0 | >0 | 端点自动缓存，**标记不可归因**（但仍兑现了缓存） |
 * | 0 | —— | 端点接受标记但不兑现缓存 |
 * | 400 | —— | 端点拒收 `cache_control` —— **请求根本发不出去** |
 *
 * ## 冷热之间必须**等**：缓存写入有不可见期（实测，2026-09-29）
 *
 * 这是本模块**唯一一处非显然的时序要求**，第一版漏了它，真跑端点时立刻暴露：
 *
 * ```
 *   deepseek-flash   冷 → 隔    0ms → 热：命中
 *   deepseek-v4-pro  冷 → 隔    0ms → 热：**未命中**   ← 亚秒级间隔读不到
 *   deepseek-v4-pro  冷 → 隔  500ms → 热：命中
 *   deepseek-v4-pro  冷 → 隔 1000/2000/5000ms → 热：全部命中
 * ```
 *
 * 也就是说：第 1 次请求建立的缓存**不是立刻**对第 2 次可见的，端点侧有一段
 * 写入→可见的延迟（不同模型长短不同，flash 观察不到，pro 超过 0 而不到 500ms）。
 * 若第 2 次紧贴着发出去，pro 会读到 `cache_read=0` —— 而真实情况是**缓存好着呢**。
 * 那会落进上表第 3 行，产出一条**假阴性**的成本结论（"接受标记但不兑现"），
 * 并且以 ℹ️ 风险的形式写进报告。**这正是两分支对照要防的那类错误，只是发生在时间轴上。**
 *
 * 所以 `runArm` 在冷热之间插入 `settleMs`（默认 2000ms，是实测阈值 500ms 的 4 倍余量）。
 * 两个分支仍用 `Promise.all` 并行，所以整趟探针只多花约一个 `settleMs`。
 *
 * ## 前缀不能跨次复用（同一个坑的另一半）
 *
 * 第一版把前缀种子写死。真连跑两次就露馅了：**第二次运行的"冷"请求直接命中
 * 上一次留下的缓存**（实测两份缓存都活了 15 分钟以上），于是
 *   - "冷 → 热"这个观察退化 —— 探针看不到缓存的**建立**，只看到它早就建好了；
 *   - 更糟的是它**能造成假通过**：端点即便已经停止缓存，几分钟前的旧条目
 *     在 TTL 内仍然会应答，探针照样报"缓存生效"。
 *
 * 所以每次探针用**当次**的种子造前缀（内容形状仍是确定性的随机音节，变的只是种子）。
 * 这与本仓库的既有口径一致：前缀缓存有 TTL，任何跨轮的绝对量都不可比 ——
 * 探针要测的是**当次**行为，前缀就必须是当次的。两个分支各取互不相同的种子。
 *
 * ## 判定口径：拒绝才否决，不兑现只算成本
 *
 * 这一点必须和本仓库既有的论证保持一致（见 `verdict.ts` 文件头）：
 * **成本门从不否决，「把成本写进否决是范畴错误」。**
 *
 * 探针的两种负面结果分属两个范畴，处置因此不同：
 *
 *   - **端点拒收 `cache_control`（HTTP 4xx）→ `fail`（一票否决）。**
 *     这是**正确性**问题：harness 每次请求都必发 `cache_control`
 *     （系统块 / 末条消息 / 末个工具），端点拒收等于一次对话都发不出去。
 *   - **端点接受但不兑现 → `pass` + `infoText`（ℹ️ 风险，不否决）。**
 *     这是**成本**问题：请求发得出去、任务做得完，只是前缀缓存不生效、
 *     省钱的优势不成立。按上一条口径，它不能把判定压成「不可迁移」。
 *
 * ## 探针必须复刻 harness 的请求形状
 *
 * 否则验的不是同一个东西。具体到两处：
 *   - 鉴权用 `x-api-key`（pi-ai 的 anthropic provider 就是这么发的），**不是** Bearer。
 *   - 路径是 `<baseUrl>/v1/messages`，`system` 以内容块数组发送、`cache_control`
 *     挂在**系统块**上（pi-ai 挂的就是这三处）。
 *
 * ## 本模块不是"零 token"
 *
 * 静态两项是零 token，探针不是 —— 4 次请求、每次前缀约 2.5k token。
 * 实耗会写进 `detail`，报告里看得到。**不许把有成本的东西说成没成本。**
 */

import type { CompatRoute, CompatibilityResult } from './compatibility-check.js'

/**
 * Anthropic 兼容端点要求的版本头。pi-ai 发的是这个值，探针照发。
 */
const ANTHROPIC_VERSION = '2023-06-01'

/** 单个请求的超时。探针是评测的前置步骤，不能让它把整趟挂住。 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 冷请求与热请求之间的**等待**（毫秒）。
 *
 * 存在的理由见文件头「冷热之间必须等」：端点把缓存**写进去**和让后续请求**读得到**
 * 之间有一段延迟。实测 deepseek-v4-pro 在亚秒间隔下读不到、≥500ms 就能读到；
 * 2000ms 是 4 倍余量。**这个值不能图快调小** —— 调小不会报错，只会静默产出假阴性。
 */
const DEFAULT_SETTLE_MS = 2000

/**
 * 前缀长度（字符）。
 *
 * 必须**明显超过** Anthropic 的最小可缓存长度（1024 token），否则"没观察到缓存"
 * 分不清是端点不兑现还是前缀太短。~7000 字符的随机音节大约 2.5k token（实测）。
 */
const DEFAULT_PREFIX_CHARS = 7000

/**
 * 造前缀用的音节表。
 *
 * 要的是**不像自然语言**（免得被端点的语义去重或压缩搅进来）和**长度可控**，
 * 真随机没必要；而且拼接注定会重复，正好也不影响 —— 端点缓存的是前缀本身。
 */
const SYLLABLES = [
  'ka', 'to', 'ri', 'nu', 'me', 'sa', 'vo', 'li', 'pa', 'shu',
  'dem', 'gor', 'tal', 'ven', 'zor', 'qui', 'nex', 'pla', 'rom', 'fel',
]

/**
 * 用线性同余发生器造一段伪随机文本。**给定 seed 是确定的**，但 seed 由调用方给。
 *
 * ⚠️ 别把这里的"确定"读成"跨次可复现"：调用方 `probeCacheControl` **每次给新 seed**，
 * 因为前缀跨次复用会让探针退化甚至假通过，理由见文件头「前缀不能跨次复用」。
 * 同一趟里两个分支拿到的是不同前缀（不同 seed），对照才成立。
 */
function makePrefix(seed: number, chars: number): string {
  let s = seed >>> 0
  const next = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 4294967296
  }
  const words: string[] = []
  let len = 0
  while (len < chars) {
    const w =
      SYLLABLES[Math.floor(next() * SYLLABLES.length)]! +
      SYLLABLES[Math.floor(next() * SYLLABLES.length)]! +
      SYLLABLES[Math.floor(next() * SYLLABLES.length)]!
    words.push(w)
    len += w.length + 1
  }
  return words.join(' ')
}

/** 一次响应的 usage 三档计数（+ 输出）。 */
export interface AttemptUsage {
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
}

/** 一次请求的结果。三条互斥的出路：传输层失败 / 非 2xx / 2xx（可能带 usage）。 */
interface Attempt {
  /** HTTP 状态码。传输层失败时为 `undefined`。 */
  status?: number
  /** 传输层错误（超时、DNS、连接被拒……）。 */
  transportError?: string
  /** 2xx 且响应里有 `usage` 时才有。没有它就是**读不到计数**，不是"计数为 0"。 */
  usage?: AttemptUsage
  /** 非 2xx 时端点回的错误正文（截断），用于把 HTTP 400 的原因带进报告。 */
  errorBody?: string
}

function isOk(a: Attempt): boolean {
  return a.status !== undefined && a.status >= 200 && a.status < 300
}

/** 端点**拒收请求体**：这才是正确性问题。 */
function isRejection(a: Attempt): boolean {
  return a.status === 400 || a.status === 422
}

/** 鉴权问题与端点能力无关，不能算它头上。 */
function isAuthFailure(a: Attempt): boolean {
  return a.status === 401 || a.status === 403
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 一次探针请求的**原始证据**。
 *
 * 存在的理由：`CompatibilityResult.detail` 是给报告看的**摘要**，
 * 而"探针到底验出了什么"需要**原始读数** —— 每个请求的状态码、usage 三个计数。
 * 出结论时若只有摘要，读者只能选择信或不信。有了它，结论可以逐条追到请求上。
 */
export interface ProbeAttemptInfo {
  /** 属于哪个分支：带 `cache_control` 标记 / 对照（不带）。 */
  arm: 'marked' | 'plain'
  /**
   * 分支内的第几次：1 = 第一次，2 = 第二次（**同一前缀**，间隔 `settleMs`）。
   *
   * 正常情况下 1 是冷的、2 是热的；但若前缀恰好被更早的某次运行暖过，
   * 1 也会读到缓存 —— 所以这里不写"冷/热"，只写序次，免得替读数下结论。
   */
  nth: 1 | 2
  /** 请求发往的 URL。 */
  url: string
  /** 该次请求带的**前缀字符数**（不是 token 数）。 */
  prefixChars: number
  /** HTTP 状态码；传输层失败时 undefined。 */
  status?: number
  /** 传输层错误。 */
  transportError?: string
  /** 2xx 且响应带 usage 时才有 —— **没有就代表读不到计数**。 */
  usage?: AttemptUsage
  /** 非 2xx 时端点回的错误正文。 */
  errorBody?: string
}

/** 探针的可注入点。测试靠它把网络换成桩。 */
export interface ProbeOptions {
  /** 替换 `fetch`。离线测试注入桩函数，**保证零联网**。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 前缀字符数。仅测试用。 */
  prefixChars?: number
  /**
   * 冷请求与热请求之间的等待（毫秒），默认 {@link DEFAULT_SETTLE_MS}。
   *
   * **离线测试必须传 0**：桩 `fetch` 是同步返回的，没有端点侧延迟可言，
   * 等待只会让测试白慢 2 秒一组。真实端点**不要**传 0 —— 那会静默产出假阴性。
   */
  settleMs?: number
  /**
   * 每发一次请求就回调一次（**只观测，不参与判定**）。
   * 跑真实端点时用它把四分支的原始读数打出来。
   */
  onAttempt?: (info: ProbeAttemptInfo) => void
}

/**
 * 发一次请求。
 *
 * 不复用 `model-router.ts` 的 `buildPatchConfig` —— 那个生成的是给 dsh 的
 * **声明式路由 YAML**，不是 HTTP 请求体。两者形状无关，硬凑只会更难读。
 */
/** 端点的 messages 路径。pi-ai 的 anthropic provider 就是这么拼的。 */
function messagesUrl(route: CompatRoute): string {
  return `${route.baseUrl.replace(/\/+$/, '')}/v1/messages`
}

/** 真正发请求。观测钩子在 `sendOnce` 里统一挂，免得每个 return 点都写一遍。 */
async function sendOnceRaw(
  route: CompatRoute,
  apiKey: string,
  prefix: string,
  marker: boolean,
  opts: ProbeOptions
): Promise<Attempt> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = messagesUrl(route)

  // 带标记分支：cache_control 挂在**系统块**上 —— pi-ai 挂的正是系统块 /
  // 末条消息 / 末个工具这三处，而前缀就在系统块里，所以这里挂它最贴近真实。
  const system = marker
    ? [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }]
    : [{ type: 'text', text: prefix }]

  const payload = {
    model: route.model,
    // 只要 1 个 token：探针测的是 usage 计数，不是模型输出。
    max_tokens: 1,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
  }

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 与 harness 一致：pi-ai 的 anthropic provider 用 x-api-key。
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { status: res.status, errorBody: body.slice(0, 300) }
    }

    const json = (await res.json()) as { usage?: Record<string, unknown> | null }
    if (json.usage === undefined || json.usage === null) {
      // 200 但没有 usage → 读不到缓存计数。**不能当成"计数为 0"**：
      // 那会把"端点没报"误判成"端点没缓存"，进而得出一个没依据的结论。
      return { status: res.status }
    }
    const u = json.usage
    return {
      status: res.status,
      usage: {
        inputTokens: num(u['input_tokens']),
        cacheRead: num(u['cache_read_input_tokens']),
        cacheWrite: num(u['cache_creation_input_tokens']),
        outputTokens: num(u['output_tokens']),
      },
    }
  } catch (e) {
    return { transportError: e instanceof Error ? e.message : String(e) }
  }
}

/** 一个分支：连发两次同一前缀。第二次没发成（或第一次就失败）时 `second` 为 `undefined`。 */
interface Arm {
  first: Attempt
  second?: Attempt
}

/**
 * 发一次请求并把原始读数报给观测者。
 *
 * `arm` / `nth` 是**发出前就知道**的事实，不能从响应里推 ——
 * 所以在这里传入，而不是让观察者去猜哪个响应对应哪一支。
 */
async function sendOnce(
  route: CompatRoute,
  apiKey: string,
  prefix: string,
  marker: boolean,
  opts: ProbeOptions,
  arm: 'marked' | 'plain',
  nth: 1 | 2
): Promise<Attempt> {
  const attempt = await sendOnceRaw(route, apiKey, prefix, marker, opts)
  opts.onAttempt?.({ arm, nth, url: messagesUrl(route), prefixChars: prefix.length, ...attempt })
  return attempt
}

async function runArm(
  route: CompatRoute,
  apiKey: string,
  prefix: string,
  marker: boolean,
  opts: ProbeOptions,
  arm: 'marked' | 'plain'
): Promise<Arm> {
  const first = await sendOnce(route, apiKey, prefix, marker, opts, arm, 1)
  if (!isOk(first)) return { first }
  // **必须等。** 紧贴着发第二次会读到 cache_read=0，而缓存其实是好的 ——
  // 端点侧写入→可见有延迟，见文件头「冷热之间必须等」。第一版漏了这一步，
  // 真跑 deepseek-v4-pro 时得到的就是假阴性。
  await sleep(opts.settleMs ?? DEFAULT_SETTLE_MS)
  const second = await sendOnce(route, apiKey, prefix, marker, opts, arm, 2)
  return { first, second }
}

/** 等待。抽出来只为了上面那处有名字可讲，不引第三方依赖。 */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 探针实测花掉的输入 token（未命中 + 命中 + 写入）。用于在报告里诚实标注。 */
function spentTokens(arms: Arm[]): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const arm of arms) {
    for (const a of [arm.first, arm.second]) {
      if (a?.usage === undefined) continue
      input += a.usage.inputTokens + a.usage.cacheRead + a.usage.cacheWrite
      output += a.usage.outputTokens
    }
  }
  return { input, output }
}

function spentNote(arms: Arm[]): string {
  const { input, output } = spentTokens(arms)
  return `（本项探针实耗输入 ${input} / 输出 ${output} token —— 探针不是零 token，静态两项才是）`
}

/** 探针没能跑成时的统一出口：退回 `not_checked`，理由写清楚。 */
function inconclusive(reason: string, arms: Arm[]): CompatibilityResult {
  return {
    key: 'check_cache_control',
    name: 'cache_control 使用',
    status: 'not_checked',
    detail: `探针未能判定：${reason} ${spentNote(arms)}`.trim(),
    riskText: `探针未能判定（${reason}），端点是否兑现 cache_control 仍未检测`,
  }
}

/**
 * 跑探针，给 `cache_control 使用` 一项下结论。
 *
 * @param route - 待判的路由（**候选**后端 —— 迁移要回答的是"换过去行不行"）。
 * @param apiKey - 该后端 `apiKeyEnv` 指向的密钥**值**。只在内存里传给 fetch，
 *   不落盘、不进日志、不写进返回的 `detail`。
 * @returns 一项 `CompatibilityResult`，形状与静态检查项一致，可直接替换进报告。
 */
export async function probeCacheControl(
  route: CompatRoute,
  apiKey: string,
  opts: ProbeOptions = {}
): Promise<CompatibilityResult> {
  const chars = opts.prefixChars ?? DEFAULT_PREFIX_CHARS
  // 每次探针用**新**前缀（种子带本次的随机量），理由见文件头「前缀不能跨次复用」。
  // 两个分支取互不相同的种子：同一个前缀会让 B 分支蹭到 A 分支的缓存，
  // 对照就失效了 —— 那正是本设计要防的归因错误。
  const nonce = (Date.now() ^ Math.floor(Math.random() * 0x1_0000_0000)) >>> 0
  const markedPrefix = makePrefix(nonce, chars)
  const plainPrefix = makePrefix((nonce ^ 0x5eed_beef) >>> 0, chars)

  // 两条链各自串行（第 2 次依赖第 1 次暖好的缓存），链与链之间并行 —— 少一个往返。
  const [armMarked, armPlain] = await Promise.all([
    runArm(route, apiKey, markedPrefix, true, opts, 'marked'),
    runArm(route, apiKey, plainPrefix, false, opts, 'plain'),
  ])
  const arms = [armMarked, armPlain]

  // ── 带标记分支第 1 次就失败了：先看失败类型 ──────────────────────────────
  if (!isOk(armMarked.first)) {
    if (isRejection(armMarked.first)) {
      const st = armMarked.first.status
      const body = armMarked.first.errorBody ?? ''
      return {
        key: 'check_cache_control',
        name: 'cache_control 使用',
        status: 'fail',
        detail:
          `探针请求（带 cache_control）被端点拒绝：HTTP ${st}` +
          (body ? ` —— ${body}` : '') +
          '。harness 每次请求都会发送 cache_control（系统块 / 末条消息 / 末个工具），' +
          '端点拒收它意味着**一次对话都发不出去** —— 这是正确性问题，一票否决。' +
          spentNote(arms),
        riskText: `端点拒收 cache_control（HTTP ${st}），而 harness 每次请求必发它 —— 请求无法发出`,
      }
    }
    if (isAuthFailure(armMarked.first)) {
      return inconclusive(
        `鉴权失败（HTTP ${armMarked.first.status}）—— 密钥无效或无权访问该端点，与端点能力无关`,
        arms
      )
    }
    if (armMarked.first.transportError !== undefined) {
      return inconclusive(`请求未送达（${armMarked.first.transportError}）`, arms)
    }
    return inconclusive(`端点返回 HTTP ${armMarked.first.status}`, arms)
  }

  const cold = armMarked.first.usage
  if (cold === undefined) {
    return inconclusive('端点响应里没有 usage 字段，读不到缓存计数', arms)
  }
  if (armMarked.second === undefined || !isOk(armMarked.second)) {
    return inconclusive('带标记分支的第 2 次请求未成功，无法比对冷热两次', arms)
  }
  const warm = armMarked.second.usage
  if (warm === undefined) {
    return inconclusive('带标记分支第 2 次响应里没有 usage 字段', arms)
  }

  const numbers =
    `带标记分支：第 1 次 cache_write=${cold.cacheWrite} / cache_read=${cold.cacheRead}，` +
    `第 2 次（同一前缀）cache_read=${warm.cacheRead}`

  // ── 端点兑现了缓存 ──────────────────────────────────────────────────────
  if (warm.cacheRead > 0) {
    // 对照分支的读数：**取不到就是取不到**，不能 `?? 0`。
    // `?? 0` 会把"响应里没有 usage"混同于"读到了 0 次命中"，于是把
    // "标记是否必要"误判成"必要" —— 又是把"没读到"当成"没发生"。
    const controlUsage = isOk(armPlain.second ?? {}) ? armPlain.second?.usage : undefined
    const controlRead = controlUsage === undefined ? null : controlUsage.cacheRead
    if (controlRead === null) {
      return {
        key: 'check_cache_control',
        name: 'cache_control 使用',
        status: 'pass',
        detail:
          `端点兑现了前缀缓存。${numbers}；` +
          '对照分支（不发 cache_control）本次未能取到读数，**标记是否必要无法归因** —— ' +
          '结论只能到"缓存确实生效"这一档。' +
          spentNote(arms),
      }
    }
    if (controlRead > 0) {
      return {
        key: 'check_cache_control',
        name: 'cache_control 使用',
        status: 'pass',
        detail:
          `端点兑现了前缀缓存。${numbers}；` +
          `但**对照分支（不发 cache_control）第 2 次也命中**（cache_read=${controlRead}）—— ` +
          '说明该端点有自动前缀缓存，命中无法归因给显式标记。' +
          '对迁移的结论不变：缓存会生效、成本优势成立；只是这份优势不依赖 cache_control 标记。' +
          spentNote(arms),
      }
    }
    return {
      key: 'check_cache_control',
      name: 'cache_control 使用',
      status: 'pass',
      detail:
        `端点兑现了前缀缓存，且**对照分支未命中**（不发 cache_control 时 cache_read=0）—— ` +
        `标记是缓存生效的必要条件。${numbers}。${spentNote(arms)}`,
    }
  }

  // ── 端点接受、但不兑现：正确性没问题，是成本问题 ─────────────────────────
  //
  // 这一条**刻意不判 fail**。判 fail 会一票否决迁移，而"缓存不生效"并不影响
  // 任务能否完成 —— 按本仓库的口径（`verdict.ts`：把成本写进否决是范畴错误），
  // 它只能以 ℹ️ 风险出现，不能把判定压成「不可迁移」。
  const controlNote =
    armPlain.second?.usage !== undefined
      ? `；对照分支第 2 次 cache_read=${armPlain.second.usage.cacheRead}`
      : ''
  // 前缀多大，**用实测的**，不要用 `chars / 4` 去估 —— 这个合成前缀实测 ≈2.5k token
  // （7000 字符），而 `/4` 会算出 1750，把"探了多大的前缀"说小近三分之一。
  // 第 1 次请求的 usage 里就有真数：三档相加即该次的总输入。
  const prefixTokens = cold.inputTokens + cold.cacheRead + cold.cacheWrite
  return {
    key: 'check_cache_control',
    name: 'cache_control 使用',
    status: 'pass',
    detail:
      `端点接受 cache_control（未拒收），但在约 ${prefixTokens} token 的前缀上` +
      `**未观察到缓存生效**：${numbers}${controlNote}。` +
      '前端缓存不生效**不影响请求能否发出**，因此不否决迁移；' +
      '但成本优势不成立，见风险清单。' +
      spentNote(arms),
    infoText:
      'cache_control 使用：端点接受标记但不兑现（同一前缀二次请求 cache_read=0），' +
      '前缀缓存不会带来成本收益 —— 这是成本问题，不否决迁移',
  }
}
