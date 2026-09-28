/**
 * 把 fixtures/<suite>/ 下的模板复制到 /tmp/dsh-multi-step/<suite>/，恢复初始状态。
 *
 * 为什么需要它：`eval_run_dual` 会先跑 baseline 再跑 candidate，**两次跑在同一个
 * 工作区上**。会改文件的套件里，baseline 跑完后 candidate 看到的是已修好的文件，
 * 步数会塌成 1 —— 那不是模型行为，是实测污染。所以会改文件的套件，prompt 的
 * 第一步就是运行本脚本来重置。
 *
 * 用法（由被测 agent 执行）：
 *   node /Users/mac/dsh-agent-eval/suites/multi-step/fixtures/reset-all.mjs <suite>
 *
 * 只用 Node 内置模块，不依赖 pnpm install。
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const suite = process.argv[2]

if (!suite) {
  console.error('用法: node reset-all.mjs <suite>')
  console.error('可用:', process.argv[1])
  process.exit(1)
}

const src = join(HERE, suite)
const dst = join('/tmp/dsh-multi-step', suite)

rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true })

console.log(`已重置 ${dst}`)
