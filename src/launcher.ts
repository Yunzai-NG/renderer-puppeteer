/**
 * 模块职责：真实 puppeteer 的适配层 —— 将 `Browser` / `Page` 包装为 browser.ts 的结构化接口
 * 依赖方向：唯一 import puppeteer-core 的文件
 * 生命周期：无状态工厂
 * 注意事项：puppeteer 的类型高度泛型化（形如 `$<Selector extends string>`），
 *          将 `Page` 直接作为 `PageLike` 使用通常可通过结构化类型检查，但上游一旦
 *          调整签名，编译错误即出现在业务代码处。此处显式转发调用，将耦合面收敛于
 *          该文件 —— 同时使 `browser.ts` / `screenshot.ts` 可在未安装 Chromium 的
 *          机器上被完整测试。
 *
 *          **仅该文件 import puppeteer-core**，因此将渲染器替换为其他实现
 *          （wkhtmltoimage、远程渲染服务）仅需替换该文件。
 */
import puppeteer from "puppeteer-core"
import type { Browser, Page } from "puppeteer-core"
import type { BrowserLauncher, BrowserLike, ElementLike, LaunchSpec, PageLike } from "./browser.js"

/**
 * 包装一个页面
 * @param page puppeteer 页面
 * @returns 结构化页面
 */
function wrapPage(page: Page): PageLike {
  return {
    setViewport: async viewport => {
      await page.setViewport(viewport)
    },
    goto: async (url, options) => page.goto(url, options),
    $: async selector => {
      const handle = await page.$(selector)
      if (!handle) return null
      const element: ElementLike = { boundingBox: async () => handle.boundingBox() }
      return element
    },
    screenshot: async options => page.screenshot(options),
    close: async () => {
      await page.close()
    }
  }
}

/**
 * 包装一个浏览器
 * @param browser puppeteer 浏览器
 * @returns 结构化浏览器
 */
function wrapBrowser(browser: Browser): BrowserLike {
  return {
    newPage: async () => wrapPage(await browser.newPage()),
    endpoint: () => browser.wsEndpoint(),
    close: async () => {
      await browser.close()
    },
    disconnect: async () => {
      await browser.disconnect()
    },
    onDisconnected: cb => {
      browser.once("disconnected", cb)
    }
  }
}

/**
 * 创建基于 puppeteer-core 的浏览器工厂
 * @returns 浏览器工厂
 */
export function createLauncher(): BrowserLauncher {
  return {
    launch: async (spec: LaunchSpec) =>
      wrapBrowser(
        await puppeteer.launch({
          executablePath: spec.executablePath,
          headless: spec.headless,
          args: [...spec.args],
          userDataDir: spec.userDataDir,
          timeout: spec.timeout,
          // 浏览器的 stdout/stderr 一律不予转发：Chromium 在无头模式下会输出大量
          // DevTools 与 GPU 相关日志，混入机器人日志将掩盖有效信息
          dumpio: false
        })
      ),

    connect: async (endpoint: string) => wrapBrowser(await puppeteer.connect({ browserWSEndpoint: endpoint }))
  }
}
