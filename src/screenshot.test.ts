/**
 * 模块职责：截图方案计算与截图执行的测试
 * 依赖方向：测试文件，依赖 screenshot.ts 与 browser.ts 的结构化接口
 * 生命周期：纯内存，无临时文件
 * 注意事项：`resolveShot` 为纯函数，"哪些请求选项会被静默改写"这一行为只能由测试
 *          固定：分页强制 jpeg、png 丢弃 quality。此处既断言改写结果，
 *          亦断言改写附带 warning。
 *
 *          `shoot` 采用页面替身受测：真实页面需要 Chromium，而该段逻辑（选择器回落、
 *          切片、逐片截图）本身与浏览器无关。
 */
import type { RenderRequest } from "@yunzai-ng/types"
import { describe, expect, it } from "vitest"
import type { BoxLike, GotoOptions, PageLike, ShotOptions, ViewportLike } from "./browser.js"
import { DEFAULT_SELECTOR, DEFAULT_VIEWPORT, resolveShot, shoot, sliceBox } from "./screenshot.js"
import type { ShotDefaults } from "./screenshot.js"

/** 配置缺省值，取与 config.ts 一致的数量级 */
const DEFAULTS: ShotDefaults = { pageHeight: 4000, gotoTimeout: 60_000, waitUntil: "networkidle2" }

/** 构造一份渲染请求 */
function req(over: Partial<RenderRequest> = {}): RenderRequest {
  return {
    template: "player/index",
    data: {},
    templateRoot: "/plugins/demo/resources",
    resourceRoot: "/plugins/demo/resources",
    origin: "demo",
    ...over
  }
}

/** 页面替身：记录收到的调用，按 selector 表回答 `$` */
function fakePage(elements: Record<string, BoxLike | null>): {
  page: PageLike
  shots: ShotOptions[]
  opened: string[]
  gotos: GotoOptions[]
  viewports: ViewportLike[]
} {
  const shots: ShotOptions[] = []
  const opened: string[] = []
  const gotos: GotoOptions[] = []
  const viewports: ViewportLike[] = []
  let seq = 0

  const page: PageLike = {
    setViewport: async viewport => {
      viewports.push(viewport)
    },
    goto: async (url, options) => {
      opened.push(url)
      gotos.push(options)
      return undefined
    },
    $: async selector => {
      if (!(selector in elements)) return null
      const box = elements[selector] ?? null
      return { boundingBox: async () => box }
    },
    screenshot: async options => {
      shots.push(options)
      seq += 1
      // 各张图内容互不相同，方可断言顺序未被打乱
      return new Uint8Array([seq])
    },
    // shoot 不负责关闭页面（该职责属于 BrowserPool），此处仅需满足接口
    close: async () => undefined
  }

  return { page, shots, opened, gotos, viewports }
}

describe("resolveShot", () => {
  it("请求未指定任何选项时给出 jpeg / 质量 90 / #container / 800×600", () => {
    const plan = resolveShot(req(), "file:///tmp/a.html", DEFAULTS)

    expect(plan.selector).toBe(DEFAULT_SELECTOR)
    expect(plan.shot).toEqual({ type: "jpeg", quality: 90, omitBackground: false, captureBeyondViewport: true })
    expect(plan.viewport).toEqual({
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1
    })
    expect(plan.goto).toEqual({ timeout: 60_000, waitUntil: "networkidle2" })
    expect(plan.pageHeight).toBeUndefined()
    expect(plan.warnings).toEqual([])
  })

  it("png 不携带 quality —— 携带该参数将使 puppeteer 抛错", () => {
    const plan = resolveShot(req({ type: "png", quality: 80 }), "file:///a", DEFAULTS)

    expect(plan.shot.type).toBe("png")
    expect(plan.shot.quality).toBeUndefined()
  })

  it("webp 保留 quality", () => {
    const plan = resolveShot(req({ type: "webp", quality: 70 }), "file:///a", DEFAULTS)
    expect(plan.shot).toMatchObject({ type: "webp", quality: 70 })
  })

  it("omitBackground 对 png 生效，对 jpeg 忽略并给出提示", () => {
    const png = resolveShot(req({ type: "png", omitBackground: true }), "file:///a", DEFAULTS)
    expect(png.shot.omitBackground).toBe(true)
    expect(png.warnings).toEqual([])

    const jpeg = resolveShot(req({ omitBackground: true }), "file:///a", DEFAULTS)
    expect(jpeg.shot.omitBackground).toBe(false)
    expect(jpeg.warnings).toHaveLength(1)
    expect(jpeg.warnings[0]).toContain("omitBackground")
  })

  it("multiPage: true 采用配置中的页高", () => {
    const plan = resolveShot(req({ multiPage: true }), "file:///a", DEFAULTS)
    expect(plan.pageHeight).toBe(4000)
  })

  it("multiPage 为数字时采用该数值，非正数回落至配置值", () => {
    expect(resolveShot(req({ multiPage: 1200 }), "file:///a", DEFAULTS).pageHeight).toBe(1200)
    // 0 不等于 false，仍视为需要分页，仅页高无效 —— 不应使一处笔误变为不分页
    expect(resolveShot(req({ multiPage: 0 }), "file:///a", DEFAULTS).pageHeight).toBe(4000)
    expect(resolveShot(req({ multiPage: -5 }), "file:///a", DEFAULTS).pageHeight).toBe(4000)
  })

  it("multiPage: false 即为不分页", () => {
    const plan = resolveShot(req({ multiPage: false }), "file:///a", DEFAULTS)
    expect(plan.pageHeight).toBeUndefined()
  })

  it("分页强制 jpeg，并说明被忽略的 type", () => {
    const plan = resolveShot(req({ multiPage: true, type: "png" }), "file:///a", DEFAULTS)

    expect(plan.shot.type).toBe("jpeg")
    expect(plan.warnings.some(w => w.includes("type=png"))).toBe(true)
  })

  it("分页 + jpeg 不产生提示：请求值与实际取值一致", () => {
    const plan = resolveShot(req({ multiPage: true, type: "jpeg" }), "file:///a", DEFAULTS)
    expect(plan.warnings).toEqual([])
  })

  it("请求中的超时、视口、选择器覆盖缺省值", () => {
    const plan = resolveShot(
      req({ timeout: 5000, selector: "#main", viewport: { width: 1200, height: 900, scale: 2 } }),
      "file:///a",
      DEFAULTS
    )

    expect(plan.goto.timeout).toBe(5000)
    expect(plan.selector).toBe("#main")
    expect(plan.viewport).toEqual({ width: 1200, height: 900, deviceScaleFactor: 2 })
  })

  it("非法的超时与视口值视为未填写", () => {
    const plan = resolveShot(
      req({ timeout: 0, viewport: { width: Number.NaN, height: -1, scale: 0 } }),
      "file:///a",
      DEFAULTS
    )

    expect(plan.goto.timeout).toBe(60_000)
    expect(plan.viewport).toEqual({
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
      deviceScaleFactor: 1
    })
  })

  it("传入模板的 scale 恒为 1", () => {
    // 缩放仅经由 deviceScaleFactor；模板中再叠加一次 CSS zoom 将破坏布局
    const plan = resolveShot(req({ viewport: { scale: 3 } }), "file:///a", DEFAULTS)
    expect(plan.templateScale).toBe(1)
    expect(plan.viewport.deviceScaleFactor).toBe(3)
  })
})

describe("sliceBox", () => {
  it("未达一页半时不予切分", () => {
    const box: BoxLike = { x: 0, y: 0, width: 800, height: 1000 }
    expect(sliceBox(box, 4000)).toEqual([box])
    // 5000 / 4000 = 1.25，四舍五入仍为 1 页：ceil 将切出一条 1000px 的片段页
    expect(sliceBox({ ...box, height: 5000 }, 4000)).toHaveLength(1)
  })

  it("按四舍五入确定页数，再均分高度", () => {
    const slices = sliceBox({ x: 0, y: 0, width: 800, height: 9000 }, 4000)

    expect(slices).toHaveLength(2)
    expect(slices.map(s => s.height)).toEqual([4500, 4500])
    expect(slices.map(s => s.y)).toEqual([0, 4500])
  })

  it("切片首尾相接、总高等于原高、不越界", () => {
    const box: BoxLike = { x: 12, y: 34, width: 800, height: 10_000 }
    const slices = sliceBox(box, 4000)

    expect(slices).toHaveLength(3)
    expect(slices.reduce((sum, s) => sum + s.height, 0)).toBe(box.height)
    for (const [i, slice] of slices.entries()) {
      expect(slice.x).toBe(box.x)
      expect(slice.width).toBe(box.width)
      const previous = slices[i - 1]
      expect(slice.y).toBe(previous ? previous.y + previous.height : box.y)
    }
    const last = slices[slices.length - 1]!
    expect(last.y + last.height).toBe(box.y + box.height)
  })

  it("元素不位于页面原点时切片带有偏移", () => {
    const slices = sliceBox({ x: 10, y: 20, width: 100, height: 200 }, 100)

    expect(slices.map(s => s.y)).toEqual([20, 120])
    expect(slices.every(s => s.x === 10)).toBe(true)
  })
})

describe("shoot", () => {
  it("按方案设置视口、打开页面、截取一张图", async () => {
    const fake = fakePage({ "#container": { x: 0, y: 0, width: 800, height: 1200 } })
    const plan = resolveShot(req(), "file:///tmp/a.html", DEFAULTS)

    const images = await shoot(fake.page, plan)

    expect(images).toHaveLength(1)
    expect(fake.viewports).toEqual([plan.viewport])
    expect(fake.opened).toEqual(["file:///tmp/a.html"])
    expect(fake.gotos).toEqual([plan.goto])
    // 不分页时裁剪区域即元素自身的包围盒
    expect(fake.shots[0]?.clip).toEqual({ x: 0, y: 0, width: 800, height: 1200 })
  })

  it("选择器未命中时回落至 body", async () => {
    const fake = fakePage({ body: { x: 0, y: 0, width: 800, height: 600 } })
    const images = await shoot(fake.page, resolveShot(req(), "file:///a", DEFAULTS))

    expect(images).toHaveLength(1)
  })

  it("body 亦不存在时报出模板可能并非 HTML", async () => {
    const fake = fakePage({})
    await expect(shoot(fake.page, resolveShot(req(), "file:///a", DEFAULTS))).rejects.toThrow(/body/)
  })

  it("元素无法测得尺寸时抛错，而非产出空白图片", async () => {
    const invisible = fakePage({ "#container": null })
    await expect(shoot(invisible.page, resolveShot(req(), "file:///a", DEFAULTS))).rejects.toThrow(/不可见/)

    const zero = fakePage({ "#container": { x: 0, y: 0, width: 800, height: 0 } })
    await expect(shoot(zero.page, resolveShot(req(), "file:///a", DEFAULTS))).rejects.toThrow(/800×0/)
  })

  it("分页时按切片顺序截取多张，页面仅打开一次", async () => {
    const fake = fakePage({ "#container": { x: 0, y: 0, width: 800, height: 9000 } })
    const plan = resolveShot(req({ multiPage: 3000 }), "file:///a", DEFAULTS)

    const images = await shoot(fake.page, plan)

    expect(images).toHaveLength(3)
    // 一次 goto 截取三张，页面只渲染一次
    expect(fake.opened).toHaveLength(1)
    expect(fake.shots.map(s => s.clip?.y)).toEqual([0, 3000, 6000])
    expect(images.map(img => img[0])).toEqual([1, 2, 3])
    for (const shot of fake.shots) expect(shot.type).toBe("jpeg")
  })
})
