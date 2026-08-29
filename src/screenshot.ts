/**
 * 模块职责：将一份渲染请求转换为"截取几张图、以何方式截取"，并执行截图
 * 依赖方向：仅依赖 `browser.ts` 的结构化接口与类型包 —— 同样不 import puppeteer
 * 生命周期：无状态，纯函数与一个执行函数
 * 注意事项：分页只测量一次元素的 boundingBox，随后对同一份已渲染完成的页面按 `clip`
 *          取不同纵向区间 —— 页面自始至终仅渲染一次，切片为纯读取操作，既无滚动
 *          时序问题，亦无需 sleep。
 *
 *          缩放经由 `deviceScaleFactor` 而非模板中的 CSS zoom：CSS 缩放会实际改变
 *          布局（flex 与绝对定位常因此出现异常），而 DPR 仅影响输出位图密度。
 *          因此注入模板的 `sys.scale` 恒为 1，模板里已有的 zoom 语句成为空操作，
 *          不会与 DPR 叠乘。
 */
import type { RenderImageType, RenderRequest } from "@yunzai-ng/types"
import type { BoxLike, GotoOptions, PageLike, ShotOptions, ViewportLike } from "./browser.js"
import type { WaitUntil } from "./config.js"

/**
 * 默认视口
 *
 * 沿用 puppeteer 自身的 800×600。现存模板均按该宽度调过样式，变更取值可能触发
 * 其中的媒体查询。真正决定图片尺寸的是被截元素自身的 CSS 宽度，而非视口。
 */
export const DEFAULT_VIEWPORT = { width: 800, height: 600 } as const

/** 缺省截图选择器；未命中时回落 `body` */
export const DEFAULT_SELECTOR = "#container"

/** 生成截图方案时用到的配置缺省值 */
export interface ShotDefaults {
  /** 分页页高（CSS 像素） */
  pageHeight: number
  /** 页面加载超时毫秒 */
  gotoTimeout: number
  /** 何时认为加载完成 */
  waitUntil: WaitUntil
}

/** 一次截图的完整方案 */
export interface ShotPlan {
  /** 要打开的 file URL */
  url: string
  /** 截图元素选择器 */
  selector: string
  /** 视口 */
  viewport: ViewportLike
  /** 跳转参数 */
  goto: GotoOptions
  /** 截图参数（不含 clip，clip 由实际测量结果决定） */
  shot: Omit<ShotOptions, "clip">
  /** 分页页高；不分页时 undefined */
  pageHeight: number | undefined
  /** 传入模板的 `sys.scale`，恒为 1，参见文件头 */
  templateScale: 1
  /** 被忽略的选项说明，用于在日志中告知调用方 */
  warnings: string[]
}

/**
 * 取正整数，取值非法时采用缺省值
 * @param value 输入
 * @param fallback 缺省值
 * @returns 正整数
 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 决定输出格式
 *
 * 分页时强制 jpeg：数张 png 长图动辄十余 MB，发送后极可能被平台拒收。
 * @param req 渲染请求
 * @param paged 是否分页
 * @returns 输出格式
 */
function resolveType(req: RenderRequest, paged: boolean): RenderImageType {
  if (paged) return "jpeg"
  return req.type ?? "jpeg"
}

/**
 * 将渲染请求与配置缺省值计算为截图方案
 *
 * 纯函数，不含 IO，因此"哪些选项会被静默忽略"这一行为可由测试固定。
 * @param req 渲染请求
 * @param url 中间 HTML 的 file URL
 * @param defaults 配置缺省值
 * @returns 截图方案
 */
export function resolveShot(req: RenderRequest, url: string, defaults: ShotDefaults): ShotPlan {
  const warnings: string[] = []

  const paged = req.multiPage !== undefined && req.multiPage !== false
  const pageHeight = paged
    ? positive(typeof req.multiPage === "number" ? req.multiPage : undefined, defaults.pageHeight)
    : undefined

  if (paged && req.type && req.type !== "jpeg") {
    warnings.push(`分页输出强制为 jpeg，已忽略 type=${req.type}`)
  }
  const type = resolveType(req, paged)

  const omitBackground = req.omitBackground === true
  if (omitBackground && type !== "png" && type !== "webp") {
    warnings.push(`omitBackground 仅对 png/webp 生效，当前格式为 ${type}，已忽略`)
  }

  const shot: Omit<ShotOptions, "clip"> = {
    type,
    // png 不接受 quality，传入该参数将使 puppeteer 抛错
    quality: type === "png" ? undefined : positive(req.quality, 90),
    omitBackground: omitBackground && (type === "png" || type === "webp"),
    captureBeyondViewport: true
  }

  return {
    url,
    selector: req.selector ?? DEFAULT_SELECTOR,
    viewport: {
      width: positive(req.viewport?.width, DEFAULT_VIEWPORT.width),
      height: positive(req.viewport?.height, DEFAULT_VIEWPORT.height),
      deviceScaleFactor: positive(req.viewport?.scale, 1)
    },
    goto: {
      timeout: positive(req.timeout, defaults.gotoTimeout),
      waitUntil: defaults.waitUntil
    },
    shot,
    pageHeight,
    templateScale: 1,
    warnings
  }
}

/**
 * 将一个元素的包围盒切分为若干纵向区间
 *
 * 采用 `round` 而非 `ceil` 决定页数：`ceil` 会使高度刚超过一页的图额外产生一条
 * 仅数十像素高的片段页。页数确定后按整除分配，故末页不会明显短于其余各页。
 * @param box 元素包围盒
 * @param pageHeight 期望页高
 * @returns 各页的裁剪区域
 */
export function sliceBox(box: BoxLike, pageHeight: number): BoxLike[] {
  const count = Math.max(1, Math.round(box.height / pageHeight))
  if (count === 1) return [box]

  const slice = Math.ceil(box.height / count)
  const out: BoxLike[] = []
  for (let i = 0; i < count; i++) {
    const y = box.y + i * slice
    const height = Math.min(slice, box.y + box.height - y)
    if (height <= 0) break
    out.push({ x: box.x, y, width: box.width, height })
  }
  return out
}

/**
 * 执行截图
 * @param page 页面
 * @param plan 截图方案
 * @returns 图片字节，分页时按顺序给出多张
 * @throws 选择器与 `body` 均未命中、或元素无法测得尺寸时抛出
 */
export async function shoot(page: PageLike, plan: ShotPlan): Promise<Uint8Array[]> {
  await page.setViewport(plan.viewport)
  await page.goto(plan.url, plan.goto)

  const target = (await page.$(plan.selector)) ?? (await page.$("body"))
  if (!target) throw new Error(`页面中不存在 ${plan.selector}，且不存在 body，模板输出的可能并非 HTML`)

  const box = await target.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(`${plan.selector} 测得尺寸为 ${box ? `${box.width}×${box.height}` : "不可见"}，无可截取的内容`)
  }

  // 分页与不分页均采用 page.screenshot + clip：元素截图的本质即"按元素包围盒裁剪"，
  // 统一为一条路径可减少一处分支，亦可减少一处仅在分页时才会显现的缺陷
  const regions = plan.pageHeight === undefined ? [box] : sliceBox(box, plan.pageHeight)

  const images: Uint8Array[] = []
  for (const clip of regions) {
    images.push(await page.screenshot({ ...plan.shot, clip }))
  }
  return images
}
