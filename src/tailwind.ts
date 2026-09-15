/**
 * 模块职责：在渲染前把模板用到的 Tailwind 工具类编译成一段 `<style>` 注入 HTML
 * 依赖方向：依赖 `@yunzai-ng/core` 的公开入口（LRU、shortHash）与本插件的 html 工具；
 *          `tailwindcss` 为**运行期可选依赖**，缺失时本模块整体降级为空操作
 * 生命周期：随插件实例存活；`clear()` 由插件卸载时调用
 * 注意事项：不引入构建步骤：用 Tailwind v4 的程序化接口，候选类名取自已渲染出的 HTML 本身 ——
 *          比扫描源码更准，运行期拼出来的类名（条件分支）也在其中。
 *
 *          `tailwindcss` 作可选依赖、动态 `import()` 加载，缺失时整体降级为空操作并只告警一次：
 *          渲染器的既有职责是「art-template + 截图」，不该因一个可选能力整体不可用。
 *
 *          编译结果以「入口 CSS + 候选集合」为键缓存：每次渲染重新 `compile()` 会重复解析入口
 *          CSS 与主题，而同一模板的候选集合在数据变化时通常完全一致。
 */
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { createCache, shortHash } from "@yunzai-ng/core"
import type { LruCache } from "@yunzai-ng/core"
import type { Logger } from "@yunzai-ng/types"
import { injectStyle } from "./html.js"

/**
 * 缺省入口 CSS
 *
 * 插件未提供 `templates/tailwind.css` 时使用。只 `@import "tailwindcss"` 一行 ——
 * 主题定制属于插件自己的事，渲染器不预设任何调色板。
 */
const DEFAULT_ENTRY = '@import "tailwindcss";'

/**
 * 以本模块所在位置为起点的 require
 *
 * 用于解析入口 CSS 里的裸包名。**起点必须是渲染器自身而非发起插件的模板目录**：`tailwindcss`
 * 装在渲染器插件的 `node_modules` 下，从插件模板目录出发逐级上溯永远到不了那一份，表现为每渲染
 * 一张图都报一次 `Cannot find module 'tailwindcss'`。另一重理由是版本一致：`@import "tailwindcss"`
 * 取到的 CSS 必须与渲染器 `import()` 进来的编译器同源。
 */
const ownRequire = createRequire(import.meta.url)

/** 编译产物缓存条数上限；每条为一段 CSS 文本，量级在几十 KB */
const CACHE_MAX = 64

/** 入口 CSS 文件的读取结果缓存条数上限 */
const ENTRY_CACHE_MAX = 32

/**
 * 从 HTML 里提取候选类名
 *
 * 只认 `class` 属性：Tailwind 的候选扫描器在源码上工作时会把任意字符串都当作候选，
 * 那是因为它无从知晓哪些字符串会成为类名。此处输入已是最终 HTML，`class` 属性即为
 * 全部答案，误报为零，`build()` 亦无须为无效候选做记忆化。
 *
 * 同时收集 `--` 开头的自定义属性名：Tailwind v4 以 `@theme` 定义的主题变量只有在被
 * 引用时才会输出，而 `build()` 把 `--` 开头的候选视为"该主题变量被用到了"。
 * 模板中直接写 `var(--gold)` 的情形因此也能拿到定义。
 * @param html 已渲染出的完整 HTML
 * @returns 去重后的候选数组
 */
export function extractCandidates(html: string): string[] {
  const found = new Set<string>()

  for (const match of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2] ?? ""
    for (const token of value.split(/\s+/)) {
      if (token !== "") found.add(token)
    }
  }

  for (const match of html.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = match[1]
    if (name !== undefined) found.add(name)
  }

  // 排序使缓存键与候选顺序无关：同一套类名不同书写顺序应命中同一条缓存
  return [...found].sort()
}

/** Tailwind v4 `compile()` 的返回形态中本模块用到的部分 */
interface TailwindCompiled {
  /**
   * 按候选生成 CSS
   * @param candidates 候选类名
   * @returns CSS 文本
   */
  build(candidates: string[]): string
}

/** Tailwind v4 的 `compile()` 签名中本模块用到的部分 */
type TailwindCompile = (
  css: string,
  opts: {
    /** 解析相对路径的基准目录 */
    base: string
    /**
     * 解析 `@import`
     * @param id 被导入的标识
     * @param base 发起导入的文件所在目录
     * @returns 样式表内容与其自身的基准目录
     */
    loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }>
  }
) => Promise<TailwindCompiled>

/** 编译器构造参数 */
export interface TailwindCompilerOptions {
  /** 日志 */
  logger: Logger
}

/**
 * Tailwind 编译器
 *
 * 一个插件实例一个，卸载时随之释放。对 `tailwindcss` 的加载与失败态记忆均在实例内，
 * 因此重装该包后热重载插件即可恢复，无须重启框架。
 */
export class TailwindCompiler {
  /** 日志 */
  readonly #logger: Logger
  /** 编译产物缓存，键为入口 CSS 与候选集合的哈希 */
  readonly #css: LruCache<string>
  /** 入口 CSS 文本缓存，键为文件绝对路径；未找到文件时缓存缺省入口 */
  readonly #entries: LruCache<string>
  /** `tailwindcss` 的加载结果；`null` 表示已确认不可用 */
  #compile: TailwindCompile | null | undefined
  /** 加载中的 promise，避免并发渲染时重复 import */
  #loading: Promise<TailwindCompile | null> | undefined
  /** 不可用告警是否已输出过 —— 每次渲染都告警会淹没日志 */
  #warned = false
  /**
   * 已告警过的编译失败原因
   *
   * 按**原因文本**去重而非只记一个布尔量：同一个原因反复出现时只说一次，
   * 而换了个原因（改了入口 CSS、装了别的包）仍应被告知。编译一旦成功即清空，
   * 使问题修复后再次出现时还会重新提示。
   */
  readonly #warnedErrors = new Set<string>()

  /**
   * @param opts 构造参数
   */
  constructor(opts: TailwindCompilerOptions) {
    this.#logger = opts.logger
    this.#css = createCache<string>({ max: CACHE_MAX, ttl: 0 })
    this.#entries = createCache<string>({ max: ENTRY_CACHE_MAX, ttl: 0 })
  }

  /** 缓存统计，供诊断使用 */
  get stats(): { hits: number; misses: number; size: number; max: number } {
    return this.#css.stats
  }

  /** 释放全部缓存 */
  clear(): void {
    this.#css.clear()
    this.#entries.clear()
  }

  /**
   * 为 HTML 生成并注入 Tailwind 样式
   *
   * 任何失败都只告警不抛出：模板可能压根没用工具类，为此让整张图出不来是错误的取舍。
   *
   * **同一个失败原因只告警一次。** 此处的失败多为环境问题（包没装、入口 CSS 写错），
   * 每渲染一张图重复一遍只会淹没日志，而它并不会自行好转 —— 该说的第一次就已说完。
   * @param html 已渲染出的完整 HTML
   * @param entryFile 入口 CSS 绝对路径（通常为 `<模板根>/tailwind.css`）
   * @returns 注入样式后的 HTML；不可用或无候选时原样返回
   */
  async apply(html: string, entryFile: string): Promise<string> {
    const candidates = extractCandidates(html)
    if (candidates.length === 0) return html

    try {
      const css = await this.#build(entryFile, candidates)
      return css === "" ? html : injectStyle(html, css)
    } catch (err) {
      const reason = errText(err)
      if (!this.#warnedErrors.has(reason)) {
        this.#warnedErrors.add(reason)
        this.#logger.warn(`Tailwind 编译失败，本次出图不含工具类样式（同一原因仅提示一次）：${reason}`)
      } else {
        this.#logger.debug(`Tailwind 编译仍在失败：${reason}`)
      }
      return html
    }
  }

  /**
   * 取得候选对应的 CSS
   * @param entryFile 入口 CSS 绝对路径
   * @param candidates 候选类名
   * @returns CSS 文本；Tailwind 不可用时为空串
   */
  async #build(entryFile: string, candidates: string[]): Promise<string> {
    const compile = await this.#load()
    if (compile === null) return ""

    const entry = await this.#entry(entryFile)
    const key = shortHash(`${entryFile} ${entry} ${candidates.join(" ")}`)
    const hit = this.#css.get(key)
    if (hit !== undefined) return hit

    const compiled = await compile(entry, {
      base: dirname(entryFile),
      loadStylesheet: (id, base) => loadStylesheet(id, base)
    })
    const css = compiled.build(candidates)
    this.#css.set(key, css)
    // 编译成功即忘掉先前的失败原因：问题修复后若再次出现，仍应重新提示一次
    this.#warnedErrors.clear()
    return css
  }

  /**
   * 读取入口 CSS
   *
   * 文件不存在是常态而非错误：插件不定制主题时无须提供该文件，此时用缺省入口。
   * 读取结果进缓存，但**不比对 mtime** —— 与模板不同，入口 CSS 改动后重载插件即生效，
   * 而为每次渲染增加一次 stat 只为覆盖调试期的一个场景并不值得。
   * @param file 入口 CSS 绝对路径
   * @returns 入口 CSS 文本
   */
  async #entry(file: string): Promise<string> {
    const hit = this.#entries.get(file)
    if (hit !== undefined) return hit

    let text = DEFAULT_ENTRY
    try {
      text = await readFile(file, "utf8")
    } catch {
      // 保持缺省入口
    }
    this.#entries.set(file, text)
    return text
  }

  /**
   * 懒加载 `tailwindcss`
   *
   * 只在首次真正需要编译时加载：未使用工具类的实例不必为此付出加载开销。
   * @returns `compile` 函数；不可用时 null
   */
  async #load(): Promise<TailwindCompile | null> {
    if (this.#compile !== undefined) return this.#compile
    if (this.#loading !== undefined) return this.#loading

    this.#loading = (async () => {
      try {
        const mod = (await import("tailwindcss")) as unknown as { compile?: unknown }
        const compile = mod.compile
        if (typeof compile !== "function") {
          throw new Error("tailwindcss 未导出 compile()，可能是版本过低（需要 v4）")
        }
        this.#compile = compile as TailwindCompile
        this.#logger.debug("Tailwind 编译器已就绪")
      } catch (err) {
        this.#compile = null
        if (!this.#warned) {
          this.#warned = true
          this.#logger.warn(
            "未能加载 tailwindcss，模板中的工具类将不生效（旧 HTML 模板不受影响）。" +
              `如需启用请在渲染器插件目录下安装 tailwindcss v4：${errText(err)}`
          )
        }
      } finally {
        this.#loading = undefined
      }
      return this.#compile ?? null
    })()

    return this.#loading
  }
}

/**
 * 解析 Tailwind 入口 CSS 中的 `@import`
 *
 * 两类标识分别处理：相对路径直接按发起文件的目录解析；裸包名交给 Node 的解析算法，
 * 因此 `@import "tailwindcss"` 会命中该包 exports 中声明的 `./index.css`。
 * 后者不能简单拼成 `node_modules/tailwindcss/index.css` —— pnpm 的目录结构里
 * 该路径通常是一个软链，且包完全有权把入口指向别处。
 * @param id 被导入的标识
 * @param base 发起导入的文件所在目录
 * @returns 样式表内容与其自身的基准目录
 * @throws 无法解析或读取时抛出
 */
async function loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }> {
  const file = id.startsWith(".") || isAbsolute(id) ? resolve(base, id) : resolveBare(id, base)
  const content = await readFile(file, "utf8")
  return { path: file, base: dirname(file), content }
}

/**
 * 裸包名解析时优先尝试的样式表子路径
 *
 * **`require.resolve("tailwindcss")` 给出的是 JS 入口而非 CSS。** 该包的
 * `exports["."]` 把样式表挂在 `style` 条件下（`"style": "./index.css"`），而 Node 的
 * 解析算法只认 `require` / `import` —— 拿到的是 `dist/lib.js`，喂给 CSS 解析器即报
 * `Invalid declaration: "use strict"`。故对不带子路径的裸包名先试其 CSS 子路径，
 * 它们在 exports 里是显式声明的（`"./index.css"`、`"./index"`）。
 */
const CSS_SUBPATHS = ["/index.css", "/index"] as const

/**
 * 解析裸包名形式的样式表标识
 *
 * 三层依次尝试，命中即止：
 * 1. **渲染器自身 + CSS 子路径** —— `tailwindcss` → `tailwindcss/index.css`，见
 *    {@link CSS_SUBPATHS}：不加子路径会解析到 JS 入口。
 * 2. **渲染器自身的原标识** —— `tailwindcss/theme.css` 这类已带子路径的，以及
 *    确实以 JS 为入口的包。
 * 3. **发起插件一侧** —— 插件的入口 CSS 有权 `@import` 它自己装的包（如某个第三方主题），
 *    那类标识只能从插件目录解析得到。
 *
 * 前两层不可与第三层对调：`tailwindcss` 只装在渲染器这边，而发起插件的模板目录
 * 上溯不到那里（见 {@link ownRequire}）。
 *
 * 每层都要求解析结果确实存在：`require.resolve` 对 exports 里声明而磁盘上缺失的路径
 * 亦可能返回成功，那时应继续往下试而非就此认定命中。
 * @param id 裸包标识
 * @param base 发起导入的文件所在目录
 * @returns 样式表绝对路径
 * @throws 各层均无法解析时抛出
 */
function resolveBare(id: string, base: string): string {
  // 已带子路径的标识（`tailwindcss/theme.css`）不再拼 CSS 子路径：那会得到
  // `tailwindcss/theme.css/index.css` 一类不存在的路径
  const bare = !id.startsWith("@") && !id.includes("/")
  const candidates = bare ? CSS_SUBPATHS.map(sub => id + sub) : []

  for (const candidate of [...candidates, id]) {
    const file = tryResolve(ownRequire, candidate)
    if (file !== undefined) return file
  }

  // 以 base 下的一个虚构文件为起点：createRequire 需要一个"发起者"，
  // 而该文件是否存在并不影响解析结果
  return createRequire(resolve(base, "__tailwind_entry__.css")).resolve(id)
}

/**
 * 试解析一个标识，并确认其指向的文件确实存在
 * @param req 用于解析的 require
 * @param id 标识
 * @returns 绝对路径；无法解析或文件不存在时 undefined
 */
function tryResolve(req: NodeRequire, id: string): string | undefined {
  try {
    const file = req.resolve(id)
    return existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

/**
 * 取错误的可读描述
 * @param err 任意抛出物
 * @returns 描述文本
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
