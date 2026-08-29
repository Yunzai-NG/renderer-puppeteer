#!/usr/bin/env node
/**
 * 下载与 puppeteer-core 配套的无头 Chromium
 *
 * 本插件依赖 `puppeteer-core`，其不附带浏览器。此前的做法是探测系统上的 Edge / Chrome，
 * 已撤 —— 系统浏览器的版本随机器任意漂移，而 puppeteer-core 只与一个固定构建配套，
 * 「某台机器上少一块背景」这类问题无从复现。改由本脚本下载固定版本。
 *
 * 取 `chrome-headless-shell` 而非完整 chrome：只截图就不需要窗口、扩展与 DevTools 前端，
 * 体积不到一半。
 *
 * **不挂在 postinstall 上。** 安装插件时静默下载一百多兆是不该由脚本替使用者做的决定，
 * 且 CI 与「只想编译一下」的场景完全不需要浏览器。故须显式执行：
 *
 *   node scripts/install-browser.mjs            下载到框架主目录的 cache/puppeteer
 *   node scripts/install-browser.mjs --check    只报告是否已装，不下载
 *   node scripts/install-browser.mjs --force    已装亦重新下载
 *
 * 环境变量：
 *   YZNG_HOME             框架主目录，据此推出 cache/puppeteer（与内核 paths.ts 的判定一致）
 *   YZNG_CHROMIUM_CACHE   直接指定缓存根目录，优先于上者
 *   YZNG_CHROMIUM_MIRROR  下载镜像，国内网络可用
 *                         https://cdn.npmmirror.com/binaries/chrome-for-testing
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { Browser, BrowserPlatform, canDownload, computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers"

/** 仓库根 */
const ROOT = path.resolve(import.meta.dirname, "..")

/**
 * 下载的构建号
 *
 * 与 `src/chromium.ts` 的 `BUILD_ID` 必须一致。此处不 import 那个模块 —— 它是 TypeScript，
 * 而本脚本要在编译之前就能跑（`pnpm install` 之后、`pnpm run build` 之前即可下载）。
 * 故改为从 package.json 的 `yunzai.browserBuildId` 读取，使两处共用同一个事实来源。
 */
const BUILD_ID = readBuildId()

/** 产品名 */
const BROWSER = Browser.CHROMEHEADLESSSHELL

/**
 * 从 package.json 读取构建号
 * @returns 构建号
 */
function readBuildId() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const id = pkg?.yunzai?.browserBuildId
  if (typeof id !== "string" || id === "") {
    console.error("package.json 里缺少 yunzai.browserBuildId，无法确定要下载的版本")
    process.exit(1)
  }
  return id
}

/**
 * 决定缓存根目录
 *
 * 与 `src/chromium.ts` 的 `cacheRoots()` 取同一组候选，且顺序一致 —— 两侧不一致时，
 * 表现为「下载成功但运行期说没装」，而那时使用者已经等完了一次下载。
 * @returns 缓存根目录绝对路径
 */
function cacheDir() {
  const explicit = process.env.YZNG_CHROMIUM_CACHE?.trim()
  if (explicit) return path.resolve(explicit)

  const home = process.env.YZNG_HOME?.trim()
  if (home) return path.resolve(home, "cache", "puppeteer")

  // 插件装在 <主目录>/plugins/<插件名> 下，故上溯两级即主目录。
  // 该布局由内核的插件安装流程保证，不成立时（开发期直接 checkout）落到下面那条。
  const guess = path.resolve(ROOT, "..", "..")
  if (existsSync(path.join(guess, "config"))) return path.join(guess, "cache", "puppeteer")

  return path.join(homedir(), ".cache", "puppeteer")
}

/**
 * 把 Node 的平台标识映射为下载用的平台标识
 * @returns 平台标识；无对应值时 undefined
 */
function platformOf() {
  const detected = detectBrowserPlatform()
  if (detected === undefined) return undefined
  // Chrome for Testing 不发布 arm64 的 Linux 构建，而 detectBrowserPlatform 仍会返回 linux_arm，
  // 其下载地址指向 linux64 的归档 —— 下得下来但跑不了。此处按「不支持」处理
  if (detected === BrowserPlatform.LINUX_ARM) return undefined
  return detected
}

/**
 * 给出无法下载时的指引
 * @returns 说明文本
 */
function unsupportedHint() {
  if (process.platform === "android" || process.env.PREFIX?.includes("com.termux")) {
    return "Termux / Android 上请执行 pkg install chromium，本插件会自动使用它。"
  }
  if (process.arch === "arm64" || process.arch === "arm") {
    return "Chrome for Testing 不提供 Linux ARM64 构建，请用包管理器安装 chromium（如 apt install chromium）。"
  }
  return "该平台没有可用的 Chrome for Testing 构建，请自行安装 chromium 并在面板中填写其路径。"
}

const platform = platformOf()
const root = cacheDir()
const force = process.argv.includes("--force")
const checkOnly = process.argv.includes("--check")

if (platform === undefined) {
  console.error(`无法为当前平台（${process.platform} ${process.arch}）下载浏览器。`)
  console.error(unsupportedHint())
  // --check 时以 0 退出：该平台本就不该下载，报失败会让 CI 误判
  process.exit(checkOnly ? 0 : 1)
}

const exe = computeExecutablePath({ browser: BROWSER, platform, buildId: BUILD_ID, cacheDir: root })

if (existsSync(exe) && !force) {
  console.error(`浏览器已就绪：${exe}`)
  process.exit(0)
}

if (checkOnly) {
  console.error(`浏览器尚未下载。执行 pnpm run install:browser 下载至 ${root}`)
  process.exit(1)
}

const mirror = process.env.YZNG_CHROMIUM_MIRROR?.trim()
const options = {
  browser: BROWSER,
  buildId: BUILD_ID,
  cacheDir: root,
  platform,
  downloadProgressCallback: "default",
  ...(mirror ? { baseUrl: mirror } : {})
}

if (!(await canDownload(options))) {
  console.error(`下载地址不可用：${BROWSER} ${BUILD_ID} (${platform})`)
  if (mirror) console.error(`当前镜像为 ${mirror}，请确认其提供该版本，或清空 YZNG_CHROMIUM_MIRROR 走官方源`)
  process.exit(1)
}

console.error(`正在下载 ${BROWSER} ${BUILD_ID}（${platform}）至 ${root}`)
if (mirror) console.error(`镜像：${mirror}`)

try {
  const installed = await install(options)
  console.error(`\n下载完成：${installed.executablePath}`)
} catch (err) {
  console.error(`\n下载失败：${err instanceof Error ? err.message : String(err)}`)
  if (!mirror) {
    console.error("国内网络可设置镜像后重试：")
    console.error("  $env:YZNG_CHROMIUM_MIRROR = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'")
  }
  process.exit(1)
}
