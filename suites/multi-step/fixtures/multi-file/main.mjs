// 自检入口：期望输出「平均 20.00，最高 30」。
import { describe } from './format.mjs'

const out = describe([10, 20, 30])
console.log(out)

if (out !== '平均 20.00，最高 30') {
  console.log('FAIL')
  process.exit(1)
}
console.log('PASS')
