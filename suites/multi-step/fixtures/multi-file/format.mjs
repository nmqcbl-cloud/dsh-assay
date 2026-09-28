import { mean } from './math.mjs'

/**
 * 把一组分数渲染成一句中文描述。
 *
 * BUG 在这里：用的是 Math.min，但文案说的是「最高」。要修的是这一行，
 * main.mjs 和 math.mjs 都是无辜的。
 */
export function describe(scores) {
  const avg = mean(scores)
  return `平均 ${avg.toFixed(2)}，最高 ${Math.min(...scores)}`
}
