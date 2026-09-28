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

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('')
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败：`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log('✅ 全部通过（离线，未花一分钱）')
}
