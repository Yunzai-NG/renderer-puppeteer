/**
 * 模块职责：art-template 编译层 —— 将模板与数据转换为可被浏览器打开的 HTML 文件
 * 依赖方向：依赖 `@yunzai-ng/core` 的公开入口（LRU、文件工具）与 art-template
 * 生命周期：随插件实例存活；`clear()` 由插件卸载时调用，编译缓存与临时文件一并释放
 * 注意事项：**编译缓存是有界 LRU 加读取时比对 mtime**，不为每个模板注册 watcher —— 后者只增不减，
 *          既泄漏又占句柄。模板变更后下一次渲染自动重新编译。
 *
 *          **子模板也进缓存。** 不传 filename 而关掉 art-template 的缓存，会让 `include` / `extend`
 *          的每一层在每次渲染时都重新读盘与解析；故启用它自身的缓存开关，并把它那份无上限的全局
 *          `caches` 换成本模块的 LRU —— 取到缓存收益而不引入内存问题。
 *
 *          **临时 HTML 缺省渲染完即删。** 按 uid 逐人写文件再配一个「保留三天」的清理器，实际是只增
 *          不减；启用 `keepHtml` 时才保留，且那时用固定文件名反复覆盖，天然有界。
 *
 *          注入 `<base href="file:///<模板所在目录>/">`：模板里写 `href="./style.css"` 最自然，而中间
 *          HTML 在临时目录，缺 base 必然 404。靠相对层级计算规避的话，模板目录一挪就白屏。
 */
import { basename, dirname, extname as extOf, join, resolve } from "node:path"
import { statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { atomicWrite, createCache, ensureDir, remove, shortHash } from "@yunzai-ng/core"
import type { LruCache } from "@yunzai-ng/core"
import type { Logger, RenderRequest, RuntimePaths } from "@yunzai-ng/types"
import template from "art-template"
import { dirUrl, injectBase } from "./html.js"
import { TailwindCompiler } from "./tailwind.js"

export { injectBase } from "./html.js"

/** 模板缺省扩展名；art-template 自身的缺省值为 `.art`，旧 Yunzai 模板一律为 `.html` */
const TEMPLATE_EXT = ".html"

/**
 * Tailwind 入口 CSS 的缺省文件名，相对模板根
 *
 * 与配置项 `tailwindEntry` 的缺省值一致。此处仍保留一份，是因为 `prepare()` 允许
 * 不传 `tailwindEntry` 直接调用（测试与内部调用即如此），不应要求调用方复述该缺省值。
 */
const DEFAULT_TAILWIND_ENTRY = "tailwind.css"

/** art-template 编译出的渲染函数 */
type TemplateRender = (data: unknown, blocks?: unknown) => string

/**
 * `compile(options)` 形态的 art-template
 *
 * art-template 的 `compile` 允许仅传入一个选项对象（源码由 `loader` 依据 `filename`
 * 读取），但其随包的 `index.d.ts` 仅声明了 `compile(source, options)`。此处按实际
 * 行为收窄类型：**不自行读取文件**是关键，否则 `cache` 命中时该次读盘即为无效开销。
 */
type CompileWithOptions = (options: Record<string, unknown>) => TemplateRender

/** 按实际行为重新标注的 compile */
const compileWithOptions = template.compile as unknown as CompileWithOptions

/** 编译缓存条目 */
interface CompiledEntry {
  /** 编译出的渲染函数 */
  render: TemplateRender
  /** 编译时模板文件的 mtime，毫秒 */
  mtime: number
}

/** 生成好的中间 HTML */
export interface PreparedHtml {
  /** HTML 文件绝对路径 */
  file: string
  /** 可直接交给浏览器的 `file://` URL */
  url: string
  /** 使用完毕后调用；`keepHtml` 启用时为空操作 */
  cleanup(): Promise<void>
}

/** 引擎构造参数 */
export interface TemplateEngineOptions {
  /** 编译缓存条数上限 */
  max: number
  /** 目录布局，用于定位临时目录 */
  paths: RuntimePaths
  /** 日志 */
  logger: Logger
}

/** 生成 HTML 的可变参数 */
export interface PrepareOptions {
  /** 是否保留中间 HTML（用于排查模板问题） */
  keepHtml: boolean
  /** 传入模板的 `sys.scale`，参见 `screenshot.ts` 中关于缩放的说明 */
  scale: number
  /**
   * 是否编译 Tailwind 工具类
   *
   * 缺省为关闭：本字段由插件入口按配置填入，而测试与直接调用者多数只关心 art-template
   * 通路，不应因未填此项而意外触发一次 Tailwind 编译。
   */
  tailwind?: boolean
  /**
   * Tailwind 入口 CSS，相对模板根解析
   *
   * 仅在 `tailwind` 为真时使用。文件不存在时 `TailwindCompiler` 退回内置入口。
   */
  tailwindEntry?: string
}

/**
 * 取文件 mtime
 *
 * 采用同步版本：一次渲染需为主模板及每一层 include 各查询一次，异步化换来的是
 * 一连串 await 与更差的可读性，而 `statSync` 在本地磁盘上为微秒级。
 * @param file 文件绝对路径
 * @returns mtime 毫秒；文件不存在时 undefined
 */
function mtimeSync(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * 组装模板可用的数据
 *
 * 调用方提供的 `data` 恒优先：此处仅补充缺省值，不作覆盖。除新模型的 `res` 外亦补充了
 * 旧 miao 模板所识别的 `_res_path` / `pluResPath` / `resPath`，使"旧模板直接出图"
 * 无需修改模板。`defaultLayout` 之类指向具体插件资源的变量不在此处 —— 渲染器
 * 不掌握 miao-plugin 的安装位置，该变量应由发起渲染的插件自行填充。
 * @param req 渲染请求
 * @param opts 可变参数
 * @returns 模板数据
 */
export function prepareData(req: RenderRequest, opts: PrepareOptions): Record<string, unknown> {
  const res = dirUrl(req.resourceRoot)
  const given = req.data
  const givenSys = given["sys"]

  return {
    res,
    _res_path: res,
    pluResPath: res,
    resPath: res,
    _plugin: req.origin,
    _tpl_path: dirUrl(req.templateRoot),
    ...given,
    // sys 须合并而非覆盖：模板普遍读取 sys.scale，而调用方通常仅需追加 sys.copyright
    sys: { scale: opts.scale, ...(typeof givenSys === "object" && givenSys !== null ? givenSys : {}) }
  }
}

/**
 * art-template 编译层
 *
 * 每个插件实例对应一个引擎，卸载时随插件一并释放，编译缓存不会跨热重载残留。
 */
export class TemplateEngine {
  /** 编译缓存，键为模板绝对路径 */
  readonly #cache: LruCache<CompiledEntry>
  /** 目录布局 */
  readonly #paths: RuntimePaths
  /** 日志 */
  readonly #logger: Logger
  /** 已确认存在的临时子目录，避免每次渲染均执行 mkdir */
  readonly #ensured = new Set<string>()
  /**
   * Tailwind 编译器
   *
   * 恒被构造，但只在 TSX 通路且配置开启时才被调用；其对 `tailwindcss` 的加载是懒的，
   * 因此从不出图的实例不会为此付出任何开销。
   */
  readonly #tailwind: TailwindCompiler

  /**
   * 提供给 art-template 的缓存适配器
   *
   * 其仅要求 `get` / `set` / `reset` 三个方法。本实现在 `get` 中一并比对 mtime，
   * 使"模板变更后重新编译"无需任何文件监听器。
   */
  readonly #caches = {
    get: (key: string): TemplateRender | undefined => {
      const hit = this.#cache.get(key)
      if (!hit) return undefined
      if (mtimeSync(key) !== hit.mtime) {
        this.#cache.delete(key)
        return undefined
      }
      return hit.render
    },
    set: (key: string, render: TemplateRender): void => {
      const mtime = mtimeSync(key)
      // 无法取得 mtime 时不予缓存：否则该条目永远无法失效
      if (mtime !== undefined) this.#cache.set(key, { render, mtime })
    },
    reset: (): void => {
      this.#cache.clear()
    }
  }

  /**
   * @param opts 构造参数
   */
  constructor(opts: TemplateEngineOptions) {
    this.#cache = createCache<CompiledEntry>({ max: opts.max, ttl: 0 })
    this.#paths = opts.paths
    this.#logger = opts.logger
    this.#tailwind = new TailwindCompiler({ logger: opts.logger })
  }

  /** 编译缓存统计，供诊断判定缓存容量配置是否合理 */
  get stats(): { hits: number; misses: number; size: number; max: number } {
    return this.#cache.stats
  }

  /** Tailwind 产物缓存统计，供诊断使用 */
  get tailwindStats(): { hits: number; misses: number; size: number; max: number } {
    return this.#tailwind.stats
  }

  /** 释放全部编译结果 */
  clear(): void {
    this.#cache.clear()
    this.#tailwind.clear()
  }

  /**
   * 编译模板
   * @param req 渲染请求
   * @returns 渲染函数
   * @throws 模板不存在或语法错误时抛出（`bail: true`）
   */
  compile(req: RenderRequest): TemplateRender {
    return compileWithOptions({
      filename: this.resolveTemplate(req),
      root: req.templateRoot,
      extname: TEMPLATE_EXT,
      // 启用缓存，但以本模块的有界 LRU 替换 art-template 自带的无上限全局 Map
      cache: true,
      caches: this.#caches,
      // debug 的缺省值为 `NODE_ENV !== 'production'`，为真时会强制启用 compileDebug
      // （在内存中保留一份 source map）。渲染器不需要 source map，故明确关闭
      debug: false,
      compileDebug: false,
      // 缺省的 minimize 会执行 html-minifier：耗时较长，且会"修正"模板中刻意不闭合的标签
      minimize: false,
      // 编译或运行出错即抛出，避免静默渲染出内容为 {Template Error} 的图片
      bail: true
    })
  }

  /**
   * 将模板标识解析为绝对路径
   *
   * 与 art-template 的 `resolveFilename` 规则一致，提前计算一次是为使 mtime 与错误信息
   * 均可取得真实路径。绝对路径原样通行 —— 旧 miao 模板的 `defaultLayout` 即为绝对路径。
   * @param req 渲染请求
   * @returns 模板文件绝对路径
   */
  resolveTemplate(req: RenderRequest): string {
    const file = resolve(req.templateRoot, req.template)
    return extOf(file) ? file : file + TEMPLATE_EXT
  }

  /**
   * 生成中间 HTML 并落盘成一个文件
   *
   * 两条通路在此分流，判据是 `req.html` 是否给出：
   * - **TSX 通路**：HTML 已由组件在插件进程内求值完毕，此处不碰 art-template、不读任何
   *   模板文件，仅注入 `<base>`（指向模板根，使 TSX 中的相对资源路径可用）与 Tailwind 样式。
   * - **字符串模板通路**：照旧编译，且**不编译 Tailwind** —— 旧 HTML 模板不含工具类，
   *   为其扫描候选并编译一遍纯属浪费，更要紧的是 preflight 会重置边距与字号，
   *   足以推翻现存模板的既有版式。兼容性优先于一致性。
   * @param req 渲染请求
   * @param opts 可变参数
   * @returns 中间 HTML 的位置与清理句柄
   * @throws 模板编译失败、渲染函数抛错或写盘失败时抛出
   */
  async prepare(req: RenderRequest, opts: PrepareOptions): Promise<PreparedHtml> {
    // 名称仅用于临时文件名：TSX 通路的 template 是页面名而非路径，不得据此去磁盘寻找文件
    const label = req.html === undefined ? this.resolveTemplate(req) : req.template
    const html =
      req.html === undefined
        ? injectBase(this.compile(req)(prepareData(req, opts)), dirUrl(dirname(label)))
        : await this.#dressPage(req, req.html, opts)

    const dir = join(this.#paths.temp, "render", safeSegment(req.origin))
    if (!this.#ensured.has(dir)) {
      await ensureDir(dir)
      this.#ensured.add(dir)
    }

    // 保留模式采用固定名称（同一模板反复覆盖，可预测、可刷新、不堆积）；
    // 否则追加随机后缀 —— 两名使用者同时查询同一模板时，共用文件名将导致相互截取到对方的图片
    const stem = `${safeSegment(basename(label, extOf(label)))}-${shortHash(label)}`
    const out = join(dir, opts.keepHtml ? `${stem}.html` : `${stem}-${randomSuffix()}.html`)
    await atomicWrite(out, html)

    return {
      file: out,
      url: pathToFileURL(out).href,
      cleanup: async () => {
        if (opts.keepHtml) return
        try {
          await remove(out)
        } catch (err) {
          this.#logger.debug(
            `临时 HTML 删除失败（不影响渲染结果）：${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
  }

  /**
   * 为 TSX 页面补齐 `<base>` 与 Tailwind 样式
   *
   * base 指向**模板根**而非某个模板文件所在目录：TSX 页面没有对应的磁盘文件，
   * 其中书写的 `./img/x.png` 只可能相对模板根。资源引用另有 `res` 一途，
   * 但 base 仍是必要的 —— 少了它，相对路径会落到临时目录上。
   * @param req 渲染请求
   * @param html 组件求值出的完整 HTML
   * @param opts 可变参数
   * @returns 注入完毕的 HTML
   */
  async #dressPage(req: RenderRequest, html: string, opts: PrepareOptions): Promise<string> {
    const withBase = injectBase(html, dirUrl(req.templateRoot))
    if (opts.tailwind !== true) return withBase

    const entry = resolve(req.templateRoot, opts.tailwindEntry ?? DEFAULT_TAILWIND_ENTRY)
    return this.#tailwind.apply(withBase, entry)
  }
}

/**
 * 将任意字符串规约为安全的路径片段
 * @param input 原字符串
 * @returns 仅含字母、数字、下划线、短横线与点的片段
 */
function safeSegment(input: string): string {
  const cleaned = input.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "tpl"
}

/**
 * 临时文件名后缀
 *
 * 仅用于避免同一毫秒内的名称冲突，无需密码学强度。
 * @returns 短随机串
 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
