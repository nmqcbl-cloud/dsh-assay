// 基础统计。这个文件**没有 bug** —— 故意放了个无辜文件，逼 agent 真的去读代码定位。
export const sum = (xs) => xs.reduce((a, b) => a + b, 0)

export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0)
