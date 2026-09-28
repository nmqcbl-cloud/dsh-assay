// slugify：把标题转成 URL slug —— 应当小写，且空格换成连字符。
//
// 当前实现只做了替换没做小写，所以 slugify("Hello World") 得到的是 "Hello-World"。
export function slugify(title) {
  return title.replace(/ /g, '-')
}

// 直接运行时打印结果，方便核对。
console.log(slugify('Hello World'))
