// 假装是外部库存 CLI：把清单打成 JSON 输出。
// 被测 agent 需要运行它、解析 stdout 的 JSON、再基于结果做决策。
const ITEMS = [
  { sku: 'A-100', name: '青霉素', qty: 12, unit: '瓶' },
  { sku: 'B-207', name: '生理盐水', qty: 48, unit: '袋' },
  { sku: 'C-311', name: '止血钳', qty: 7, unit: '把' },
]

console.log(JSON.stringify({ generatedAt: '2026-09-28', items: ITEMS }, null, 2))
