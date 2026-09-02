/**
 * 模块职责：插件入口 —— 将 puppeteer 渲染器注册至内核
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的公开入口、`@yunzai-ng/types` 与本插件内部模块
 * 生命周期：`setup` 执行一次；浏览器在首次实际渲染时方启动
 * 注意事项：内核仅依赖 `RendererProvider` 接口，不认识 puppeteer。未安装本插件时框架
 *          照常启动，仅不具备渲染能力，`ctx.render` 明确报出"无可用渲染器" ——
 *          在 Termux 上装不了 Chromium 的使用者据此仍可运行框架。
 *
 *          `setup` 中刻意**不启动浏览器**：内核对 setup 设有超时，而在低配 Android
 *          设备上冷启动 Chromium 需数十秒。浏览器由首次渲染按需启动。
 */
import { definePlugin, parseDuration } from "@yunzai-ng/core"
import type { PluginDefinition } from "@yunzai-ng/types"
import { join } from "node:path"
import { BrowserPool } from "./browser.js"
import type { PoolPlan } from "./browser.js"
import { buildArgs, findChromium, missingChromiumHint } from "./chromium.js"
import type { ChromiumFound } from "./chromium.js"
import { CONFIG_SCHEMA, LAUNCH_KEYS } from "./config.js"
import type { RendererConfig, RendererConfigView } from "./config.js"
import { createLauncher } from "./launcher.js"
import { RENDERER_ID, createProvider } from "./provider.js"
import { TemplateEngine } from "./template.js"

export { CONFIG_SCHEMA, LAUNCH_KEYS } from "./config.js"
export type { RendererConfig, RendererConfigView, WaitUntil } from "./config.js"
export { RENDERER_ID } from "./provider.js"

/**
 * 插件定义
 *
 * 显式标注类型而非直接 `export default definePlugin(...)`：返回类型 `PluginDefinition` 声明在
 * `@yunzai-ng/types` 内，而插件构建于使用者主目录时，该包的真实路径落在宿主的
 * `node_modules/.pnpm/` 之下 —— tsc 生成 .d.ts 时无从以可移植的方式指称它，报 TS2742。
 * 标注后 .d.ts 直接写下这个名字，与宿主的安装布局无关。
 */
const plugin: PluginDefinition<RendererConfig> = definePlugin({
  name: "renderer-puppeteer",
  version: "0.1.0",
  description: "puppeteer 渲染器：art-template 编译旧 Yunzai HTML 模板，Chromium 截图输出图片",
  configSchema: CONFIG_SCHEMA,
  // 渲染器须在业务插件之前就绪：业务插件的 setup 中即可能存在调用 ctx.render 的定时任务
  priority: 10,

  setup(ctx) {
    const { paths, platform } = ctx.app
    const config = (): RendererConfigView => ctx.config.get()

    // 仅缓存命中结果：未探测到时下次重新探测，否则使用者安装浏览器后仍须重启框架
    let probed:
      | {
          /** 本次缓存对应的配置路径，配置变更后重新探测 */
          key: string
          /** 探测结果 */
          found: ChromiumFound
        }
      | undefined
    /**
     * 探测浏览器，命中结果按配置路径缓存
     * @param configured 配置中指定的路径
     * @returns 探测结果
     */
    const probe = (configured: string): ChromiumFound | undefined => {
      if (probed && probed.key === configured) return probed.found
      const found = findChromium({ configured, paths, platform })
      if (found) probed = { key: configured, found }
      return found
    }

    const plan = (): PoolPlan => {
      const cfg = config()
      const found = probe(cfg.chromiumPath)
      const userDataDir = cfg.userDataDir.trim() || join(paths.cache, "chromium-profile")
      return {
        wsEndpoint: cfg.wsEndpoint,
        launch: found
          ? {
              executablePath: found.path,
              headless: found.headless,
              args: buildArgs(platform, cfg.args),
              userDataDir,
              timeout: parseDuration(cfg.launchTimeout, 60_000)
            }
          : undefined,
        restartAfter: cfg.restartAfter
      }
    }

    const engine = new TemplateEngine({ max: config().templateCache, paths, logger: ctx.logger })
    const pool = new BrowserPool({
      launcher: createLauncher(),
      plan,
      kv: ctx.kv,
      logger: ctx.logger,
      pages: config().pages
    })

    ctx.registerRenderer(createProvider({ engine, pool, config, logger: ctx.logger }))

    // 可执行文件或启动参数变更须重启浏览器；超时之类的字段变更不应影响正在运行的浏览器
    const launchKeys = new Set<string>(LAUNCH_KEYS)
    ctx.config.onChange(change => {
      // 路径可能为 "args.0" 这类下标形式，仅比对第一段
      if (!change.paths.some(path => launchKeys.has(path.split(".")[0] ?? path))) return
      probed = undefined
      ctx.logger.info("渲染器的浏览器设置已变更，下一次渲染时将以新配置重启")
      void pool.invalidate()
    })

    const initial = plan()
    if (initial.wsEndpoint.trim()) {
      ctx.logger.info(`渲染器已注册（${RENDERER_ID}），将连接外部浏览器 ${initial.wsEndpoint}`)
    } else if (initial.launch) {
      ctx.logger.info(`渲染器已注册（${RENDERER_ID}），最多同时渲染 ${pool.limit} 张；浏览器按需启动`)
    } else {
      // 不抛错：内核允许"已注册但暂不可用"，available() 返回 false 即触发内核回落，
      // 而将插件整体标记为加载失败只会增加定位难度
      ctx.logger.warn(`渲染器已注册（${RENDERER_ID}），但当前不具备渲染能力 —— ${missingChromiumHint(platform)}`)
    }
  }
})

export default plugin
