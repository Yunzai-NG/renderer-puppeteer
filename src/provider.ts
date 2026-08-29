/**
 * 模块职责：将编译层、浏览器池、截图逻辑组装为内核所识别的 `RendererProvider`
 * 依赖方向：依赖本插件其余模块与类型包
 * 生命周期：随插件存活；`dispose()` 由内核在插件卸载或停机时调用，且必须可重复调用
 * 注意事项：`available()` 不启动浏览器。内核约每 60 秒查询一次可用性，若在此处
 *          一并启动浏览器，则每日仅输出一张图片的实例亦将常驻一个 Chromium 进程。
 */
import { parseDuration } from "@yunzai-ng/core"
import type { Logger, RenderRequest, RenderResult, RendererProvider } from "@yunzai-ng/types"
import type { BrowserPool } from "./browser.js"
import type { RendererConfigView } from "./config.js"
import { resolveShot, shoot } from "./screenshot.js"
import type { TemplateEngine } from "./template.js"

/**
 * 渲染器 id
 *
 * 必须与内核配置 `render.default` 的缺省值一致，否则安装本插件后亦不会被优先选中。
 */
export const RENDERER_ID = "puppeteer"

/** 组装参数 */
export interface ProviderDeps {
  /** 模板编译层 */
  engine: TemplateEngine
  /** 浏览器与页面池 */
  pool: BrowserPool
  /** 即时读取配置 */
  config: () => RendererConfigView
  /** 日志 */
  logger: Logger
}

/**
 * 创建渲染器
 * @param deps 组装参数
 * @returns 渲染器
 */
export function createProvider(deps: ProviderDeps): RendererProvider {
  return {
    id: RENDERER_ID,
    name: "puppeteer（Chromium 截图）",

    available: async () => deps.pool.available(),

    render: async (req: RenderRequest): Promise<RenderResult> => {
      const start = Date.now()
      const cfg = deps.config()

      // sys.scale 恒为 1：缩放由 deviceScaleFactor 承担，理由参见 screenshot.ts 文件头
      const prepared = await deps.engine.prepare(req, {
        keepHtml: cfg.keepHtml,
        scale: 1,
        // 发起方的声明优先：模板用不用工具类是它自己的事，渲染器无从判断一段 HTML 里的
        // `class` 是 Tailwind 的还是模板自定义的。未声明时才退到本插件的配置
        tailwind: req.tailwind ?? cfg.tailwind,
        tailwindEntry: cfg.tailwindEntry
      })
      try {
        const plan = resolveShot(req, prepared.url, {
          pageHeight: cfg.pageHeight,
          gotoTimeout: parseDuration(cfg.gotoTimeout, 60_000),
          waitUntil: cfg.waitUntil
        })
        for (const warning of plan.warnings) deps.logger.warn(`${req.origin}/${req.template}：${warning}`)

        const images = await deps.pool.withPage(page => shoot(page, plan))
        const cost = Date.now() - start
        const bytes = images.reduce((sum, img) => sum + img.byteLength, 0)
        deps.logger.debug(
          `渲染完成 ${req.origin}/${req.template}：${images.length} 张 ${(bytes / 1024).toFixed(1)}KB ${cost}ms`
        )

        return { images, cost, renderer: RENDERER_ID }
      } finally {
        await prepared.cleanup()
      }
    },

    dispose: async () => {
      await deps.pool.dispose()
      deps.engine.clear()
    }
  }
}
