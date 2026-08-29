/**
 * 模块职责：Chromium 探测与启动参数的测试
 * 依赖方向：测试文件，依赖 chromium.ts
 * 生命周期：每个用例使用一个临时目录；环境变量于 afterEach 中还原
 * 注意事项：**不断言"未探测到浏览器"**。执行测试的机器上安装了何种浏览器、是否存在
 *          `~/.cache/puppeteer`，均不在测试的控制范围内，此类断言将在其他机器上
 *          随机失败。此处仅固定可控部分：优先级顺序、参数拼接、提示文案。
 *
 *          `ENV_KEYS` 中的四个变量必须在每个用例前清空 —— 开发机上极可能确实设置了
 *          `PUPPETEER_EXECUTABLE_PATH`，未清空将使"配置优先于环境变量"一类用例
 *          成为偶然通过。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PlatformInfo, RuntimePaths } from "@yunzai-ng/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildArgs, findChromium, missingChromiumHint } from "./chromium.js"

/** 探测过程中会读取的环境变量 */
const ENV_KEYS = ["YZNG_CHROMIUM_PATH", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "CHROMIUM_PATH"]

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

describe("findChromium", () => {
  let root: string
  let saved: Record<string, string | undefined>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-chromium-"))
    saved = {}
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
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

    // 不存在亦须返回：使用者填写错误路径时应看到"该路径无法打开"，
    // 静默替换为系统浏览器只会使其误认为配置已生效
    expect(found).toEqual({ path: missing, source: "config" })
  })

  it("配置留空或仅含空白时不视为已指定", async () => {
    const exe = join(root, "from-env")
    await writeFile(exe, "")
    process.env["YZNG_CHROMIUM_PATH"] = exe

    expect(findChromium({ configured: "   ", paths: paths(root), platform: platform() })).toEqual({
      path: exe,
      source: "env"
    })
    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({ path: exe, source: "env" })
  })

  it("环境变量按声明顺序读取，并跳过指向不存在文件的项", async () => {
    const real = join(root, "real")
    await writeFile(real, "")
    // 靠前的变量指向一个不存在的文件：应予跳过，而非使整条探测失败
    process.env["YZNG_CHROMIUM_PATH"] = join(root, "nope")
    process.env["CHROME_PATH"] = real

    expect(findChromium({ paths: paths(root), platform: platform() })).toEqual({ path: real, source: "env" })
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
  it("按操作系统给出可直接执行的指引", () => {
    expect(missingChromiumHint(platform({ os: "windows" }))).toContain("Edge")
    expect(missingChromiumHint(platform({ os: "android" }))).toContain("pkg install chromium")
    expect(missingChromiumHint(platform({ os: "linux", isTermux: true }))).toContain("pkg install chromium")
    expect(missingChromiumHint(platform({ os: "linux" }))).toContain("chromium")
  })

  it("各操作系统的提示均提及面板设置，使用者始终存在一条可行路径", () => {
    for (const os of ["windows", "android", "linux", "macos", "unknown"] as const) {
      expect(missingChromiumHint(platform({ os }))).toContain("面板")
    }
  })
})
