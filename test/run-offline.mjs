#!/usr/bin/env node
/**
 * 离线回归测试：**零成本、不联网**。
 *
 * 用一个桩 `dsh`（`test/stubs/`）喂进按真实事件形状构造的 NDJSON，驱动
 * `runOneBackend` 走完全程。覆盖解析 / 断言 / 计价 / 降级 / 预算五条路径。
 *
 * 真正需要联网验证的只有一件事：路由能不能打通 DeepSeek。那件事用一次
 * `DEEPSEEK_API_KEY=... dsh --profile eval-runner headless --json "..."` 验一次即可；
 * 本文件负责保证「除了联网之外的每一行代码」都不会悄悄坏掉。
 *
 * 用法：`npm run test:offline`（会先自动 build）。
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SUITE = join(ROOT, 'suites/dual-backend/basic.yml')

const mk = (id, model) => ({
  id,
  displayName: model,
  baseUrl: 'https://api.deepseek.com/anthropic',
  model,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
})
const V4PRO = mk('deepseek-v4-pro', 'deepseek-v4-pro')
const FLASH = mk('deepseek-flash', 'deepseek-flash')
// 合成一个 apiKeyEnv 未设置的后端，专门验降级分支（当前套件配置不会触发它）。
const NOKEY = { ...V4PRO, id: 'ghost', apiKeyEnv: 'ANTHROPIC_API_KEY' }

const failures = []
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

// 桩脚本带 shebang，spawn 直接执行它 —— 需要执行位。
// 显式 chmod，避免换机器/换 checkout 方式后丢掉权限位。
for (const s of ['dsh-ok', 'dsh-steps', 'dsh-401', 'dsh-budget'])
  chmodSync(join(HERE, 'stubs', s), 0o755)

let seq = 0
/**
 * 拿一份全新的 eval-runner 模块实例。
 *
 * `DSH_EVAL_DSH_BIN` 是在模块加载时求值的模块级常量，所以要换桩就必须换模块实例
 * —— 加个 query 后缀把 ESM 缓存绕开。
 */
async function loadRunner(stub) {
  process.env.DSH_EVAL_DSH_BIN = join(HERE, 'stubs', stub)
  process.env.DEEPSEEK_API_KEY = 'sk-offline-stub'
  delete process.env.ANTHROPIC_API_KEY
  return import(`${ROOT}/dist/eval-runner.js?case=${seq++}`)
}

const reporter = await import(`${ROOT}/dist/compare-reporter.js`)
const { computeCostUSD } = await import(`${ROOT}/dist/pricing.js`)

// ── 1. 成功路径 ────────────────────────────────────────────────────────────
console.log('\n1. 成功路径（1 步，含插件噪声行）')
{
  const { runOneBackend } = await loadRunner('dsh-ok')
  const r = await runOneBackend(SUITE, V4PRO)
  const expect = (254 * 0.66 + 5248 * 0.022 + 62 * 1.98) / 1e6
  check('passed 1/1', r.passed === 1 && r.total === 1, `${r.passed}/${r.total}`)
  check('inputTokens = 未命中 + 命中 + 写入', r.inputTokens === 254 + 5248, String(r.inputTokens))
  check('outputTokens', r.outputTokens === 62, String(r.outputTokens))
  check('avgSteps', r.avgSteps === 1, String(r.avgSteps))
  check(
    '成本精确等于三档手算值',
    Math.abs(r.costUSD - expect) < 1e-12,
    `${r.costUSD} vs ${expect}`,
  )
  check('无失败用例', r.failedCases.length === 0, JSON.stringify(r.failedCases))
}

// ── 2. 断言失败 ────────────────────────────────────────────────────────────
console.log('\n2. 断言失败（6 步 > max_steps 5，且输出不含断言词）')
{
  const { runOneBackend } = await loadRunner('dsh-steps')
  const r = await runOneBackend(SUITE, FLASH)
  check('passed 0/1', r.passed === 0 && r.total === 1, `${r.passed}/${r.total}`)
  check(
    'max_steps 被捕获',
    r.failedCases.some((c) => c.includes('步数 6 超过上限 5')),
    JSON.stringify(r.failedCases),
  )
  check(
    'output_contains 被捕获',
    r.failedCases.some((c) => c.includes('未包含')),
    JSON.stringify(r.failedCases),
  )
}

// ── 3. 后端返回 401 ────────────────────────────────────────────────────────
console.log('\n3. 后端鉴权失败')
{
  const { runOneBackend } = await loadRunner('dsh-401')
  const r = await runOneBackend(SUITE, V4PRO)
  check('判定为整体失败', r.passed === 0 && r.total === 1)
  // 这条是回归重点：失败详情在 turn_end.reason.error.message，只取 kind 会把 401 丢掉。
  check(
    '错误详情取自 turn_end.reason.error.message',
    r.failedCases.some((c) => c.includes('401') && c.includes('Authentication Fails')),
    JSON.stringify(r.failedCases),
  )
}

// ── 4. 缺 key 优雅降级 ─────────────────────────────────────────────────────
console.log('\n4. 缺 key → 优雅降级（不抛异常）')
{
  const { runOneBackend } = await loadRunner('dsh-ok')
  let threw = null
  let r = null
  try {
    r = await runOneBackend(SUITE, NOKEY)
  } catch (e) {
    threw = e
  }
  check('未抛异常', threw === null, String(threw))
  check('total 为 0 而非 1', r?.total === 0, String(r?.total))
  check(
    '带上未配置哨兵',
    r?.failedCases[0] === '未配置：ANTHROPIC_API_KEY',
    JSON.stringify(r?.failedCases),
  )
  check('哨兵被报告层识别', reporter.isSkipped(r))
}

// ── 5. 报告渲染 ────────────────────────────────────────────────────────────
console.log('\n5. 报告渲染（两列数字必须不同）')
{
  const a = await loadRunner('dsh-ok')
  const b = await loadRunner('dsh-steps')
  const baseline = await a.runOneBackend(SUITE, V4PRO)
  const candidate = await b.runOneBackend(SUITE, FLASH)
  const text = reporter.renderReport({
    baseline,
    candidate,
    comparison: reporter.generateComparison(baseline, candidate),
  })
  console.log(
    text
      .split('\n')
      .map((l) => `     ${l}`)
      .join('\n'),
  )
  check('含成本(CNY) 行', text.includes('成本(CNY)'))
  check('含成本口径说明', text.includes('💡 成本说明'))
  check('两列 Token 不同（路由未坍缩）', baseline.inputTokens !== candidate.inputTokens)
  check('含失败用例明细段', text.includes('失败用例（'))
}

// ── 6. 单边跳过时的渲染 ────────────────────────────────────────────────────
console.log('\n6. 单边跳过 → 对比指标渲染成 —')
{
  const m = await loadRunner('dsh-ok')
  const baseline = await m.runOneBackend(SUITE, NOKEY)
  const candidate = await m.runOneBackend(SUITE, FLASH)
  const text = reporter.renderReport({
    baseline,
    candidate,
    comparison: reporter.generateComparison(baseline, candidate),
  })
  check('跳过列渲染为 —', text.includes('—'))
  check('对比指标不输出数字', text.includes('通过率变化：—'))
  check('给出跳过提示', text.includes('未配置'))
  // 反面：0 是「跑了得 0 分」，— 是「根本没跑」，不能混。
  check('未把未配置读成 0/0', !text.includes('0/0'))
}

// ── 7. 预算上限中断 ────────────────────────────────────────────────────────
console.log('\n7. 预算超限 → 中断')
{
  const { runOneBackend } = await loadRunner('dsh-steps')
  const r = await runOneBackend(SUITE, V4PRO, 1e-7)
  check(
    '记入预算超限中断',
    r.failedCases.some((c) => c.includes('预算超限中断')),
    JSON.stringify(r.failedCases),
  )
}

// ── 8. 计价表缺模型要显式喊出来 ────────────────────────────────────────────
console.log('\n8. 计价表缺模型 → 显式标注，不静默记 0')
{
  const { runOneBackend } = await loadRunner('dsh-ok')
  const r = await runOneBackend(SUITE, { ...V4PRO, model: 'some-unknown-model' })
  check('成本为 0', r.costUSD === 0)
  check(
    '但明确标注缺价格',
    r.failedCases.some((c) => c.includes('计价表缺少模型')),
    JSON.stringify(r.failedCases),
  )
  check('computeCostUSD 报 priced=false', computeCostUSD('some-unknown-model', {
    inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
  }).priced === false)
}

// ── 9. eval_run_dual 的整趟预算池 + suite 路径守卫 ─────────────────────────
console.log('\n9. eval_run_dual：整趟预算池（余额分发）+ suite 路径守卫')
{
  // 计价必须钉死在谷时。峰时单价翻倍会把 budget-probe.yml 里那个
  // (baseline, baseline+candidate) 窗口整体挪走，fixture 的 budgetCNY 就失准了。
  // 把「今天」（北京时区）塞进节假日表，isPeakHour 即恒为 false。
  const beijingToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  process.env.DSH_EVAL_CN_HOLIDAYS = beijingToday
  process.env.DSH_EVAL_DSH_BIN = join(HERE, 'stubs', 'dsh-budget')
  process.env.DEEPSEEK_API_KEY = 'sk-offline-stub'

  // index.js 静态 import 的是**不带 query** 的 ./eval-runner.js，与上面那些
  // `?case=N` 实例互不干扰，因此这里设的环境变量对它生效。
  const { apply } = await import(`${ROOT}/dist/index.js`)
  const mount = (suiteDir) => {
    let tool
    apply({ tools: { register: (t) => { tool = t }, get: () => tool } }, { suiteDir })
    return tool
  }
  const toolLoose = mount(join(ROOT, 'suites'))
  const toolProbe = mount(join(HERE, 'fixtures'))

  // 9a. 预算宽裕 → 两个后端都得跑完（回归：分发逻辑没把常规跑法跑坏）
  const loose = await toolLoose.execute({ suite: 'dual-backend/basic' })
  check('宽裕预算下两列都跑完', loose.report.includes('1/1') &&
    !loose.report.includes('预算超限'))
  check('宽裕预算下无预算超限中断', !loose.report.includes('预算超限中断'))

  // 9b. 预算卡在窗口里 → baseline 花得完，candidate 余额不足被中断
  const probe = await toolProbe.execute({ suite: 'budget-probe' })
  console.log(probe.report.split('\n').map((l) => `     ${l}`).join('\n'))
  check('baseline 在余额充足的池子里跑完', /通过率\s+1\/1/.test(probe.report))
  check(
    'candidate 因余额不足被中断',
    probe.report.includes('预算超限中断'),
    '若这里是 ❌，先确认 baseline 是否也被中断了',
  )
  // 反面：candidate 的失败必须来自预算，不能是断言失败或降级 —— 否则这条断言
  // 会被一个"因为别的原因失败"的假象蒙混过关。
  check('candidate 的失败不是断言失败', !probe.report.includes('未包含'))
  check('candidate 的失败不是缺 key 降级', !probe.report.includes('未配置'))

  // 9c. suite 路径守卫
  let guard = null
  try {
    await toolProbe.execute({ suite: '../../../etc/passwd' })
  } catch (e) {
    guard = e
  }
  check('越界 suite 路径被拒绝', guard !== null, '未抛异常')
}

// ── 10. 工作区快照：baseline 与 candidate 各留一份物证 ─────────────────────
console.log('\n10. 工作区快照：baseline 后 / candidate 后各一份')
{
  // 复用第 9 组已经导入的 dist/index.js —— DSH_EVAL_DSH_BIN 在模块加载期就定死了，
  // 这里换不了桩，改用环境变量让同一个桩产生工作区副作用（见 test/stubs/dsh-budget）。
  const { apply } = await import(`${ROOT}/dist/index.js`)

  const workspace = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
  process.env.DSH_EVAL_STUB_WORKSPACE = workspace

  // 套件 YAML 得动态生成：workspace 必须是临时目录的绝对路径，静态 fixture 写不出来。
  const suiteDir = mkdtempSync(join(tmpdir(), 'dsh-suite-'))
  const backend = (id, model) => [
    `  ${id}:`,
    `    id: ${id}`,
    `    baseUrl: https://api.deepseek.com/anthropic`,
    `    model: ${model}`,
    `    apiKeyEnv: DEEPSEEK_API_KEY`,
  ].join('\n')
  writeFileSync(
    join(suiteDir, 'workspace-probe.yml'),
    [
      'name: "工作区快照探针"',
      `workspace: ${workspace}`,
      'budgetCNY: 100',
      'backends:',
      backend('baseline', 'deepseek-v4-pro'),
      backend('candidate', 'deepseek-flash'),
      'steps:',
      '  - prompt: "probe"',
      '',
    ].join('\n'),
  )

  let tool
  apply({ tools: { register: (t) => { tool = t }, get: () => tool } }, { suiteDir })
  const out = await tool.execute({ suite: 'workspace-probe' })
  console.log(out.report.split('\n').map((l) => `     ${l}`).join('\n'))

  const paths = [...out.report.matchAll(/^(?:  baseline 后|  candidate 后)：(.+)$/gm)].map(
    (m) => m[1].trim(),
  )
  check('报告列出两份快照路径', paths.length === 2, `实际 ${paths.length} 条`)

  let b = null
  let c = null
  try {
    b = readFileSync(join(paths[0], 'FAILURE.md'), 'utf8')
    c = readFileSync(join(paths[1], 'FAILURE.md'), 'utf8')
  } catch (e) {
    check('两份快照都能读到产物', false, String(e))
  }
  // 桩按 --patch 里的模型名写文件，两个后端的模型不同 → 内容必然不同。
  // **这是本组的鉴别力所在**：若实现改成"只在整个流程跑完后拍一次"，
  // 两份快照会一模一样，下面第一条断言就会红。
  check('baseline 快照留的是 baseline 的产物', b?.includes('deepseek-v4-pro'), String(b))
  check('candidate 快照留的是 candidate 的产物', c?.includes('deepseek-flash'), String(c))
  check('两份快照内容不同（证明是分两次拍的）', b !== null && c !== null && b !== c)

  // 反面：没声明 workspace 的套件不该凭空多出快照段。
  const plain = await tool.execute({ suite: 'workspace-probe' })
  check('声明了 workspace 就一定有快照段', plain.report.includes('📁 工作区快照'))
}

// ── 11. 产物断言：语义、路径守卫、命令边界 ─────────────────────────────────
console.log('\n11. 产物断言：file_* / command_* 的通过与失败')
{
  const { checkArtifactAssert } = await import(`${ROOT}/dist/artifact-assert.js`)

  const ws = mkdtempSync(join(tmpdir(), 'dsh-artifact-'))
  writeFileSync(join(ws, 'present.txt'), 'hello world\n')
  writeFileSync(join(ws, 'data.json'), '{\n  "topSku": "B-207",\n  "qty": 48\n}\n')
  writeFileSync(join(ws, 'reordered.json'), '{"qty":48,"topSku":"B-207"}')
  writeFileSync(join(ws, 'wrong.json'), '{"topSku":"A-100","qty":48}')
  writeFileSync(join(ws, 'stringy.json'), '{"topSku":"B-207","qty":"48"}')
  writeFileSync(join(ws, 'arr.json'), '[1,2,3]')
  writeFileSync(join(ws, 'arr2.json'), '[1,3,2]')
  writeFileSync(join(ws, 'nested.json'), '{"a":{"b":[{"c":1}]}}')
  writeFileSync(join(ws, 'broken.json'), '{not json')
  writeFileSync(join(ws, 'ok.mjs'), "console.log('OK-LINE')\n")
  writeFileSync(join(ws, 'noisy.mjs'), "console.log('debug: OK-LINE expected')\n")
  writeFileSync(join(ws, 'fail.mjs'), "console.log('nope')\nprocess.exit(1)\n")

  const ok = (a) => checkArtifactAssert(a, ws) === undefined
  const bad = (a) => typeof checkArtifactAssert(a, ws) === 'string'
  const why = (a) => String(checkArtifactAssert(a, ws)).slice(0, 70)

  // file_exists / file_not_exists
  check('file_exists 命中', ok({ type: 'file_exists', path: 'present.txt' }))
  check('file_exists 未命中即失败', bad({ type: 'file_exists', path: 'nope.txt' }))
  check('file_not_exists 命中', ok({ type: 'file_not_exists', path: 'nope.txt' }))
  check('file_not_exists 撞上存在文件即失败', bad({ type: 'file_not_exists', path: 'present.txt' }))

  // file_content_contains
  check('file_content_contains 命中', ok({ type: 'file_content_contains', path: 'present.txt', text: 'hello' }))
  check('file_content_contains 未命中即失败', bad({ type: 'file_content_contains', path: 'present.txt', text: 'goodbye' }))
  check('file_content_contains 文件不存在即失败', bad({ type: 'file_content_contains', path: 'nope.txt', text: 'x' }))

  // file_json_equals —— 本组的重点：语义 vs 字符串
  const want = { type: 'file_json_equals', path: 'data.json', value: { topSku: 'B-207', qty: 48 } }
  check('file_json_equals 原样命中', ok(want))
  check(
    'file_json_equals 键序不同仍命中（键序无关）',
    ok({ ...want, path: 'reordered.json' }),
  )
  check(
    'file_json_equals 空白不同仍命中（已由 data.json 的多行格式覆盖）',
    ok(want),
    '期望值无空白、文件有多行缩进，命中即证明空白无关',
  )
  check('file_json_equals 值不同即失败', bad({ ...want, path: 'wrong.json' }))
  // 数字 vs 字符串：48 与 "48" 必须不等，否则类型错误会溜过去。
  check('file_json_equals 类型不同即失败（48 ≠ "48"）', bad({ ...want, path: 'stringy.json' }))
  // 数组顺序敏感（对象键序无关，数组顺序有关）——两者不能混为一谈。
  check(
    'file_json_equals 数组顺序不同即失败',
    bad({ type: 'file_json_equals', path: 'arr.json', value: [1, 3, 2] }),
  )
  check(
    'file_json_equals 数组顺序相同命中',
    ok({ type: 'file_json_equals', path: 'arr2.json', value: [1, 3, 2] }),
  )
  check(
    'file_json_equals 嵌套结构命中',
    ok({ type: 'file_json_equals', path: 'nested.json', value: { a: { b: [{ c: 1 }] } } }),
  )
  check('file_json_equals 非法 JSON 即失败', bad({ ...want, path: 'broken.json' }))
  check('file_json_equals 文件不存在即失败', bad({ ...want, path: 'nope.txt' }))

  // command_output_*
  check(
    'command_output_equals 命中',
    ok({ type: 'command_output_equals', command: ['node', 'ok.mjs'], text: 'OK-LINE' }),
  )
  check(
    'command_output_equals 多余输出即失败',
    bad({ type: 'command_output_equals', command: ['node', 'noisy.mjs'], text: 'OK-LINE' }),
  )
  check(
    'command_output_contains 容忍多余输出',
    ok({ type: 'command_output_contains', command: ['node', 'noisy.mjs'], text: 'OK-LINE' }),
  )
  check(
    'command_output_contains 未命中即失败',
    bad({ type: 'command_output_contains', command: ['node', 'ok.mjs'], text: 'NOPE' }),
  )
  check(
    '命令失败（exit 1）时输出仍判内容',
    bad({ type: 'command_output_contains', command: ['node', 'fail.mjs'], text: 'OK-LINE' }),
  )

  // 安全边界：越界路径、非白名单解释器、argv 形状、shell 元字符
  check(
    '产物断言路径越界被拒',
    bad({ type: 'file_exists', path: '../../etc/passwd' }),
    why({ type: 'file_exists', path: '../../etc/passwd' }),
  )
  check(
    '命令断言路径越界被拒',
    bad({ type: 'command_output_contains', command: ['node', '../../etc/passwd'], text: 'x' }),
  )
  check(
    '非白名单解释器被拒',
    bad({ type: 'command_output_contains', command: ['python3', 'ok.mjs'], text: 'x' }),
    why({ type: 'command_output_contains', command: ['python3', 'ok.mjs'], text: 'x' }),
  )
  check(
    'argv 多于两个元素被拒（挡住 node -e "<任意代码>"）',
    bad({ type: 'command_output_contains', command: ['node', '-e', 'console.log(1)'], text: 'x' }),
  )
  check(
    'argv 不是数组被拒',
    bad({ type: 'command_output_contains', command: 'node ok.mjs', text: 'x' }),
  )
  // shell: false 的证明 —— 元字符不被解释，整体当成一个文件路径，于是"文件不存在"。
  check(
    'shell 元字符不被解释（; 只是普通字符）',
    bad({ type: 'command_output_contains', command: ['node', 'ok.mjs; echo pwned'], text: 'x' }),
    why({ type: 'command_output_contains', command: ['node', 'ok.mjs; echo pwned'], text: 'x' }),
  )

  // 没声明 workspace 必须**判失败**，不能回退到 cwd —— 回退会带来假通过。
  check(
    '未声明 workspace 时产物断言判失败',
    typeof checkArtifactAssert({ type: 'file_exists', path: 'present.txt' }, undefined) === 'string',
  )

  // 反面：新类型必须被 checkAssertions 认，不能落进"未知断言类型"分支。
  const { apply: apply2 } = await import(`${ROOT}/dist/index.js`)
  const suiteDir2 = mkdtempSync(join(tmpdir(), 'dsh-suite2-'))
  const badType = (t) => `      - type: ${t}\n        path: whatever\n`
  writeFileSync(
    join(suiteDir2, 'unknown.yml'),
    [
      'name: "未知产物断言"',
      `workspace: ${ws}`,
      'budgetCNY: 100',
      'backends:',
      '  baseline:',
      '    id: deepseek-v4-pro',
      '    baseUrl: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-pro',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      '  candidate:',
      '    id: deepseek-v4-pro',
      '    baseUrl: https://api.deepseek.com/anthropic',
      '    model: deepseek-v4-pro',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      'steps:',
      '  - prompt: "probe"',
      '    assert:',
      '      - type: file_teleport',
      '        path: x',
      '',
    ].join('\n'),
  )
  let tool2
  apply2({ tools: { register: (t) => { tool2 = t }, get: () => tool2 } }, { suiteDir: suiteDir2 })
  const unk = await tool2.execute({ suite: 'unknown' })
  check(
    '拼错的产物断言类型报「未知断言类型」而非静默通过',
    unk.report.includes('未知断言类型'),
    badType('file_teleport'),
  )
}

// ── 12. 产物断言经 eval_run_dual 端到端生效 ────────────────────────────────
console.log('\n12. 产物断言端到端：workspace 真的从 YAML 传到了断言')
{
  const { apply } = await import(`${ROOT}/dist/index.js`)
  const ws = mkdtempSync(join(tmpdir(), 'dsh-e2e-artifact-'))
  process.env.DSH_EVAL_STUB_WORKSPACE = ws

  const suiteDir = mkdtempSync(join(tmpdir(), 'dsh-suite3-'))
  // 键是角色（baseline/candidate），不是模型名 —— 写成模型名会让 backends.baseline 为空。
  const backend = (role, model) => [
    `  ${role}:`,
    `    id: ${role}`,
    `    baseUrl: https://api.deepseek.com/anthropic`,
    `    model: ${model}`,
    `    apiKeyEnv: DEEPSEEK_API_KEY`,
  ].join('\n')
  // 桩会往工作区写 FAILURE.md。两条断言一过一败，用来证明：
  //   ① workspace 确实被传下去了（否则两条都会因"未声明 workspace"而失败）
  //   ② 失败信息会带着期望与实际进 failedCases
  writeFileSync(
    join(suiteDir, 'e2e-artifact.yml'),
    [
      'name: "产物断言端到端"',
      `workspace: ${ws}`,
      'budgetCNY: 100',
      'backends:',
      backend('baseline', 'deepseek-v4-pro'),
      backend('candidate', 'deepseek-flash'),
      'steps:',
      '  - prompt: "probe"',
      '    assert:',
      '      - type: file_exists',
      '        path: FAILURE.md',
      '      - type: file_not_exists',
      '        path: FAILURE.md',
      '',
    ].join('\n'),
  )

  let tool
  apply({ tools: { register: (t) => { tool = t }, get: () => tool } }, { suiteDir })
  const out = await tool.execute({ suite: 'e2e-artifact' })

  // 注意粒度：`passed/total` 是**按 step** 计的 —— 一个 step 的所有断言全过才算过。
  // 所以这一组（一过一败）是 0/1，不是 1/2。
  check('一过一败的 step 整体判失败（0/1）', out.report.includes('0/1'), out.report.match(/通过率.*/)?.[0])
  check(
    '失败的产物断言带期望与实际进报告',
    out.report.includes('文件不应存在，但存在：FAILURE.md'),
    out.report.match(/文件不应存在.*/)?.[0],
  )
  // 关键：file_exists 那条**没有**报"文件不存在"，说明它真的看到了桩写的 FAILURE.md，
  // 即 workspace 确实从 YAML 传到了断言里。
  check(
    'file_exists 那条没报失败（证明 workspace 传下去了）',
    !out.report.includes('文件不存在：FAILURE.md'),
    out.report.match(/文件不存在.*/)?.[0],
  )
  // 反面：若 workspace 没传下去，两条都会因"未声明 workspace"失败。
  check('未出现「未声明 workspace」', !out.report.includes('未声明 workspace'))
}

// ── 13. 兼容性门 ───────────────────────────────────────────────────────────
// 纯静态检查，**零 token**：只读套件 YAML + 已核实的协议事实，不发任何请求。
// 所以这一组连桩都不需要挑 —— 兼容性段在跑任何后端**之前**就算好了。
console.log('\n13. 兼容性门（静态检查，零 token）')
{
  const { checkSystemFieldFormat, checkCacheControlUsage, runCompatibilityChecks } =
    await import(`${ROOT}/dist/compatibility-check.js`)
  const { ROUTE_API } = await import(`${ROOT}/dist/model-router.js`)

  const route = (over) => ({
    name: 'candidate',
    api: ROUTE_API,
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-flash',
    ...over,
  })

  // — 13.1 检查项一：四种输入 —
  check(
    'system 字段：Anthropic 端点 + 开启 → pass',
    checkSystemFieldFormat(route(), true).status === 'pass',
    checkSystemFieldFormat(route(), true).detail,
  )
  check(
    'system 字段：非 Anthropic 端点 → fail（Anthropic 形状发往非 Anthropic 端点）',
    checkSystemFieldFormat(route({ baseUrl: 'https://api.deepseek.com/v1' }), true).status === 'fail',
    checkSystemFieldFormat(route({ baseUrl: 'https://api.deepseek.com/v1' }), true).detail,
  )
  check(
    'system 字段：协议不是 anthropic-messages → fail',
    checkSystemFieldFormat(route({ api: 'openai-completions' }), true).status === 'fail',
  )
  check(
    'system 字段：显式关闭 → not_checked（**不是** pass）',
    checkSystemFieldFormat(route(), false).status === 'not_checked',
    checkSystemFieldFormat(route(), false).status,
  )

  // — 13.2 检查项二：设计约束是「永不 pass」 —
  // 这条断言是在**锁定设计意图**：cache_control 由 harness 运行时必发、
  // 配置文件里扫不到，端点是否兑现只有探针请求能验（v1.1）。所以静态侧
  // 只能给 not_checked。哪天有人把它改成 unconditionally pass，这里会红。
  for (const [label, r] of [
    ['开启', checkCacheControlUsage(route(), true)],
    ['关闭', checkCacheControlUsage(route(), false)],
    ['非 anthropic 协议', checkCacheControlUsage(route({ api: 'openai-completions' }), true)],
  ]) {
    check(
      `cache_control：${label} → not_checked，绝不 pass`,
      r.status === 'not_checked',
      `${r.status} — ${r.detail}`,
    )
  }
  check(
    'cache_control：关闭时的 detail 说清了是「关闭」而非「没风险」',
    checkCacheControlUsage(route(), false).detail.includes('关闭'),
    checkCacheControlUsage(route(), false).detail,
  )
  // 旁证必须**带上下界**：只写"命中率高"会让人以为缓存总是有效。
  // 实测既有 94–99% 命中的批次，也有相隔数小时后 0% 命中的孤立运行。
  check(
    'cache_control：开启时带上实测旁证，且写明它自身不稳定',
    checkCacheControlUsage(route(), true).detail.includes('94–99%') &&
      checkCacheControlUsage(route(), true).detail.includes('0% 命中'),
    checkCacheControlUsage(route(), true).detail,
  )

  // — 13.3 聚合规则：fail 一票否决，优先于 not_checked —
  const aggFail = runCompatibilityChecks(route({ baseUrl: 'https://api.deepseek.com/v1' }), undefined)
  check(
    '聚合：有 fail → verdict = fail（压过未检测项）',
    aggFail.verdict === 'fail' && aggFail.failed.length === 1,
    `${aggFail.verdict} / failed=${JSON.stringify(aggFail.failed)} / unchecked=${JSON.stringify(aggFail.unchecked)}`,
  )
  const aggOff = runCompatibilityChecks(route(), {
    check_system_field_format: false,
    check_cache_control: false,
  })
  check(
    '聚合：全部关闭 → verdict = not_checked，两项都进未检测清单',
    aggOff.verdict === 'not_checked' && aggOff.unchecked.length === 2,
    `${aggOff.verdict} / ${JSON.stringify(aggOff.unchecked)}`,
  )
  const aggDefault = runCompatibilityChecks(route(), undefined)
  check(
    '聚合：不写 compatibility 块 → 两项默认开启',
    aggDefault.results.length === 2 &&
      aggDefault.results[0].detail !== '套件 YAML 显式关闭了本检查项' &&
      aggDefault.results[1].detail !== '套件 YAML 显式关闭了本检查项',
    JSON.stringify(aggDefault.results.map((r) => r.detail)),
  )
  // 这一条把「不写块 ≠ 关闭」和上面区分开：默认开启时 system 那项应当是 pass。
  check(
    '聚合：默认开启时 system 判 pass（证明默认不是 not_checked）',
    aggDefault.results[0].status === 'pass',
    aggDefault.results[0].status,
  )

  // — 13.4 / 13.5 / 13.6 端到端：过 eval_run_dual 落到报告里 —
  // 注：`dist/index.js` 与 `dist/eval-runner.js` 在第 12 组已按无 query 的
  // specifier 载入 ESM 缓存，桩固定为最后一次 `loadRunner` 设的 `dsh-ok`。
  // 这不影响本组结论 —— 兼容性段在跑后端**之前**就算完了，与桩无关。
  const { apply } = await import(`${ROOT}/dist/index.js`)
  const mkSuite = (dir, file, lines) => {
    writeFileSync(join(dir, file), lines.join('\n'))
    let t
    apply({ tools: { register: (x) => { t = x }, get: () => t } }, { suiteDir: dir })
    return t
  }
  const backend = (role, model, baseUrl) => [
    `  ${role}:`,
    `    id: ${role}`,
    `    baseUrl: ${baseUrl}`,
    `    model: ${model}`,
    `    apiKeyEnv: DEEPSEEK_API_KEY`,
  ].join('\n')
  const ANTHROPIC_URL = 'https://api.deepseek.com/anthropic'
  const suiteBody = (baseUrl, extra = []) => [
    'name: "兼容性门"',
    'budgetCNY: 100',
    ...extra,
    'backends:',
    backend('baseline', 'deepseek-v4-pro', ANTHROPIC_URL),
    backend('candidate', 'deepseek-flash', baseUrl),
    'steps:',
    '  - prompt: "probe"',
    '    assert:',
    '      - type: output_contains',
    '        text: "Harness"',
    '',
  ]

  // 场景 A（= 指令里的「system 是数组 → 失败 → 不可迁移」的**可达版本**）：
  // 「system 恒为内容块数组」在本 harness 上不可配置，所以那条路径根本不可达
  // （实测：显式关闭检查项是唯一能让它变 not_checked 的开关）。真正可达的
  // 兼容性失败是**端点不声称 Anthropic 兼容**——那才是配置能写错的地方。
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-compat-a-'))
  const outA = await mkSuite(dirA, 'compat-fail.yml', suiteBody('https://api.deepseek.com/v1')).execute({
    suite: 'compat-fail',
  })
  check('端到端A：报告出现兼容性门段', outA.report.includes('🔒 兼容性门'))
  check(
    '端到端A：端点不兼容 → ❌ 失败',
    outA.report.includes('❌ 失败') && outA.report.includes('system 字段格式'),
    outA.report.match(/system 字段格式.*/)?.[0],
  )
  check(
    '端到端A：一票否决 → 写明「不可迁移」',
    outA.report.includes('本趟判定「不可迁移」'),
    outA.report.match(/本趟判定.*/)?.[0],
  )

  // 场景 B：显式关闭两项 → not_checked → 有条件迁移。
  // 这是「用户可以关，但关掉只等于'没查'，不等于'查过了没问题'」的证明。
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-compat-b-'))
  const outB = await mkSuite(
    dirB,
    'compat-off.yml',
    suiteBody(ANTHROPIC_URL, [
      'compatibility:',
      '  check_system_field_format: false',
      '  check_cache_control: false',
    ]),
  ).execute({ suite: 'compat-off' })
  check(
    '端到端B：两项都渲染成 ⚠️ 未检测',
    (outB.report.match(/⚠️ 未检测/g) ?? []).length === 2,
    outB.report.match(/⚠️ 未检测.*/g)?.join(' | '),
  )
  check(
    '端到端B：未检测 → 最多「有条件迁移」（不是「可迁移」）',
    outB.report.includes('本趟最多判定「有条件迁移」') && !outB.report.includes('本趟判定「不可迁移」'),
    outB.report.match(/本趟最多判定.*/)?.[0],
  )
  check(
    '端到端B：关闭项进未检测清单',
    outB.report.includes('system 字段格式、cache_control 使用'),
    outB.report.match(/未检测项：.*/)?.[0],
  )

  // 场景 C：真实配置（Anthropic 端点、不写 compatibility 块）—— 默认全开。
  // 混合态：一项 pass 一项 not_checked，正是**渲染区分度**的测试点：
  // 「✅ 通过」与「⚠️ 未检测」必须同时出现，且各自成行、不互相冒充。
  const dirC = mkdtempSync(join(tmpdir(), 'dsh-compat-c-'))
  const outC = await mkSuite(dirC, 'compat-default.yml', suiteBody(ANTHROPIC_URL)).execute({
    suite: 'compat-default',
  })
  check('端到端C：默认开启 → system 判 ✅ 通过', outC.report.includes('✅ 通过'))
  check(
    '端到端C：cache_control 判 ⚠️ 未检测（与 pass 视觉可区分）',
    outC.report.includes('⚠️ 未检测') && outC.report.includes('cache_control 使用'),
  )
  check(
    '端到端C：通过 ≠ 未检测 —— 两行不共用一个状态词',
    !/system 字段格式\s*⚠️/.test(outC.report) && !/cache_control 使用\s*✅/.test(outC.report),
  )
  check(
    '端到端C：未检测项存在 → 最高只能「有条件迁移」',
    outC.report.includes('本趟最多判定「有条件迁移」'),
    outC.report.match(/本趟最多判定.*/)?.[0],
  )
  check(
    '端到端C：写明「未检测」不等于「通过」',
    outC.report.includes('"未检测"不等于"通过"'),
  )
  // 兼容性门不消耗 token，所以即使两个后端缺 key 被跳过，这一节也必须照常输出。
  check('端到端C：兼容性段不依赖后端是否跑成', outC.report.includes('🔒 兼容性门'))
}

// ── 14. 判定层 ─────────────────────────────────────────────────────────────
// 纯函数：输入三个门的结果，输出判定 + 风险清单。零 token、零模型调用。
console.log('\n14. 判定层（纯函数，零 token）')
{
  const { judge } = await import(`${ROOT}/dist/verdict.js`)

  const ok = (name, status = 'pass') => ({ name, status, detail: `${name} 的说明` })
  const cost = {
    baselineRangeUSD: [0.0016, 0.0021],
    candidateRangeUSD: [0.00046, 0.0006],
    savingsPercent: 72.2,
    batches: 3,
    samples: 9,
  }
  const qualityOk = { passed: 1, total: 1, failures: [] }

  // — 路径 1：质量门失败 → 不可迁移 —
  const p1 = judge({
    quality: { passed: 0, total: 1, failures: ['03：文件不存在：main.mjs'] },
    compatibility: [ok('system 字段格式')],
    cost,
  })
  check('路径1：质量门失败 → 不可迁移', p1.verdict === '不可迁移', p1.verdict)
  check('路径1：失败套件进风险清单', p1.risks.some((r) => r.text.includes('03：文件不存在')))
  check(
    '路径1：质量门失败优先于成本门（成本门不否决，也不翻盘）',
    p1.verdict === '不可迁移',
  )

  // — 路径 2：兼容性门有 fail → 不可迁移 —
  const p2 = judge({
    quality: qualityOk,
    compatibility: [
      { name: 'system 字段格式', status: 'fail', detail: '端点不兼容' },
      ok('cache_control 使用', 'not_checked'),
    ],
    cost,
  })
  check('路径2：兼容性门 fail → 不可迁移', p2.verdict === '不可迁移', p2.verdict)
  check(
    '路径2：fail 压过 not_checked（一票否决）',
    p2.risks.filter((r) => r.level === 'warn').length === 1 &&
      p2.risks.some((r) => r.text.includes('端点不兼容')),
    JSON.stringify(p2.risks),
  )
  check(
    '路径2：即便质量门全过也判不可迁移（否决与质量门无关）',
    p2.verdict === '不可迁移',
  )

  // — 路径 3：兼容性门有 not_checked → 有条件迁移 —
  const p3 = judge({
    quality: qualityOk,
    compatibility: [
      ok('system 字段格式'),
      { name: 'cache_control 使用', status: 'not_checked', detail: '静态判不了' },
    ],
    cost,
  })
  check('路径3：有未检测项 → 有条件迁移', p3.verdict === '有条件迁移', p3.verdict)
  check(
    '路径3：未检测项进风险清单且标 warn',
    p3.risks.some((r) => r.level === 'warn' && r.text.includes('cache_control 使用')),
  )
  check(
    '路径3：同时给出成本门的数据来源（info 级）',
    p3.risks.some((r) => r.level === 'info' && r.text.includes('n=9') && r.text.includes('3 个批次')),
    JSON.stringify(p3.risks.find((r) => r.level === 'info')),
  )

  // — 路径 4：三门全过 + 成本门有数据 → 可迁移 —
  const p4 = judge({
    quality: qualityOk,
    compatibility: [ok('system 字段格式'), ok('cache_control 使用')],
    cost,
  })
  check('路径4：三门全过 → 可迁移', p4.verdict === '可迁移', p4.verdict)
  check(
    '路径4：无 warn 级风险（只有数据来源说明）',
    p4.risks.every((r) => r.level === 'info') && p4.risks.length === 1,
    JSON.stringify(p4.risks),
  )

  // — 路径 5：三门全过但成本门为 null → 仍是可迁移，附「数据不足」—
  const p5 = judge({
    quality: qualityOk,
    compatibility: [ok('system 字段格式'), ok('cache_control 使用')],
    cost: null,
  })
  check('路径5：成本门 null 不否决 → 仍是可迁移', p5.verdict === '可迁移', p5.verdict)
  check(
    '路径5：风险清单追加「成本门：数据不足，未判定」',
    p5.risks.some((r) => r.text.includes('成本门：数据不足，未判定')),
    JSON.stringify(p5.risks),
  )

  // — 其余边界 —
  const p6 = judge({ smokeTest: true, quality: { passed: 1, total: 1, failures: [] }, compatibility: [], cost: null })
  check('边界：烟雾测试 → 不判定（不读质量门）', p6.verdict === '不判定', p6.verdict)
  const p7 = judge({ quality: { passed: 0, total: 0, failures: [] }, compatibility: [ok('system 字段格式')], cost })
  check(
    '边界：后端未跑（total=0）→ 不算通过 → 有条件迁移',
    p7.verdict === '有条件迁移' && p7.risks.some((r) => r.text.includes('质量门：后端未运行')),
    `${p7.verdict} / ${JSON.stringify(p7.risks)}`,
  )
  const p8 = judge({ quality: qualityOk, compatibility: [], cost: null })
  check(
    '边界：兼容性门为空数组 → 视为无失败无未检测（由调用方保证非空）',
    p8.verdict === '可迁移',
    p8.verdict,
  )

  // — 端到端：判定出现在报告**最顶部** —
  const { apply } = await import(`${ROOT}/dist/index.js`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-verdict-e2e-'))
  const backend = (role, model) => [
    `  ${role}:`,
    `    id: ${role}`,
    `    baseUrl: https://api.deepseek.com/anthropic`,
    `    model: ${model}`,
    `    apiKeyEnv: DEEPSEEK_API_KEY`,
  ].join('\n')
  writeFileSync(
    join(dir, 'v.yml'),
    [
      'name: "判定层端到端"',
      'budgetCNY: 100',
      'historicalCost:',
      '  baselineRangeUSD: [0.0016, 0.0021]',
      '  candidateRangeUSD: [0.00046, 0.0006]',
      '  savingsPercent: 72.2',
      '  batches: 3',
      '  samples: 9',
      'backends:',
      backend('baseline', 'deepseek-v4-pro'),
      backend('candidate', 'deepseek-flash'),
      'steps:',
      '  - prompt: "probe"',
      '    assert:',
      '      - type: output_contains',
      '        text: "Harness"',
      '',
    ].join('\n'),
  )
  let t
  apply({ tools: { register: (x) => { t = x }, get: () => t } }, { suiteDir: dir })
  const out = await t.execute({ suite: 'v' })
  check('端到端：判定渲染在报告最顶部', out.report.startsWith('🎯 迁移判定：'), out.report.slice(0, 40))
  check(
    '端到端：真实配置（system pass / cache_control 未检测）→ 有条件迁移',
    out.report.includes('🎯 迁移判定：⚠️ 有条件迁移'),
    out.report.split('\n')[0],
  )
  check(
    '端到端：风险清单在判定下方、对比表上方',
    out.report.indexOf('风险清单：') < out.report.indexOf('📊 双后端评测对比'),
  )
  check(
    '端到端：historicalCost 从 YAML 读到了判定层（输出 n=9 / 3 个批次）',
    out.report.includes('n=9，3 个批次'),
    out.report.match(/成本门：.*/)?.[0],
  )
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('')
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败：`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log('✅ 全部通过（离线，未花一分钱）')
}
