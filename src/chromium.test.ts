/**
 * 模块职责：浏览器探测与启动参数的测试
 * 依赖方向：测试文件，依赖 chromium.ts
 * 生命周期：每个用例一个临时目录；环境变量于 afterEach 还原
 * 注意事项：**每个用例都须把 `YZNG_CHROMIUM_CACHE` 指向临时目录**。探测会扫 `~/.cache/puppeteer`，
 *          而开发机上那里往往真装着浏览器 —— 不隔离的话，「未命中时回落系统 chromium」一类用例
 *          会因为命中了开发机的缓存而假通过，且在 CI 上表现相反。
 *
 *          同理，`ENV_KEYS` 四个变量也须清空：开发机上极可能确实设置了 `PUPPETEER_EXECUTABLE_PATH`。
 *
 *          不断言「探测不到任何浏览器」的绝对结果：那取决于执行机器上是否装着 chromium。
 *          此处固定的是可控部分 —— 优先级顺序、平台能力判定、参数拼接、提示文案。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PlatformInfo, RuntimePaths } from "@yunzai-ng/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BROWSER,
  BUILD_ID,
  buildArgs,
  canDownloadFor,
  findChromium,
  missingChromiumHint,
  toBrowserPlatform
} from "./chromium.js"

/** 探测过程中会读取的环境变量，含缓存目录覆盖项 */
const ENV_KEYS = [
  "YZNG_CHROMIUM_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
  "CHROMIUM_PATH",
  "YZNG_CHROMIUM_CACHE"
]

/** 构造一份环境信息，仅写出用例所关注的字段 */
function platform(over: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    os: "linux",
    arch: "x64",
    isTermux: false,
    isContainer: false,
    nodeVersion: process.version,
    cpus: 4,
    totalMemory: 8 * 1024 * 1024 * 1024,
    lowMemory: false,
    ...over
  }
}

/** 构造一份目录布局 */
function paths(home: string): RuntimePaths {
  return {
    home,
    config: join(home, "config"),
    data: join(home, "data"),
    logs: join(home, "logs"),
    temp: join(home, "temp"),
    plugins: join(home, "plugins"),
    runtime: join(home, "runtime"),
    cache: join(home, "cache")
  }
}

/**
 * 在缓存目录里造出一个已下载的浏览器
 * @param root 缓存根目录
 * @param product 产品名
 * @param dirName 构建目录名，形如 `linux-137.0.7151.119`
 * @param rel 可执行文件在构建目录内的相对路径
 * @returns 可执行文件绝对路径
 */
async function fakeDownload(root: string, product: string, dirName: string, rel: string): Promise<string> {
  const file = join(root, product, dirName, rel)
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, "")
  return file
}

describe("findChromium", () => {
  let root: string
  let cache: string
  let saved: Record<string, string | undefined>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-chromium-"))
    cache = join(root, "browser-cache")
    saved = {}
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    // 把缓存指向空的临时目录，隔离开发机上真实的 ~/.cache/puppeteer
    process.env["YZNG_CHROMIUM_CACHE"] = cache
  })

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })

  it("配置中指定的路径原样返回，文件不存在时亦然", () => {
    const missing = join(root, "不存在的文件.exe")
    const found = findChromium({ configured: missing, paths: paths(root), platform: platform() })

    // 不存在亦须返回：使用者填错路径时应看到「该路径无法打开」，
    // 静默换成下载的构建只会让他误以为配置已生效
    expect(found).toEqual({ path: missing, source: "config", headless: true })
  })

  it("配置指向 headless shell 时按 shell 模式启动", () => {
    const exe = join(root, "chrome-headless-shell")
    const found = findChromium({ configured: exe, paths: paths(root), platform: platform() })

    // 传 true 会让 puppeteer 附加 --headless=new，而该构建不认识这个开关
    expect(found?.headless).toBe("shell")
  })

  it("配置留空或仅含空白时不视为已指定", async () => {
    const exe = join(root, "from-env")
    await writeFile(exe, "")
    process.env["YZNG_CHROMIUM_PATH"] = exe

    expect(findChromium({ configured: "   ", paths: paths(root), platform: platform() })?.source).toBe("env")
    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({
      path: exe,
      source: "env",
      headless: true
    })
  })

  it("环境变量按声明顺序读取，并跳过指向不存在文件的项", async () => {
    const real = join(root, "real")
    await writeFile(real, "")
    // 靠前的变量指向一个不存在的文件：应予跳过，而非使整条探测失败
    process.env["YZNG_CHROMIUM_PATH"] = join(root, "nope")
    process.env["CHROME_PATH"] = real

    expect(findChromium({ paths: paths(root), platform: platform() })?.path).toBe(real)
  })

  it("先读取 YZNG_CHROMIUM_PATH，再读取 puppeteer 自身的变量", async () => {
    const mine = join(root, "mine")
    const theirs = join(root, "theirs")
    await writeFile(mine, "")
    await writeFile(theirs, "")
    process.env["PUPPETEER_EXECUTABLE_PATH"] = theirs
    process.env["YZNG_CHROMIUM_PATH"] = mine

    expect(findChromium({ paths: paths(root), platform: platform() })?.path).toBe(mine)
  })

  it("命中固定构建号时来源为 download，且按 shell 模式启动", async () => {
    const exe = await fakeDownload(
      cache,
      BROWSER,
      `linux-${BUILD_ID}`,
      join("chrome-headless-shell-linux64", "chrome-headless-shell")
    )

    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({
      path: exe,
      source: "download",
      headless: "shell"
    })
  })

  it("固定构建号未命中时接受缓存中的其他版本", async () => {
    const exe = await fakeDownload(
      cache,
      BROWSER,
      "linux-140.0.1234.5",
      join("chrome-headless-shell-linux64", "chrome-headless-shell")
    )

    // 版本号差一位就报「未安装浏览器」是错的取舍：能出图优于因此完全不可用
    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({
      path: exe,
      source: "cache",
      headless: "shell"
    })
  })

  it("缓存中存在多个构建时取版本号较大者", async () => {
    await fakeDownload(cache, BROWSER, "linux-99.0.1.2", join("chrome-headless-shell-linux64", "chrome-headless-shell"))
    const newer = await fakeDownload(
      cache,
      BROWSER,
      "linux-140.0.1234.5",
      join("chrome-headless-shell-linux64", "chrome-headless-shell")
    )

    expect(findChromium({ paths: paths(root), platform: platform() })?.path).toBe(newer)
  })

  it("只认属于本平台的构建目录", async () => {
    // 同一个缓存目录可能被另一台机器共享（NFS、跨平台挂载的容器卷）
    await fakeDownload(cache, BROWSER, `win64-${BUILD_ID}`, join("chrome-headless-shell-win64", "chrome-headless-shell.exe"))

    expect(findChromium({ paths: paths(root), platform: platform() })?.source).not.toBe("download")
  })

  it("缓存中只有完整 chrome 时按普通无头模式启动", async () => {
    const exe = await fakeDownload(cache, "chrome", `linux-${BUILD_ID}`, join("chrome-linux64", "chrome"))

    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({
      path: exe,
      source: "cache",
      headless: true
    })
  })

  it("环境变量优先于已下载的构建", async () => {
    await fakeDownload(
      cache,
      BROWSER,
      `linux-${BUILD_ID}`,
      join("chrome-headless-shell-linux64", "chrome-headless-shell")
    )
    const mine = join(root, "mine")
    await writeFile(mine, "")
    process.env["YZNG_CHROMIUM_PATH"] = mine

    // 来源越明确优先级越高：使用者设了变量就是要用那一个
    expect(findChromium({ paths: paths(root), platform: platform() })?.path).toBe(mine)
  })

  it("可下载的平台上不回落系统浏览器", () => {
    // 该平台能下载，故不去碰系统里的 Edge / Chrome —— 系统浏览器版本随机器漂移，
    // 用它出图时「某台机器上少一块背景」无从复现
    const found = findChromium({ paths: paths(root), platform: platform({ os: "windows" }) })

    expect(found?.source).not.toBe("system")
  })
})

describe("toBrowserPlatform", () => {
  it("Windows ARM64 归入 win64，因其具备 x64 模拟", () => {
    expect(toBrowserPlatform(platform({ os: "windows", arch: "arm64" }))).toBe("win64")
    expect(toBrowserPlatform(platform({ os: "windows", arch: "x64" }))).toBe("win64")
  })

  it("macOS 按架构区分，Apple Silicon 有原生构建", () => {
    expect(toBrowserPlatform(platform({ os: "macos", arch: "arm64" }))).toBe("mac_arm")
    expect(toBrowserPlatform(platform({ os: "macos", arch: "x64" }))).toBe("mac")
  })

  it("Android 无对应平台", () => {
    expect(toBrowserPlatform(platform({ os: "android" }))).toBeUndefined()
    expect(toBrowserPlatform(platform({ os: "unknown" }))).toBeUndefined()
  })
})

describe("canDownloadFor", () => {
  it("桌面三平台均可下载", () => {
    expect(canDownloadFor(platform({ os: "windows" }))).toBe(true)
    expect(canDownloadFor(platform({ os: "macos", arch: "arm64" }))).toBe(true)
    expect(canDownloadFor(platform({ os: "linux", arch: "x64" }))).toBe(true)
  })

  it("Linux ARM64 不可下载 —— 归档虽存在但内容是 x86 二进制", () => {
    // Chrome for Testing 不发布 arm64 的 Linux 构建，而 @puppeteer/browsers 会把
    // linux_arm 映射到 linux64 的归档：下载会成功，执行则失败，比直接报错更难定位
    expect(canDownloadFor(platform({ os: "linux", arch: "arm64" }))).toBe(false)
    expect(canDownloadFor(platform({ os: "linux", arch: "arm" }))).toBe(false)
  })

  it("Android 与 Termux 不可下载", () => {
    expect(canDownloadFor(platform({ os: "android" }))).toBe(false)
    // proot 下的 Termux 会被识别成 linux，isTermux 才是判据
    expect(canDownloadFor(platform({ os: "linux", isTermux: true }))).toBe(false)
  })
})

describe("buildArgs", () => {
  it("通用参数中含关闭 sandbox 与 /dev/shm 的两项", () => {
    const args = buildArgs(platform())

    // 二者缺少任一，在容器与 Termux 中即表现为浏览器无法启动或长图截取中途终止
    expect(args).toContain("--no-sandbox")
    expect(args).toContain("--disable-dev-shm-usage")
    expect(args).not.toContain("--single-process")
  })

  it("Android 与 Termux 额外退化为单进程", () => {
    expect(buildArgs(platform({ os: "android" }))).toContain("--single-process")
    // 在 Termux 中使用 proot 时 os 会被识别为 linux，isTermux 方为判据
    expect(buildArgs(platform({ os: "linux", isTermux: true }))).toContain("--no-zygote")
  })

  it("使用者追加的参数排列于最后，空白项被剔除", () => {
    const args = buildArgs(platform(), ["--window-size=1920,1080", "   ", ""])

    expect(args[args.length - 1]).toBe("--window-size=1920,1080")
    expect(args.filter(arg => arg.trim().length === 0)).toHaveLength(0)
  })

  it("追加的参数必定排列于全部内置参数之后", () => {
    // Chromium 对重复参数取最后一项，故"排列于最后"即"可覆盖内置取值"，
    // 该顺序是使用者配置真正生效的唯一条件
    const builtin = buildArgs(platform())
    const args = buildArgs(platform(), ["--font-render-hinting=none"])
    const at = args.indexOf("--font-render-hinting=none")

    expect(at).toBe(builtin.length)
    expect(args.slice(0, builtin.length)).toEqual(builtin)
  })
})

describe("missingChromiumHint", () => {
  it("可下载的平台指向下载命令", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      expect(missingChromiumHint(platform({ os }))).toContain("install:browser")
    }
  })

  it("Android 指向 pkg install chromium 而非下载", () => {
    // 那里下不到浏览器，给出下载命令等于让使用者反复试一条走不通的路
    const hint = missingChromiumHint(platform({ os: "android" }))
    expect(hint).toContain("pkg install chromium")
    expect(hint).not.toContain("install:browser")
  })

  it("Linux ARM64 指向系统包管理器", () => {
    const hint = missingChromiumHint(platform({ os: "linux", arch: "arm64" }))
    expect(hint).toContain("ARM64")
    expect(hint).not.toContain("install:browser")
  })

  it("各平台的提示均给出一条兜底路径", () => {
    for (const os of ["windows", "android", "linux", "macos", "unknown"] as const) {
      expect(missingChromiumHint(platform({ os }))).toContain("面板")
    }
  })
})
