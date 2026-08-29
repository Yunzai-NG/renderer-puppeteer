/**
 * 模块职责：渲染器插件的配置 schema 与派生的运行时参数
 * 依赖方向：仅依赖内核的 schema 工具与类型包
 * 生命周期：模块加载期构造一次 schema；`resolveRuntime` 在每次渲染前调用（纯计算，开销可忽略）
 * 注意事项：**该 schema 即面板上的"渲染器设置"表单**，无任何一行前端代码为其单独编写。
 *
 *          字段分为两类，其分界十分重要：
 *          - **启动类**（`chromiumPath` / `wsEndpoint` / `headless` / `args` / `userDataDir`）
 *            变更后须重启浏览器方可生效，`LAUNCH_KEYS` 列出该组字段，插件入口据此在
 *            配置变更时回收浏览器。
 *          - **渲染类**（超时、页高、并发等）于每次渲染时即时读取，变更后立即生效。
 */
import { s } from "@yunzai-ng/core"
import type { Infer } from "@yunzai-ng/core"
import type { DeepReadonly } from "@yunzai-ng/types"

/** 页面加载完成的判定时机 */
export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2"

/** 配置 schema */
export const CONFIG_SCHEMA = s.object({
  chromiumPath: s
    .file()
    .default("")
    .title("Chromium 可执行文件")
    .desc("留空时自动探测（Windows 上将探测 Edge 与 Chrome）。探测失败时于此填写绝对路径")
    .placeholder("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
    .group("浏览器")
    .order(1),

  wsEndpoint: s
    .string()
    .default("")
    .title("连接已有浏览器")
    .desc("填写后不再自行启动浏览器，而是连接该地址（如 browserless）。留空表示由本机启动")
    .placeholder("ws://127.0.0.1:9222/devtools/browser/xxxx")
    .group("浏览器")
    .order(2),

  headless: s
    .boolean()
    .default(true)
    .title("无头模式")
    .desc("关闭后将显示真实浏览器窗口，仅在排查渲染结果异常时需要")
    .group("浏览器")
    .order(3),

  args: s
    .tags()
    .default([])
    .title("追加启动参数")
    .desc("追加于内置参数之后，同名参数以此处为准。不确定其含义时请勿填写")
    .group("浏览器")
    .order(4),

  userDataDir: s
    .dir()
    .default("")
    .title("浏览器用户目录")
    .desc("留空时采用缓存目录下的 chromium-profile。多个框架实例不得共用同一目录")
    .group("浏览器")
    .order(5),

  launchTimeout: s
    .duration()
    .default("60s")
    .title("浏览器启动超时")
    .desc("低配 Android 设备上冷启动可能需要半分钟以上")
    .group("浏览器")
    .order(6),

  restartAfter: s
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(200)
    .title("渲染指定次数后重启浏览器")
    .desc("Chromium 长时间运行时内存占用持续上升，定期重启为最简便的处置方式。0 表示从不重启")
    .group("浏览器")
    .order(7),

  pages: s
    .number()
    .int()
    .min(0)
    .max(16)
    .default(0)
    .title("同时渲染的页面数")
    .desc("0 表示按机器内存与核心数自动决定。内核不限制并发，此处为唯一的并发闸门")
    .group("渲染")
    .order(10),

  gotoTimeout: s
    .duration()
    .default("60s")
    .title("页面加载超时")
    .desc("模板引用了外部网络图片而无法连接时，阻塞即发生于该步骤")
    .group("渲染")
    .order(11),

  waitUntil: s
    .select([
      {
        value: "networkidle2",
        label: "网络基本空闲（推荐）",
        description: "等待 500ms 内连接数不超过 2 个，兼容性最佳"
      },
      { value: "networkidle0", label: "网络完全空闲", description: "更为可靠但更慢；模板存在长连接时将持续等待至超时" },
      { value: "load", label: "load 事件", description: "仅等待资源加载完成，不含脚本的后续请求" },
      { value: "domcontentloaded", label: "DOM 就绪", description: "速度最快，但图片可能尚未绘制完成" }
    ])
    .default("networkidle2")
    .title("页面渲染完成的判定时机")
    .group("渲染")
    .order(12),

  pageHeight: s
    .number()
    .int()
    .min(500)
    .max(20000)
    .default(4000)
    .title("长图分页页高")
    .desc("请求分页且未指定页高时采用该值，单位为 CSS 像素")
    .group("渲染")
    .order(13),

  templateCache: s
    .number()
    .int()
    .min(8)
    .max(4096)
    .default(128)
    .title("模板编译缓存条数")
    .desc("编译结果按该上限执行 LRU，模板再多也不会让内存只升不降")
    .group("渲染")
    .order(14),

  keepHtml: s
    .boolean()
    .default(false)
    .title("保留中间 HTML")
    .desc("排查模板问题时启用，产物位于临时目录 render/<插件名>/ 下，同名模板相互覆盖，不会堆积")
    .group("渲染")
    .order(15),

  tailwind: s
    .boolean()
    .default(true)
    .title("编译 Tailwind 工具类")
    .desc("仅作用于 TSX 模板；旧 HTML 模板一律不受影响。未安装 tailwindcss 时自动跳过，不影响出图")
    .group("渲染")
    .order(16),

  tailwindEntry: s
    .string()
    .default("tailwind.css")
    .title("Tailwind 入口 CSS")
    .desc('相对发起插件的模板根解析。文件不存在时使用内置的 @import "tailwindcss"，故仅在需要定制主题时才须创建')
    .placeholder("tailwind.css")
    .group("渲染")
    .order(17)
})

/** 渲染器配置 */
export type RendererConfig = Infer<typeof CONFIG_SCHEMA>

/** 只读的配置快照，即 `ctx.config.get()` 的返回类型 */
export type RendererConfigView = DeepReadonly<RendererConfig>

/**
 * 变更后须重启浏览器方可生效的字段
 *
 * 用于 `ctx.config.onChange`：仅当上述键发生变更时才回收浏览器，超时之类字段的变更
 * 不应导致正在运行的浏览器重启。
 */
export const LAUNCH_KEYS: readonly (keyof RendererConfig)[] = [
  "chromiumPath",
  "wsEndpoint",
  "headless",
  "args",
  "userDataDir"
]
