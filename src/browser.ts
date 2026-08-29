/**
 * 模块职责：浏览器生命周期与页面池
 * 依赖方向：仅依赖内核公开入口与类型包 —— **刻意不 import puppeteer**
 * 生命周期：随插件实例创建，`dispose()` 由内核在停机时 await，确保不残留孤儿 Chromium
 * 注意事项：不 import puppeteer 是为了让这段逻辑在没装浏览器的机器上也受测；真实调用收敛在
 *          `launcher.ts`，本模块只依赖结构化接口。四处设计：
 *
 *          **并发闸门在渲染器一侧。** 内核的 `RenderRegistry` 明确不限并发（它无从得知页面池容量），
 *          故此处必须限，否则一条群消息触发数张图就能在 1GB 内存的设备上耗尽 Chromium 可用内存。
 *
 *          **启动是 single-flight。** 用一个 `lock` 布尔量的话，冷启动期间并发到达的渲染会直接失败，
 *          而使用者看到的是「渲染失败」；此处让它们共同等待同一个启动 promise。
 *
 *          **断开后延迟重启。** 在 `disconnected` 里立即重启会让每日只出一张图的实例常驻一个
 *          Chromium 进程；此处只标记为不可用，待下一次实际渲染时再启动。
 *
 *          **区分「自行启动」与「连接接入」。** 靠 `isConnected` 推断会在推断错误时关掉他方的共享
 *          浏览器，故显式记录来源：`external` 只 disconnect，`launch` / `reconnect` 才 close。
 */
import { Semaphore, suggestConcurrency } from "@yunzai-ng/core"
import type { KvNamespace, Logger } from "@yunzai-ng/types"

/** 存储浏览器地址的 KV 键 */
export const ENDPOINT_KEY = "browser-endpoint"

/** 浏览器地址在 KV 中的存活时长；过期仅意味着减少一次重连机会 */
const ENDPOINT_TTL = "7d"

/** 视口设置 */
export interface ViewportLike {
  /** 宽度（CSS 像素） */
  width: number
  /** 高度（CSS 像素） */
  height: number
  /** 设备像素比 */
  deviceScaleFactor: number
}

/** 元素的位置与尺寸 */
export interface BoxLike {
  /** 左上角 x */
  x: number
  /** 左上角 y */
  y: number
  /** 宽度 */
  width: number
  /** 高度 */
  height: number
}

/** 截图参数 */
export interface ShotOptions {
  /** 输出格式 */
  type: "jpeg" | "png" | "webp"
  /** jpeg/webp 质量 */
  quality?: number | undefined
  /** 背景透明 */
  omitBackground?: boolean | undefined
  /** 截取区域（页面坐标系） */
  clip?: BoxLike | undefined
  /** 允许截取视口之外的区域 */
  captureBeyondViewport?: boolean | undefined
}

/** 页面跳转参数 */
export interface GotoOptions {
  /** 超时毫秒 */
  timeout: number
  /** 何时认为加载完成 */
  waitUntil: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"
}

/** 可被截图的元素 */
export interface ElementLike {
  /**
   * 取元素的位置与尺寸
   * @returns 位置尺寸；元素不可见时 null
   */
  boundingBox(): Promise<BoxLike | null>
}

/** 页面 */
export interface PageLike {
  /**
   * 设置视口
   * @param viewport 视口
   */
  setViewport(viewport: ViewportLike): Promise<void>

  /**
   * 打开地址
   * @param url 地址
   * @param options 跳转参数
   */
  goto(url: string, options: GotoOptions): Promise<unknown>

  /**
   * 查找元素
   * @param selector CSS 选择器
   * @returns 元素；未命中时 null
   */
  $(selector: string): Promise<ElementLike | null>

  /**
   * 截图
   * @param options 截图参数
   * @returns 图片字节
   */
  screenshot(options: ShotOptions): Promise<Uint8Array>

  /** 关闭页面 */
  close(): Promise<void>
}

/** 浏览器 */
export interface BrowserLike {
  /**
   * 新建页面
   * @returns 页面
   */
  newPage(): Promise<PageLike>

  /**
   * 取远程调试地址
   * @returns ws 地址
   */
  endpoint(): string

  /** 关闭整个浏览器进程 */
  close(): Promise<void>

  /** 仅断开连接，浏览器进程继续运行 */
  disconnect(): Promise<void>

  /**
   * 订阅断开事件
   * @param cb 断开时调用一次
   */
  onDisconnected(cb: () => void): void
}

/** 启动一个浏览器所需的全部参数 */
export interface LaunchSpec {
  /** 可执行文件绝对路径 */
  executablePath: string
  /** 无头模式 */
  headless: boolean
  /** 启动参数 */
  args: readonly string[]
  /** 用户数据目录 */
  userDataDir: string
  /** 启动超时毫秒 */
  timeout: number
}

/** 浏览器工厂，由 `launcher.ts` 以真实 puppeteer 实现 */
export interface BrowserLauncher {
  /**
   * 启动一个新浏览器
   * @param spec 启动参数
   * @returns 浏览器
   */
  launch(spec: LaunchSpec): Promise<BrowserLike>

  /**
   * 连接一个已有浏览器
   * @param endpoint ws 地址
   * @returns 浏览器
   */
  connect(endpoint: string): Promise<BrowserLike>
}

/** 浏览器来源；决定停机时是 close 还是 disconnect */
export type BrowserOrigin = "launch" | "reconnect" | "external"

/** 页面池每次启动浏览器所需的参数，由插件入口即时读取配置提供 */
export interface PoolPlan {
  /** 使用者配置的外部浏览器地址；非空时不自行启动 */
  wsEndpoint: string
  /** 自行启动时的参数；未探测到浏览器时为 undefined */
  launch: LaunchSpec | undefined
  /** 渲染达到该次数后重启浏览器；0 表示不重启 */
  restartAfter: number
}

/** 页面池构造参数 */
export interface BrowserPoolOptions {
  /** 浏览器工厂 */
  launcher: BrowserLauncher
  /** 即时读取配置，组装本次启动方案 */
  plan: () => PoolPlan
  /** 用于存储浏览器地址 */
  kv: KvNamespace
  /** 日志 */
  logger: Logger
  /** 页面并发上限；缺省按机器规格推断 */
  pages?: number | undefined
}

/**
 * 浏览器与页面池
 *
 * 对外仅暴露 `withPage`：取用页面、使用页面、归还页面三步不拆开交由调用方分别执行 ——
 * 拆开写时漏掉一次归还就是一处页面泄漏。
 */
export class BrowserPool {
  /** 浏览器工厂 */
  readonly #launcher: BrowserLauncher
  /** 即时读取的配置 */
  readonly #plan: () => PoolPlan
  /** KV */
  readonly #kv: KvNamespace
  /** 日志 */
  readonly #logger: Logger
  /** 页面并发闸门 */
  readonly #sem: Semaphore
  /** 页面并发上限（构造时确定：信号量的上限无法在运行中安全变更） */
  readonly #pages: number

  /** 当前浏览器；未启动或已断开时 undefined */
  #browser: BrowserLike | undefined
  /** 当前浏览器的来源 */
  #origin: BrowserOrigin = "launch"
  /** 正在启动的 promise，用于 single-flight */
  #starting: Promise<BrowserLike> | undefined
  /** 正在回收的 promise，同样 single-flight */
  #recycling: Promise<void> | undefined
  /** 已完成的渲染次数，达到阈值时触发重启 */
  #renders = 0
  /** 是否已停机；停机后不再启动新浏览器 */
  #stopped = false

  /**
   * @param opts 构造参数
   */
  constructor(opts: BrowserPoolOptions) {
    this.#launcher = opts.launcher
    this.#plan = opts.plan
    this.#kv = opts.kv
    this.#logger = opts.logger
    const pages = opts.pages && opts.pages > 0 ? opts.pages : suggestConcurrency("render")
    this.#pages = pages
    this.#sem = new Semaphore(pages)
  }

  /** 页面并发上限 */
  get limit(): number {
    return this.#pages
  }

  /** 已完成的渲染次数 */
  get renders(): number {
    return this.#renders
  }

  /** 当前是否存在正常运行的浏览器 */
  get alive(): boolean {
    return this.#browser !== undefined
  }

  /** 排队等待页面的渲染数，供诊断判定并发上限是否过低 */
  get pending(): number {
    return this.#sem.pending
  }

  /**
   * 取用一个页面执行任务
   *
   * 页面必定被关闭（任务抛错亦然），浏览器的重启仅发生于完全空闲时。
   * @param fn 取得页面后执行的任务
   * @returns 任务结果
   * @throws 浏览器无法启动或任务自身抛错时抛出
   */
  async withPage<T>(fn: (page: PageLike) => Promise<T>): Promise<T> {
    return this.#sem.use(async () => {
      // active === 1 表明仅当前调用持有许可：此时无其他渲染正在执行，亦无其他调用
      // 持有 browser 引用等待 newPage，回收是安全的
      const plan = this.#plan()
      if (plan.restartAfter > 0 && this.#renders >= plan.restartAfter && this.#sem.active === 1) {
        this.#logger.info(`已渲染 ${this.#renders} 次，重启浏览器以释放内存`)
        await this.#recycle()
      }

      const browser = await this.#ensure()
      const page = await browser.newPage()
      try {
        return await fn(page)
      } finally {
        this.#renders++
        try {
          await page.close()
        } catch (err) {
          // 页面无法关闭通常意味着浏览器进程已终止，交由 disconnected 处理
          this.#logger.debug(`关闭页面失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })
  }

  /**
   * 当前是否可执行渲染
   *
   * 仅作判定，不启动浏览器 —— 内核会周期性调用该方法以决定是否回落至其他渲染器，
   * 若在此处启动浏览器，"探测"即等同于"常驻一个 Chromium 进程"。
   * @returns 是否可用
   */
  available(): boolean {
    if (this.#stopped) return false
    if (this.#browser) return true
    const plan = this.#plan()
    return plan.wsEndpoint.trim().length > 0 || plan.launch !== undefined
  }

  /**
   * 主动废弃当前浏览器
   *
   * 供配置变更（可执行文件或启动参数发生变化）时调用：不影响正在执行的渲染，
   * 下一次渲染将以新配置重新启动。
   */
  async invalidate(): Promise<void> {
    await this.#recycle()
  }

  /**
   * 停机
   *
   * 内核 `RenderRegistry.stop()` 会 await 该方法，故此处必须完整释放浏览器资源，
   * 否则进程退出后将残留一个无人管理的 Chromium 进程。
   */
  async dispose(): Promise<void> {
    this.#stopped = true
    await this.#recycle()
  }

  /**
   * 确保有一个可用浏览器
   * @returns 浏览器
   * @throws 既无外部地址亦未探测到浏览器时抛出
   */
  async #ensure(): Promise<BrowserLike> {
    if (this.#browser) return this.#browser
    if (this.#starting) return this.#starting
    if (this.#stopped) throw new Error("渲染器已停止")

    const task = this.#start()
    this.#starting = task
    try {
      return await task
    } finally {
      this.#starting = undefined
    }
  }

  /**
   * 实际的启动流程
   * @returns 浏览器
   * @throws 三条路径均不可用时抛出
   */
  async #start(): Promise<BrowserLike> {
    const plan = this.#plan()
    const external = plan.wsEndpoint.trim()

    if (external) {
      const browser = await this.#launcher.connect(external)
      this.#adopt(browser, "external")
      this.#logger.info(`已连接外部浏览器 ${external}`)
      return browser
    }

    // 上次进程被强制终止（SIGKILL / 断电）时，puppeteer 注册的退出钩子已无执行机会，
    // 将残留一个孤儿 Chromium 进程。存储该地址正为此场景：若可重新连接则将其接管，
    // 优于另行启动而令孤儿进程持续占用内存。正常退出时该键已被清除。
    const cached = await this.#kv.get<string>(ENDPOINT_KEY)
    if (cached) {
      try {
        const browser = await this.#launcher.connect(cached)
        this.#adopt(browser, "reconnect")
        this.#logger.info("已接管上次残留的浏览器进程")
        return browser
      } catch {
        await this.#kv.del(ENDPOINT_KEY)
      }
    }

    if (!plan.launch) throw new Error("无可用的浏览器，且未配置外部浏览器地址")

    const browser = await this.#launcher.launch(plan.launch)
    this.#adopt(browser, "launch")
    try {
      await this.#kv.set(ENDPOINT_KEY, browser.endpoint(), { ttl: ENDPOINT_TTL })
    } catch (err) {
      // 写入失败仅减少一次重连机会，不应导致渲染失败
      this.#logger.debug(`浏览器地址写入 KV 失败：${err instanceof Error ? err.message : String(err)}`)
    }
    this.#logger.info(`浏览器已启动：${plan.launch.executablePath}`)
    return browser
  }

  /**
   * 记录新浏览器并注册断开监听
   * @param browser 浏览器
   * @param origin 来源
   */
  #adopt(browser: BrowserLike, origin: BrowserOrigin): void {
    this.#browser = browser
    this.#origin = origin
    this.#renders = 0
    browser.onDisconnected(() => {
      if (this.#browser !== browser) return
      this.#browser = undefined
      this.#logger.warn("浏览器已断开，下一次渲染时将重新启动")
      // 该地址已失效，保留只会使下次启动多作一次无效尝试
      void this.#kv.del(ENDPOINT_KEY).catch(() => undefined)
    })
  }

  /**
   * 关闭当前浏览器
   *
   * 并发调用共享同一次回收；`external` 来源仅断开连接，因该浏览器进程不由本插件管理。
   */
  async #recycle(): Promise<void> {
    if (this.#recycling) return this.#recycling
    const browser = this.#browser
    if (!browser) return

    const origin = this.#origin
    this.#browser = undefined
    this.#renders = 0

    const task = (async () => {
      try {
        if (origin === "external") await browser.disconnect()
        else await browser.close()
      } catch (err) {
        this.#logger.warn(`关闭浏览器失败：${err instanceof Error ? err.message : String(err)}`)
      }
      if (origin !== "external") {
        await this.#kv.del(ENDPOINT_KEY).catch(() => undefined)
      }
    })()

    this.#recycling = task
    try {
      await task
    } finally {
      this.#recycling = undefined
    }
  }
}
