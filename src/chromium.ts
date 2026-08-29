/**
 * 模块职责：定位由安装脚本下载的无头 Chromium，并给出启动参数
 * 依赖方向：依赖 `@puppeteer/browsers` 的缓存布局与类型包
 * 生命周期：探测结果缓存于调用方（`index.ts`）；本模块无状态
 * 注意事项：**不探测系统上的 Edge / Chrome。** 系统浏览器的版本随使用者的机器任意漂移，
 *          而 `puppeteer-core` 只与 {@link BUILD_ID} 这一个构建配套；用系统 Edge 出图时，
 *          「某台机器上少一块背景、多一道边框」这类问题无从复现。故改由 `scripts/install-browser.mjs`
 *          下载固定版本，路径与 CDP 协议均可预期。
 *
 *          例外是 **Linux ARM64 与 Termux**：Chrome for Testing 不发布 arm64 的 Linux 构建
 *          （`@puppeteer/browsers` 会把 `linux_arm` 映射到 `linux64`，下到的是 x86 二进制），
 *          Android 更是连平台都识别不出。那两处只能回落系统 chromium，否则该类设备直接失去出图能力。
 *
 *          探测顺序为「使用者明确指定 → 环境变量 → 已下载的固定版本 → 缓存中的其他版本 →
 *          仅 ARM/Termux 的系统 chromium」，来源越明确则优先级越高。全部采用同步 `existsSync`：
 *          以数次 stat 换取一次启动，异步化并无收益。
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Browser, BrowserPlatform, computeExecutablePath } from "@puppeteer/browsers"
import type { PlatformInfo, RuntimePaths } from "@yunzai-ng/types"

/**
 * 下载的浏览器构建号
 *
 * 与 `puppeteer-core` 24.10.2 内置的 `PUPPETEER_REVISIONS.chrome-headless-shell` 一致 ——
 * 该常量不在 puppeteer-core 的公开导出里，故只能在此重复一份。**升级 puppeteer-core 时必须同步此处**，
 * 否则下到的浏览器与其 CDP 客户端并非同一版本，表现为启动后立即断开一类难以定位的故障。
 */
export const BUILD_ID = "137.0.7151.119"

/**
 * 下载的浏览器产品
 *
 * 取 `chrome-headless-shell` 而非完整 chrome：本插件只截图，不需要窗口、扩展与 DevTools 前端，
 * 而该构建的体积不到完整 chrome 的一半。代价是它**只能无头运行**，故配置中不再提供「无头模式」开关。
 */
export const BROWSER = Browser.CHROMEHEADLESSSHELL

/** 参与读取的环境变量，按优先级排列 */
const ENV_KEYS = ["YZNG_CHROMIUM_PATH", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "CHROMIUM_PATH"] as const

/** 缓存目录下存放浏览器的子目录名；与 `scripts/install-browser.mjs` 保持一致 */
export const CACHE_SUBDIR = "puppeteer"

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
 * 将框架的环境信息映射为 `@puppeteer/browsers` 的平台标识
 *
 * Windows ARM64 归入 win64：Windows 11 ARM 具备 x64 模拟，puppeteer 自身亦如此处理。
 * @param info 环境信息
 * @returns 平台标识；Android 与未知系统无对应值时 undefined
 */
export function toBrowserPlatform(info: PlatformInfo): BrowserPlatform | undefined {
  switch (info.os) {
    case "windows":
      return info.arch === "x64" || info.arch === "arm64" ? BrowserPlatform.WIN64 : BrowserPlatform.WIN32
    case "macos":
      return info.arch === "arm64" ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC
    case "linux":
      return info.arch === "arm64" || info.arch === "arm" ? BrowserPlatform.LINUX_ARM : BrowserPlatform.LINUX
    default:
      return undefined
  }
}

/**
 * 判断该平台能否下载到可用的浏览器
 *
 * `linux_arm` 亦返回 false：`@puppeteer/browsers` 会把它映射到 `linux64` 的归档，
 * 下载本身会成功，但得到的是 x86-64 二进制，在 arm64 上无法执行 —— 这比直接报「不支持」更难定位。
 * @param info 环境信息
 * @returns 是否可下载
 */
export function canDownloadFor(info: PlatformInfo): boolean {
  if (info.os === "android" || info.isTermux) return false
  const platform = toBrowserPlatform(info)
  return platform !== undefined && platform !== BrowserPlatform.LINUX_ARM
}

/**
 * 列出可能存放已下载浏览器的缓存根目录
 *
 * 给出多处而非一处，是因为 `scripts/install-browser.mjs` 在 `pnpm install` 期间运行，
 * 那时它无从得知框架主目录（工作目录是插件目录本身），只能按同样的顺序猜。
 * 两侧都扫这一组，即可使「脚本装到哪」与「运行期从哪找」始终一致。
 * @param paths 目录布局
 * @returns 缓存根目录，按优先级排列
 */
export function cacheRoots(paths: RuntimePaths): string[] {
  const roots = [join(paths.cache, CACHE_SUBDIR)]
  const explicit = process.env["YZNG_CHROMIUM_CACHE"]?.trim()
  if (explicit) roots.unshift(explicit)
  roots.push(join(homedir(), ".cache", CACHE_SUBDIR))
  return roots
}

/**
 * 归档目录名中平台对应的片段
 * @param platform 平台标识
 * @returns 片段，如 `win64`
 */
function folderOf(platform: BrowserPlatform): string {
  switch (platform) {
    case BrowserPlatform.LINUX:
    case BrowserPlatform.LINUX_ARM:
      return "linux64"
    case BrowserPlatform.MAC_ARM:
      return "mac-arm64"
    case BrowserPlatform.MAC:
      return "mac-x64"
    case BrowserPlatform.WIN32:
      return "win32"
    case BrowserPlatform.WIN64:
      return "win64"
  }
}

/**
 * 列出一个构建目录内可执行文件的候选相对路径
 *
 * 不调用 `computeExecutablePath`：那需要预先知道构建号，而扫描的目的正是找出未知的构建号。
 * @param product 产品名
 * @param platform 平台标识
 * @returns 候选相对路径
 */
function exeCandidates(product: string, platform: BrowserPlatform): string[] {
  const folder = folderOf(platform)
  const win = platform === BrowserPlatform.WIN32 || platform === BrowserPlatform.WIN64
  const mac = platform === BrowserPlatform.MAC || platform === BrowserPlatform.MAC_ARM

  if (product === Browser.CHROMEHEADLESSSHELL) {
    return [join(`chrome-headless-shell-${folder}`, win ? "chrome-headless-shell.exe" : "chrome-headless-shell")]
  }
  if (mac) {
    return [join(`chrome-${folder}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")]
  }
  return [join(`chrome-${folder}`, win ? "chrome.exe" : "chrome")]
}

/**
 * 比较两个构建号的新旧
 *
 * 不能改用字符串比较：构建号形如 `140.0.1234.5`，按字典序 `99` 大于 `140`，
 * 会把旧构建当作最新的选出来。
 * @param a 构建号
 * @param b 构建号
 * @returns a 较新时为正，较旧时为负
 */
function compareBuildIds(a: string, b: string): number {
  const left = a.split(".")
  const right = b.split(".")
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    // 缺失的段视为 0，使 `137.0` 与 `137.0.0.0` 等价
    const diff = Number(left[i] ?? 0) - Number(right[i] ?? 0)
    // 非数字段（如带后缀的目录名）相减得 NaN，此时退回逐段字符串比较
    if (Number.isNaN(diff)) {
      const fallback = (left[i] ?? "").localeCompare(right[i] ?? "")
      if (fallback !== 0) return fallback
      continue
    }
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 在缓存中扫描任一已下载的构建
 *
 * 固定版本未命中时才走到此处：使用者可能装的是上一版插件下载的构建，或手工执行过
 * `@puppeteer/browsers` 的 CLI。能出图优于因版本号差一位而报「未安装浏览器」。
 * @param root 缓存根目录
 * @param platform 平台标识
 * @returns 命中的可执行文件路径与产品名；未命中时 undefined
 */
function scanCache(root: string, platform: BrowserPlatform): { path: string; product: string } | undefined {
  for (const product of [Browser.CHROMEHEADLESSSHELL, Browser.CHROME, Browser.CHROMIUM]) {
    const dir = join(root, product)
    let builds: string[]
    try {
      builds = readdirSync(dir)
    } catch {
      continue
    }
    const prefix = `${platform}-`
    // 目录名形如 `<平台>-<构建号>`，按构建号从新到旧遍历
    const sorted = builds
      .filter(name => name.startsWith(prefix))
      .sort((a, b) => compareBuildIds(b.slice(prefix.length), a.slice(prefix.length)))
    for (const build of sorted) {
      for (const rel of exeCandidates(product, platform)) {
        const file = join(dir, build, rel)
        if (existsSync(file)) return { path: file, product }
      }
    }
  }
  return undefined
}

/**
 * 列出 ARM / Termux 上系统 chromium 的候选路径
 *
 * 仅这两类平台走到此处，理由见文件头。列表里不含 Edge 与 Chrome ——
 * 它们在此类设备上不存在，写上去只是徒增 stat。
 * @param info 环境信息
 * @returns 候选可执行文件路径
 */
function systemCandidates(info: PlatformInfo): string[] {
  const out: string[] = []

  if (info.os === "android" || info.isTermux) {
    // Termux 的 $PREFIX 并非 /usr，硬编码路径将无法命中
    const prefix = process.env["PREFIX"] ?? "/data/data/com.termux/files/usr"
    out.push(join(prefix, "bin", "chromium"), join(prefix, "bin", "chromium-browser"), join(prefix, "bin", "chrome"))
  }

  out.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium-browser-stable", "/snap/bin/chromium")
  return out
}

/** 探测参数 */
export interface FindChromiumOptions {
  /** 配置里明确指定的路径，优先级最高 */
  configured?: string | undefined
  /** 目录布局，用于定位下载缓存 */
  paths: RuntimePaths
  /** 环境信息 */
  platform: PlatformInfo
}

/** 探测结果 */
export interface ChromiumFound {
  /** 可执行文件绝对路径 */
  path: string
  /** 来源，记入日志以便解释「何以选用该浏览器」 */
  source: "config" | "env" | "download" | "cache" | "system"
  /**
   * 传给 puppeteer 的 `headless` 取值
   *
   * `chrome-headless-shell` 必须用 `"shell"`（即旧版无头实现）启动，传 `true` 会使 puppeteer
   * 附加 `--headless=new`，而该构建不认识这个开关。完整 chrome 则用 `true`。
   */
  headless: true | "shell"
}

/**
 * 判断一个可执行文件是否为 headless shell 构建
 * @param file 可执行文件路径
 * @returns 是否为 headless shell
 */
function isShell(file: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop() ?? ""
  return /^(chrome-headless-shell|headless_shell)(\.exe)?$/i.test(name)
}

/**
 * 检索一个可用的 Chromium
 *
 * 配置中明确指定的路径即使不存在亦会被返回，并在后续启动时报错 —— 使用者填写了错误路径时，
 * 应看到「该路径无法打开」，而非被静默替换为下载的构建而无从判断。
 * @param opts 探测参数
 * @returns 探测结果；全部未命中时 undefined
 */
export function findChromium(opts: FindChromiumOptions): ChromiumFound | undefined {
  const configured = opts.configured?.trim()
  if (configured) return { path: configured, source: "config", headless: isShell(configured) ? "shell" : true }

  for (const key of ENV_KEYS) {
    const value = process.env[key]?.trim()
    if (value && existsSync(value)) {
      return { path: value, source: "env", headless: isShell(value) ? "shell" : true }
    }
  }

  const platform = toBrowserPlatform(opts.platform)
  if (platform !== undefined) {
    for (const root of cacheRoots(opts.paths)) {
      // 先按固定构建号直接拼路径：命中时无须读目录
      const exact = computeExecutablePath({ browser: BROWSER, platform, buildId: BUILD_ID, cacheDir: root })
      if (existsSync(exact)) return { path: exact, source: "download", headless: "shell" }
    }
    for (const root of cacheRoots(opts.paths)) {
      const hit = scanCache(root, platform)
      if (hit) {
        return { path: hit.path, source: "cache", headless: hit.product === Browser.CHROMEHEADLESSSHELL ? "shell" : true }
      }
    }
  }

  // 下载不可用的平台才回落系统 chromium，见文件头
  if (!canDownloadFor(opts.platform)) {
    for (const file of systemCandidates(opts.platform)) {
      if (existsSync(file)) return { path: file, source: "system", headless: isShell(file) ? "shell" : true }
    }
  }

  return undefined
}

/**
 * 组装启动参数
 *
 * 使用者配置的参数置于末尾：Chromium 对重复参数取最后一项，故「追加」即等同于「覆盖」。
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
 * 错误信息应可直接依照执行。仅输出「Chromium not found」等同于将问题原样返回。
 * @param info 环境信息
 * @returns 中文指引
 */
export function missingChromiumHint(info: PlatformInfo): string {
  if (canDownloadFor(info)) {
    return (
      "尚未下载无头浏览器。请在本插件目录下执行 pnpm run install:browser 下载（约 100MB，" +
      "国内网络可先设置 YZNG_CHROMIUM_MIRROR=https://cdn.npmmirror.com/binaries/chrome-for-testing）；" +
      "亦可在面板的渲染器设置中将「浏览器可执行文件」填写为绝对路径"
    )
  }
  if (info.os === "android" || info.isTermux) {
    return (
      "Chrome for Testing 不提供 Android 构建，无法自动下载。请在 Termux 中执行 pkg install chromium，" +
      "本插件会自动使用它；若装在非默认位置，请在面板的渲染器设置中填写其绝对路径"
    )
  }
  return (
    "Chrome for Testing 不提供 Linux ARM64 构建，无法自动下载。请用包管理器安装 chromium" +
    "（如 apt install chromium），本插件会自动使用它；亦可在面板的渲染器设置中填写其绝对路径"
  )
}
