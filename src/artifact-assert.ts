/**
 * artifact-assert — 产物断言：查**工作区里的文件**，不查模型说了什么。
 *
 * 为什么需要它：`output_contains` 查的是 `final.text`，而模型最后那句话的措辞每次
 * 都不一样（实测「不编造」在同一任务上出现过 `不编造` / `未编造` / `不得编造` 三种
 * 写法）。拿措辞当判据，等于把随机性写进断言。
 *
 * 真正稳定的判据是**产物**：`main.mjs` 是不是跑得出 PASS、`report.json` 的内容对不对、
 * `deploy.json` 有没有被凭空造出来。这些在本项目实测里 24/24 稳定。
 *
 * ## 六种类型，只覆盖当前 5 个套件实际用到的
 *
 *   file_exists              文件存在
 *   file_not_exists          文件不存在（防"编造一份配置来完成任务"）
 *   file_content_contains    文件内容含某段文字
 *   file_json_equals         JSON **语义**相等（解析后深度比较，不是字符串相等）
 *   command_output_contains  在工作区跑一个脚本，stdout 含某段文字
 *   command_output_equals    同上，stdout 恰好等于某段文字
 *
 * 刻意**没有**实现 `file_content_equals` 等当前用不到的类型 —— 断言类型每多一种，
 * 就多一处要写测试、要维护语义的地方。需要时再加。
 *
 * ## `file_json_equals` 为什么不能用字符串相等
 *
 * 实测：模型写出的是 `{"topSku": "B-207", "qty": 48}`（键值之间带空格），而真值写作
 * `{"topSku":"B-207","qty":48}`。两者字符串不等，语义完全相同 —— 字符串相等会把
 * **正确的产物判成失败**。所以这里解析成 JS 值再深度比较：键序无关、空白无关、
 * 数组顺序敏感、数字按 `===` 比（`48` 与 `"48"` 不等）。
 *
 * ## 命令断言的安全边界
 *
 * 命令断言跑的是**工作区里被模型改过的文件**，这是一个真实的执行面。三层收窄：
 *
 *   1. `spawnSync(..., { shell: false })` —— 不经过 shell。`;` `&&` `` ` `` `$()`
 *      都不会被解释，只会当成普通的 argv 字符串。注入面直接消失。
 *   2. **解释器白名单**（目前只有 `node`），且 argv 形状必须是
 *      `["node", "<工作区内脚本的相对路径>"]` —— 恰好两个元素，不接受额外参数。
 *      这挡掉了 `node -e "<任意代码>"` 这类把断言变成任意代码执行的写法。
 *   3. **脚本路径必须落在工作区内**（`relative` 检查），且必须真实存在。
 *
 * 残余风险要说清楚：工作区里的脚本本身是模型改过的，`node main.mjs` 到底会做什么
 * 取决于模型写了什么。这一层挡不住 —— 它和"让 agent 在工作区里跑代码"是同一件事，
 * 本来就在评测范围内。白名单挡的是**断言配置**被写成任意命令，不是模型的行为。
 *
 * 已知未覆盖：脚本若挂起，靠 `timeout` 兜底（20s），而不是靠 kill 整个进程组。
 * 目前两个脚本都是毫秒级，够用；真出现僵尸子进程再补。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** 命令断言的超时。产物自检脚本都是毫秒级，20s 已经非常宽松。 */
const COMMAND_TIMEOUT_MS = 20_000

/** 允许执行的解释器白名单。目前只有 node —— 两个自检入口都是 .mjs。 */
const ALLOWED_BINARIES = new Set(['node'])

/** 读文件的上限。产物都是小文件，超过这个尺寸说明断言写错了目标。 */
const MAX_READ_BYTES = 1 << 20

/** 失败信息里回显内容时的截断长度，避免把整个文件塞进失败列表。 */
const ECHO_LIMIT = 240

/** 本模块负责的断言类型。`checkAssertions` 据此派发。 */
const ARTIFACT_TYPES = new Set([
  'file_exists',
  'file_not_exists',
  'file_content_contains',
  'file_json_equals',
  'command_output_contains',
  'command_output_equals',
])

export function isArtifactAssertType(type: string): boolean {
  return ARTIFACT_TYPES.has(type)
}

function echo(s: string): string {
  return s.length > ECHO_LIMIT ? `${JSON.stringify(s.slice(0, ECHO_LIMIT))}…（截断）` : JSON.stringify(s)
}

/**
 * 把断言里的相对路径解析到工作区内。
 *
 * 和 `eval_run_dual` 的 suite 路径守卫同一个道理：`../../etc/passwd` 这类输入
 * 不该能读到工作区外的文件。
 */
function resolveInWorkspace(
  workspace: string | undefined,
  rel: unknown,
  what: string
): { path: string } | { failure: string } {
  // 没声明 workspace 就执行产物断言，只可能是套件写错了 —— 此时**必须失败**，
  // 不能回退到 process.cwd()：那样断言会去查一个无关目录，查不到是误导性的失败，
  // 撞巧查到了则是**假通过**，而假通过比失败危险得多。
  if (workspace === undefined) {
    return { failure: `${what} 需要套件顶层声明 workspace，但该套件没有声明` }
  }
  const relStr = String(rel ?? '')
  if (relStr === '') return { failure: `${what} 缺少 path 字段` }

  const abs = resolve(workspace, relStr)
  const r = relative(workspace, abs)
  if (r.startsWith('..') || isAbsolute(r)) {
    return { failure: `${what} 的 path 越出工作区：${JSON.stringify(relStr)}` }
  }
  return { path: abs }
}

/** 读一个工作区内的文件，带尺寸上限。 */
function readArtifact(absPath: string, rel: string): { text: string } | { failure: string } {
  try {
    const size = statSync(absPath).size
    if (size > MAX_READ_BYTES) {
      return { failure: `文件 ${rel} 有 ${size} 字节，超过断言可读上限 ${MAX_READ_BYTES}` }
    }
    return { text: readFileSync(absPath, 'utf-8') }
  } catch (e) {
    return { failure: `读取文件 ${rel} 失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** JSON 语义深度比较：键序无关、数组顺序敏感、数字按 `===`（`48` ≠ `"48"`）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  if (ak.length !== Object.keys(bo).length) return false
  return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
}

/** 命令断言的公共部分：校验 argv 形状、解析脚本、执行、返回 stdout。 */
function runCommandAssert(
  a: Record<string, unknown>,
  workspace: string | undefined,
  type: string
): { stdout: string } | { failure: string } {
  const argv = a.command
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv.some((x) => typeof x !== 'string')
  ) {
    return {
      failure: `${type} 的 command 必须是 ["node", "<工作区内脚本的相对路径>"] 两个字符串，收到 ${echo(JSON.stringify(argv ?? null))}`,
    }
  }
  const [bin, script] = argv as [string, string]
  if (!ALLOWED_BINARIES.has(bin)) {
    return {
      failure: `${type} 只允许执行 ${[...ALLOWED_BINARIES].join(' / ')}，收到 ${JSON.stringify(bin)}`,
    }
  }

  const target = resolveInWorkspace(workspace, script, type)
  if ('failure' in target) return target
  if (!existsSync(target.path)) {
    return { failure: `${type} 要跑的脚本不存在：${JSON.stringify(script)}` }
  }

  // cwd 是工作区、参数是相对路径 —— 和模型自己跑这个脚本时的方式一致。
  // shell: false 是关键：shell 元字符不会被解释。
  const res = spawnSync(bin, [script], {
    cwd: workspace,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    encoding: 'utf-8',
  })
  if (res.error !== undefined && res.error !== null) {
    return { failure: `${type} 执行 ${JSON.stringify(script)} 失败：${res.error.message}` }
  }
  return { stdout: res.stdout ?? '' }
}

/**
 * 执行一条产物断言。返回 `undefined` 表示通过，否则返回失败描述。
 *
 * 失败信息里要带**期望与实际**，否则失败列表只说得出"没过"，说不出"为什么"。
 */
export function checkArtifactAssert(
  a: Record<string, unknown>,
  workspace: string | undefined
): string | undefined {
  const type = String(a.type ?? '')

  if (type === 'file_exists' || type === 'file_not_exists') {
    const target = resolveInWorkspace(workspace, a.path, type)
    if ('failure' in target) return target.failure
    const rel = String(a.path)
    const exists = existsSync(target.path)
    if (type === 'file_exists' && !exists) {
      return `文件不存在：${rel}（工作区 ${workspace}）`
    }
    if (type === 'file_not_exists' && exists) {
      return `文件不应存在，但存在：${rel} —— 产物里出现了不该有的文件`
    }
    return undefined
  }

  if (type === 'file_content_contains') {
    const target = resolveInWorkspace(workspace, a.path, type)
    if ('failure' in target) return target.failure
    const rel = String(a.path)
    if (!existsSync(target.path)) return `文件不存在：${rel}（工作区 ${workspace}）`
    const read = readArtifact(target.path, rel)
    if ('failure' in read) return read.failure
    const want = String(a.text ?? '')
    if (!read.text.includes(want)) {
      return `文件 ${rel} 的内容未包含 ${echo(want)}`
    }
    return undefined
  }

  if (type === 'file_json_equals') {
    const target = resolveInWorkspace(workspace, a.path, type)
    if ('failure' in target) return target.failure
    const rel = String(a.path)
    if (!existsSync(target.path)) return `文件不存在：${rel}（工作区 ${workspace}）`
    const read = readArtifact(target.path, rel)
    if ('failure' in read) return read.failure

    let actual: unknown
    try {
      actual = JSON.parse(read.text)
    } catch (e) {
      return `文件 ${rel} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
    }
    if (!deepEqual(actual, a.value)) {
      return `文件 ${rel} 的 JSON 与期望不符：期望 ${echo(JSON.stringify(a.value))}，实际 ${echo(JSON.stringify(actual))}`
    }
    return undefined
  }

  if (type === 'command_output_contains' || type === 'command_output_equals') {
    const run = runCommandAssert(a, workspace, type)
    if ('failure' in run) return run.failure
    const want = String(a.text ?? '')
    const out = run.stdout
    if (type === 'command_output_contains') {
      if (!out.includes(want)) {
        return `命令输出的内容未包含 ${echo(want)}，实际输出 ${echo(out.trim())}`
      }
      return undefined
    }
    // equals：只比内容，但把退出码带进失败信息——脚本崩了和脚本输出错了
    // 是两回事，失败列表要能分辨。
    if (out.trim() !== want) {
      return `命令输出不等于 ${echo(want)}，实际输出 ${echo(out.trim())}`
    }
    return undefined
  }

  return `未实现的产物断言类型 ${JSON.stringify(type)}`
}

/** 供离线回归直接验证深度比较语义。 */
export const __testDeepEqual = deepEqual
