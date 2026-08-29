/**
 * 模块职责：HTML 文本的注入与探测工具
 * 依赖方向：仅依赖 Node 内置模块，不依赖本插件其余模块
 * 生命周期：无状态纯函数
 * 注意事项：独立成模块是为使 `template.ts`（字符串模板通路）与 `tailwind.ts`（样式注入）
 *          共用同一套判定，而两者之间不产生循环引用。
 *
 *          此处所有探测均在"注释已被等长空白遮蔽"的副本上进行。原因是 art-template
 *          会将 HTML 注释原样编译进输出：注释中出现的一处标签写法足以使真正的注入被
 *          跳过，其表现为全部样式与图片静默失效，且极难定位。注释不得影响渲染行为。
 */
import { pathToFileURL } from "node:url"

/**
 * 目录路径转换为带尾斜杠的 file URL
 *
 * 尾斜杠并非装饰：`file:///a/b` 与 `file:///a/b/` 在解析 `img/x.png` 时结果相差一级目录。
 * @param dir 目录绝对路径
 * @returns 形如 `file:///c:/x/y/` 的 URL
 */
export function dirUrl(dir: string): string {
  const href = pathToFileURL(dir).href
  return href.endsWith("/") ? href : `${href}/`
}

/**
 * 以等长空白遮蔽 HTML 注释
 *
 * 长度保持不变，使基于下标的插入点在原字符串上依然成立 —— 直接删除注释会导致
 * 后续 `slice` 的位置整体偏移。
 * @param html 原 HTML
 * @returns 注释内容已被空白替换的等长副本
 */
export function maskComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, matched => " ".repeat(matched.length))
}

/**
 * 将 `<base>` 注入 HTML
 *
 * 已存在 `<base>` 的模板不作改动 —— 该情形属于模板作者的明确意图。
 * @param html 渲染出的 HTML
 * @param base base URL（带尾斜杠）
 * @returns 注入后的 HTML
 */
export function injectBase(html: string, base: string): string {
  const probe = maskComments(html)
  if (/<base[\s/>]/i.test(probe)) return html
  const tag = `<base href="${base}">`

  const head = /<head\b[^>]*>/i.exec(probe)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)

  const htmlTag = /<html\b[^>]*>/i.exec(probe)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`
  }

  return tag + html
}

/**
 * 将一段样式注入 HTML
 *
 * 插入位置为 `<head>` 的**开头**（`<base>` 之后），而非结尾。位置的选择直接决定
 * 层叠结果：Tailwind 的 preflight 会重置边距、行高与字号，若排在模板自带样式表之后，
 * 旧模板的既有版式将被整体推翻。置于开头则模板自带样式恒可覆盖 preflight，
 * 而 TSX 模板本身不写竞争性的作者样式，工具类的优先级不受影响。
 *
 * `<base>` 须仍排在最前：`<style>` 中 `url()` 按文档 base URL 解析，
 * 若 base 尚未出现，相对路径将指向临时目录。
 * @param html 原 HTML
 * @param css 样式文本
 * @returns 注入后的 HTML
 */
export function injectStyle(html: string, css: string): string {
  if (css.trim() === "") return html
  const probe = maskComments(html)
  const tag = `<style data-yunzai-tailwind>${css}</style>`

  const base = /<base\b[^>]*>/i.exec(probe)
  if (base) {
    const at = base.index + base[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }

  const head = /<head\b[^>]*>/i.exec(probe)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }

  const htmlTag = /<html\b[^>]*>/i.exec(probe)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`
  }

  return tag + html
}
