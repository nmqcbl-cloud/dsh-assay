#!/usr/bin/env bash
#
# 第三阶段测量：波动测试。
#
# 同一套件、同一 prompt、同一后端，连续跑 N（默认 3）次端到端，汇总四项指标：
#   inputTokens / outputTokens / step 条数 / costUSD
#
# 为什么要跑这个：成本受 prefix cache 冷热支配（见 docs/eval-design-constraints.md
# 约束一），单次数据不能用来定阈值或下结论。这个脚本产出的极差就是判据的来源。
#
# 用法：
#   source ~/.zshrc && ./test/run-variance.sh
#   VAR_RUNS=5 VAR_SUITE=dual-backend/basic ./test/run-variance.sh
#
# 产出（**不打印也不落盘任何 key**）：
#   /tmp/variance-<时间戳>/run<N>.ndjson   原始输出，仅留本机自查，不要提交到 git
#   /tmp/variance-<时间戳>/summary.txt     汇总结果，**这个才是要提交的东西**
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTDIR="/tmp/variance-${STAMP}"
SUMMARY="${OUTDIR}/summary.txt"

RUNS="${VAR_RUNS:-3}"
SUITE="${VAR_SUITE:-dual-backend/basic}"
PROFILE="${VAR_PROFILE:-eval-runner}"
PROMPT="调用 eval_run_dual，suite 填 ${SUITE}"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  cat >&2 <<'MSG'
错误：DEEPSEEK_API_KEY 未设置。

本脚本要真跑模型，必须先有 key：
  echo 'export DEEPSEEK_API_KEY="<你的key>"' >> ~/.zshrc && source ~/.zshrc
MSG
  exit 1
fi

mkdir -p "${OUTDIR}"
echo "套件 ${SUITE} · 连续跑 ${RUNS} 次 · 原始输出留在 ${OUTDIR}/"

# 先构建，免得跑到一半发现 dist 是旧的。
(cd "${ROOT}" && npm run build >/dev/null)

for i in $(seq 1 "${RUNS}"); do
  echo "── 第 ${i}/${RUNS} 次 …"
  # 每次之间留一小段间隔：紧接着连跑是"热"的，会掩盖冷跑的代价。
  [[ "${i}" -gt 1 ]] && sleep 5
  # `|| true`：某次失败不该中断整批 —— 失败本身就是测量结果的一部分。
  dsh --profile "${PROFILE}" headless --json "${PROMPT}" \
    > "${OUTDIR}/run${i}.ndjson" 2>"${OUTDIR}/run${i}.stderr" || true
done

# 解析用 node 而非 grep：报告嵌在 tool_result.result 里，正则裸抓会抓到外层
# agent 自己的 step_end 用量 —— 那是"跑评测这件事"的开销，不是被评测对象的开销。
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[1]
const suite = process.argv[2]
const cmd = process.argv[3]

const files = readdirSync(dir).filter((f) => /^run\d+\.ndjson$/.test(f))
  .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]))

// 从外层 NDJSON 里取出报告文本。
function extractReport(path) {
  let text
  try { text = readFileSync(path, "utf8") } catch { return { err: "无输出文件" } }
  let report = null, truncFlag = false, eventErr = null
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (!s.startsWith("{")) continue
    let ev; try { ev = JSON.parse(s) } catch { continue }
    if (ev.type === "tool_result" && typeof ev.result === "string" && ev.result.trim()) {
      report = ev.result
      if (ev.resultTruncated === true || ev.truncated === true) truncFlag = true
    }
    if (ev.type === "turn_end" && ev.reason?.error?.message) eventErr = ev.reason.error.message
  }
  if (!report) {
    const tail = text.trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? ""
    return { err: eventErr ? `外层未产出报告：${eventErr}` : `外层未产出报告（末行：${tail}）` }
  }
  if (truncFlag) return { err: "工具结果被 8 KiB 截断，指标不可信" }
  return { report }
}

// 报告的表格行形如：`成本(USD)      0.0041          0.0007          `
function pick(report, label, re) {
  const line = report.split("\n").find((l) => l.startsWith(label))
  if (!line) return null
  const rest = line.slice(label.length)
  const m = rest.match(re)
  return m ? m.slice(1, 3) : null
}

const NUM = /(—|[\d.]+)\s+(—|[\d.]+)/
const rows = []
for (const f of files) {
  const n = +f.match(/\d+/)[0]
  const { report, err } = extractReport(join(dir, f))
  if (err) { rows.push({ n, err, cols: null }); continue }
  const rate = pick(report, "通过率", /(\S+)\s+(\S+)/)
  const inTok = pick(report, "输入Token", NUM)
  const outTok = pick(report, "输出Token", NUM)
  const usd = pick(report, "成本(USD)", NUM)
  const steps = pick(report, "平均步数", NUM)
  if (!inTok || !outTok || !usd || !steps) {
    rows.push({ n, err: "报告表格结构无法解析", cols: null }); continue
  }
  // 报告只给「输入Token / 输出Token / 成本 / 平均步数」四行。
  // 套件只有一个用例时，平均步数就是 step 条数 —— 这点写进 summary 里说明。
  rows.push({
    n, err: null,
    cols: [
      { pass: rate?.[0], inTok: +inTok[0], outTok: +outTok[0], usd: +usd[0], steps: +steps[0] },
      { pass: rate?.[1], inTok: +inTok[1], outTok: +outTok[1], usd: +usd[1], steps: +steps[1] },
    ],
  })
}

const ok = rows.filter((r) => r.cols)
const nCol = ok.length ? ok[0].cols.length : 0
// 列名从报告表头取，取不到就退回占位。
let names = []
if (ok.length) {
  const { report } = extractReport(join(dir, files[0]))
  const hdr = report.split("\n").find((l) => l.startsWith("指标"))
  names = hdr ? hdr.slice(2).trim().split(/\s+/) : []
}
if (names.length !== nCol) names = Array.from({ length: nCol }, (_, i) => `列${i + 1}`)

const fx = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(4))
const L = []
L.push(`第三阶段波动测量 — ${new Date().toISOString()}`)
L.push(`套件 ${suite} · 共 ${files.length} 次（成功解析 ${ok.length} 次）`)
L.push(`命令 dsh --profile ${process.env.VAR_PROFILE ?? "eval-runner"} headless --json "${cmd}"`)
L.push("")
L.push("── 逐次明细 " + "─".repeat(40))
for (const r of rows) {
  if (r.err) { L.push(`运行 ${r.n}  ✗ ${r.err}`); continue }
  L.push(`运行 ${r.n}  exit=ok`)
  r.cols.forEach((c, i) => {
    L.push(`  ${names[i].padEnd(18)} 通过 ${c.pass}  输入 ${c.inTok}  输出 ${c.outTok}  步数 ${fx(c.steps)}  成本 $${c.usd.toFixed(6)}`)
  })
}

if (ok.length) {
  L.push("")
  L.push("── 汇总 " + "─".repeat(44))
  L.push(`${"指标".padEnd(20)}${names.map((n) => n.padEnd(24)).join("")}`)
  const stat = (label, get) => {
    const cells = names.map((_, i) => {
      const vs = ok.map((r) => get(r.cols[i]))
      const lo = Math.min(...vs), hi = Math.max(...vs)
      const spread = lo === 0 ? (hi === 0 ? "0%" : "n/a") : `${(((hi - lo) / lo) * 100).toFixed(1)}%`
      return `${fx(lo)}–${fx(hi)} (${spread})`.padEnd(24)
    })
    L.push(`${label.padEnd(20)}${cells.join("")}`)
  }
  stat("输入Token 极差", (c) => c.inTok)
  stat("输出Token 极差", (c) => c.outTok)
  stat("步数 极差（绝对）", (c) => c.steps)
  stat("成本 极差（USD）", (c) => c.usd)

  L.push("")
  L.push("── 判据 " + "─".repeat(44))
  const maxStepSpread = Math.max(...names.map((_, i) =>
    { const vs = ok.map((r) => r.cols[i].steps); return Math.max(...vs) - Math.min(...vs) }))
  L.push(maxStepSpread > 3
    ? `⚠️ 步数极差 ${fx(maxStepSpread)} > 3 —— max_steps 断言需放宽，或改成「步数中位数 ± N」`
    : `✅ 步数极差 ${fx(maxStepSpread)} ≤ 3 —— max_steps 维持当前阈值`)
  const inSpreadAll = names.every((_, i) => {
    const vs = ok.map((r) => r.cols[i].inTok)
    return Math.min(...vs) > 0 && (Math.max(...vs) - Math.min(...vs)) / Math.min(...vs) < 0.3
  })
  L.push(inSpreadAll
    ? "ℹ️ 输入Token 抖动 < 30% —— 注意：这**不代表**成本稳定（见约束一，抖动藏在 cache 分档里）"
    : "ℹ️ 输入Token 抖动 ≥ 30% —— 冷热切换已跨过阈值，跨运行对比需用 miss-token")
  L.push("ℹ️ 成本区间而非点值；报「节省 X%」必须确认两列同批跑出")
  L.push("")
  L.push("注：套件只有 1 个用例时，「平均步数」即该用例的 step_end 条数。")
}

process.stdout.write(L.join("\n") + "\n")
' "${OUTDIR}" "${SUITE}" "${PROMPT}" | tee "${SUMMARY}"

echo ""
echo "汇总已写入 ${SUMMARY}"
echo "（原始 NDJSON 留在 ${OUTDIR}/，仅供本机复查，不要提交到 git）"
