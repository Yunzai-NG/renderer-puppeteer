/**
 * 模块职责：定位可用的 Chromium 可执行文件，并给出启动参数
 * 依赖方向：仅依赖内核公开入口与类型包
 * 生命周期：探测结果缓存于调用方（`browser.ts`）；本模块无状态
 * 注意事项：使用的是 `puppeteer-core`，**其不附带浏览器**。此为刻意选择：`puppeteer`
 *          完整包每次安装均需下载约 150MB 的 Chromium，在 Termux 上无法完成安装，
 *          而绝大多数 Windows 使用者的机器中已装有 Edge。因此此处的探测质量直接决定了
 *          "安装完成后能否正常出图"。
 *
 *          探测顺序为"使用者明确指定 → 环境变量 → 系统浏览器 → 下载缓存"，
 *          来源越明确则优先级越高，不作任何猜测式回落。全部采用同步 `existsSync`：
 *          以十余次 stat 换取一次启动，异步化并无收益。
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { PlatformInfo, RuntimePaths } from "@yunzai-ng/types"

/** 参与读取的环境变量，按优先级排列 */
const ENV_KEYS = ["YZNG_CHROMIUM_PATH", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "CHROMIUM_PATH"] as const

/** 全部平台通用的启动参数 */
const COMMON_ARGS: readonly string[] = [
  // 无头模式下 GPU 仅引入驱动兼容问题，不带来性能提升
  "--disable-gpu",
  // 容器与 Termux 中无法取得 sandbox 所需的内核能力，不关闭则无法启动
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // 容器缺省的 /dev/shm 仅 64MB，长图截图将导致标签页终止
  "--disable-dev-shm-usage",
  // 截图中不应出现滚动条
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  // 后台标签页会被降频，而渲染页面恒处于后台
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling"
]

/** Android / Termux 额外所需的参数 */
const ANDROID_ARGS: readonly string[] = [
  // Termux 中 zygote 与多进程模型频繁终止，退化为单进程最为稳定
  "--no-zygote",
  "--single-process"
]

/**
 * 展开一个可能不存在的环境变量目录
 * @param key 环境变量名
 * @param fallback 变量为空时的回落值
 * @returns 目录路径
 */
function envDir(key: string, fallback: string): string {
  const value = process.env[key]
  return value && value.length > 0 ? value : fallback
}

/**
 * 列出 Windows 上的候选路径
 * @returns 候选可执行文件路径
 */
function windowsCandidates(): string[] {
  const programFiles = envDir("ProgramFiles", "C:\\Program Files")
  const programFilesX86 = envDir("ProgramFiles(x86)", "C:\\Program Files (x86)")
  const localAppData = envDir("LOCALAPPDATA", join(homedir(), "AppData", "Local"))

  const rel = [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Chromium", "Application", "chrome.exe"],
    ["Microsoft", "Edge Beta", "Application", "msedge.exe"]
  ]

  const out: string[] = []
  // 64 位 Windows 上 Edge 安装于 Program Files (x86)，Chrome 则相反，故两侧均需检索
  for (const base of [programFilesX86, programFiles, localAppData]) {
    for (const parts of rel) out.push(join(base, ...parts))
  }
  return out
}

/**
 * 列出类 Unix 系统上的候选路径
 * @param info 环境信息
 * @returns 候选可执行文件路径
 */
function unixCandidates(info: PlatformInfo): string[] {
  const out: string[] = []

  if (info.os === "android" || info.isTermux) {
    // Termux 的 $PREFIX 并非 /usr，硬编码路径将无法命中
    const prefix = envDir("PREFIX", "/data/data/com.termux/files/usr")
    out.push(join(prefix, "bin", "chromium"), join(prefix, "bin", "chromium-browser"), join(prefix, "bin", "chrome"))
  }

  if (info.os === "macos") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    )
  }

  out.push(
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome"
  )
  return out
}

/**
 * 在 puppeteer 的下载缓存中检索浏览器
 *
 * 缓存布局为 `<cache>/<chrome|chromium|chrome-headless-shell>/<平台-版本>/<...>/<可执行文件>`，
 * 版本号无法预知，只能扫描一层目录。Windows 打包版会将浏览器置于内核缓存目录，
 * 即经由此路径命中。
 * @param root 缓存根目录
 * @param info 环境信息
 * @returns 命中的可执行文件路径；未命中时 undefined
 */
function scanDownloadCache(root: string, info: PlatformInfo): string | undefined {
  const exe = info.os === "windows" ? "chrome.exe" : "chrome"
  const macApp = ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]

  for (const product of ["chrome", "chromium", "chrome-headless-shell"]) {
    const dir = join(root, product)
    let builds: string[]
    try {
      builds = readdirSync(dir)
    } catch {
      continue
    }
    // 新版本目录名中的版本号更大，倒序可使新版本优先被选中
    for (const build of builds.sort().reverse()) {
      const base = join(dir, build)
      const inner = [
        join(base, exe),
        join(base, `${product}-${info.os === "windows" ? "win64" : "linux64"}`, exe),
        join(base, ...macApp)
      ]
      for (const file of inner) {
        if (existsSync(file)) return file
      }
    }
  }
  return undefined
}

/** 探测参数 */
export interface FindChromiumOptions {
  /** 配置里明确指定的路径，优先级最高 */
  configured?: string | undefined
  /** 目录布局，用于扫描下载缓存 */
  paths: RuntimePaths
  /** 环境信息 */
  platform: PlatformInfo
}

/** 探测结果 */
export interface ChromiumFound {
  /** 可执行文件绝对路径 */
  path: string
  /** 来源，记入日志以便解释"何以选用该浏览器" */
  source: "config" | "env" | "system" | "cache"
}

/**
 * 检索一个可用的 Chromium
 *
 * 配置中明确指定的路径即使不存在亦会被返回，并在后续启动时报错 —— 使用者填写了
 * 错误路径时，应看到"该路径无法打开"，而非被静默替换为系统 Edge 而无从判断。
 * @param opts 探测参数
 * @returns 探测结果；全部未命中时 undefined
 */
export function findChromium(opts: FindChromiumOptions): ChromiumFound | undefined {
  const configured = opts.configured?.trim()
  if (configured) return { path: configured, source: "config" }

  for (const key of ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value && existsSync(value)) return { path: value, source: "env" }
  }

  const system = opts.platform.os === "windows" ? windowsCandidates() : unixCandidates(opts.platform)
  for (const file of system) {
    if (existsSync(file)) return { path: file, source: "system" }
  }

  for (const root of [join(opts.paths.cache, "puppeteer"), join(homedir(), ".cache", "puppeteer")]) {
    const hit = scanDownloadCache(root, opts.platform)
    if (hit) return { path: hit, source: "cache" }
  }

  return undefined
}

/**
 * 组装启动参数
 *
 * 使用者配置的参数置于末尾：Chromium 对重复参数取最后一项，故"追加"即等同于"覆盖"。
 * @param info 环境信息
 * @param extra 使用者追加的参数
 * @returns 启动参数
 */
export function buildArgs(info: PlatformInfo, extra: readonly string[] = []): string[] {
  const args = [...COMMON_ARGS]
  if (info.os === "android" || info.isTermux) args.push(...ANDROID_ARGS)
  args.push(...extra.filter(arg => arg.trim().length > 0))
  return args
}

/**
 * 探测失败时向使用者给出的说明
 *
 * 错误信息应可直接依照执行。仅输出"Chromium not found"等同于将问题原样返回。
 * @param info 环境信息
 * @returns 中文指引
 */
export function missingChromiumHint(info: PlatformInfo): string {
  if (info.os === "windows") {
    return "未检索到可用的浏览器。Windows 自带的 Edge 通常即可使用，若已卸载请安装 Edge 或 Chrome；亦可在面板的渲染器设置中将「Chromium 可执行文件」填写为绝对路径"
  }
  if (info.os === "android" || info.isTermux) {
    return "未检索到可用的浏览器。请在 Termux 中执行 pkg install chromium 安装，或在面板的渲染器设置中指定路径"
  }
  return "未检索到可用的浏览器。请使用包管理器安装 chromium / google-chrome，或在面板的渲染器设置中将「Chromium 可执行文件」填写为绝对路径"
}
