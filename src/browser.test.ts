/**
 * 模块职责：浏览器与页面池的测试
 * 依赖方向：测试文件，依赖 browser.ts 的结构化接口；无需真实 Chromium
 * 生命周期：每个用例使用一套替身 launcher 与一份内存 KV，彼此隔离
 * 注意事项：本文件即"browser.ts 刻意不 import puppeteer"这一设计的收益 —— 页面池的
 *          全部行为（single-flight 启动、并发闸门、断开后延迟重启、close 抑或 disconnect）
 *          均可在未安装浏览器的机器上被固定。
 *
 *          KV 使用真实的 `new Kv(new MemoryKvDriver())` 而非手写替身：地址的 TTL 与
 *          删除语义均由内核实现保证，替身则会逐渐与接口产生偏差。
 */
import { Kv, MemoryKvDriver } from "@yunzai-ng/core"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { KvNamespace } from "@yunzai-ng/types"
import { beforeEach, describe, expect, it } from "vitest"
import { BrowserPool, ENDPOINT_KEY } from "./browser.js"
import type { BrowserLauncher, BrowserLike, LaunchSpec, PageLike, PoolPlan } from "./browser.js"

/** 页面替身，仅需满足接口并记录自身是否已被关闭 */
interface FakePage extends PageLike {
  /** 是否已关闭 */
  closed: boolean
}

/** 浏览器替身，记录 close / disconnect 次数，并可手动触发断开 */
interface FakeBrowser extends BrowserLike {
  /** close 调用次数 */
  closes: number
  /** disconnect 调用次数 */
  disconnects: number
  /** 已创建的页面 */
  readonly pages: FakePage[]
  /** 手动触发断开事件 */
  fire(): void
}

/** 构造一个页面替身 */
function fakePage(): FakePage {
  const page: FakePage = {
    closed: false,
    setViewport: async () => undefined,
    goto: async () => undefined,
    $: async () => null,
    screenshot: async () => new Uint8Array(),
    close: async () => {
      page.closed = true
    }
  }
  return page
}

/**
 * 构造一个浏览器替身
 * @param endpoint 远程调试地址
 * @returns 浏览器替身
 */
function fakeBrowser(endpoint: string): FakeBrowser {
  const listeners: Array<() => void> = []
  const browser: FakeBrowser = {
    closes: 0,
    disconnects: 0,
    pages: [],
    newPage: async () => {
      const page = fakePage()
      browser.pages.push(page)
      return page
    },
    endpoint: () => endpoint,
    close: async () => {
      browser.closes++
    },
    disconnect: async () => {
      browser.disconnects++
    },
    onDisconnected: cb => {
      listeners.push(cb)
    },
    fire: () => {
      for (const cb of listeners) cb()
    }
  }
  return browser
}

/** launcher 替身及其观测点 */
interface Rig {
  /** 提供给页面池的工厂 */
  launcher: BrowserLauncher
  /** 每次 launch 收到的参数 */
  launched: LaunchSpec[]
  /** 每次 connect 收到的地址 */
  connected: string[]
  /** 已构造的浏览器，按顺序排列 */
  browsers: FakeBrowser[]
  /** 非空时 launch 先行等待该 promise，用于构造"冷启动期间"场景 */
  gate: Promise<void> | undefined
  /** connect 的行为，缺省为连接失败 */
  connectImpl: (endpoint: string) => Promise<BrowserLike>
}

/** 构造一套 launcher 替身 */
function rig(): Rig {
  const r: Rig = {
    launched: [],
    connected: [],
    browsers: [],
    gate: undefined,
    connectImpl: async () => {
      throw new Error("连接失败")
    },
    launcher: {
      launch: async spec => {
        r.launched.push(spec)
        if (r.gate) await r.gate
        const browser = fakeBrowser(`ws://fake/${r.browsers.length + 1}`)
        r.browsers.push(browser)
        return browser
      },
      connect: async endpoint => {
        r.connected.push(endpoint)
        return r.connectImpl(endpoint)
      }
    }
  }
  return r
}

/** 一份合法的启动参数 */
const SPEC: LaunchSpec = {
  executablePath: "/usr/bin/chromium",
  headless: "shell",
  args: ["--no-sandbox"],
  userDataDir: "/tmp/yzng-profile",
  timeout: 30_000
}

/**
 * 构造一份启动方案
 * @param over 需覆盖的字段
 * @returns 启动方案
 */
function plan(over: Partial<PoolPlan> = {}): PoolPlan {
  return { wsEndpoint: "", launch: SPEC, restartAfter: 0, ...over }
}

/**
 * 排空宏任务队列
 *
 * 页面池中存在两处刻意的 fire-and-forget（断开时清除 KV 地址），断言其效果须先令
 * 相关 promise 执行完毕。
 * @returns 队列排空后兑现
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

describe("BrowserPool", () => {
  let r: Rig
  let kv: KvNamespace

  beforeEach(() => {
    r = rig()
    kv = new Kv(new MemoryKvDriver())
  })

  /** 构造一个页面池；缺省两个页面许可，便于观察并发 */
  const make = (over: Partial<PoolPlan> = {}, pages = 2): BrowserPool =>
    new BrowserPool({ launcher: r.launcher, plan: () => plan(over), kv, logger: fakeLogger(), pages })

  it("首次实际渲染时方启动浏览器，地址随即记入 KV", async () => {
    const pool = make()

    // available 不得启动浏览器：内核会周期性调用该方法以决定是否回落
    expect(pool.available()).toBe(true)
    expect(pool.alive).toBe(false)
    expect(r.launched).toHaveLength(0)

    await pool.withPage(async () => undefined)

    expect(r.launched).toEqual([SPEC])
    expect(pool.alive).toBe(true)
    expect(pool.renders).toBe(1)
    // 地址存于本地 KV，不占用 Redis；进程下次被强制终止后可凭此接管孤儿进程
    expect(await kv.get<string>(ENDPOINT_KEY)).toBe("ws://fake/1")

    await pool.dispose()
  })

  it("冷启动期间并发到达的渲染共同等待同一次启动", async () => {
    let open!: () => void
    r.gate = new Promise<void>(resolve => {
      open = resolve
    })
    const pool = make({}, 4)

    const a = pool.withPage(async () => "a")
    const b = pool.withPage(async () => "b")
    await flush()

    // 冷启动期间到达的渲染必须一并等待这一次启动，而不是被拒
    expect(r.launched).toHaveLength(1)

    open()

    expect(await Promise.all([a, b])).toEqual(["a", "b"])
    expect(r.browsers).toHaveLength(1)

    await pool.dispose()
  })

  it("页面并发达到上限后排队，且排队数可观测", async () => {
    const pool = make({}, 1)
    expect(pool.limit).toBe(1)

    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })

    const first = pool.withPage(async () => {
      await held
    })
    const second = pool.withPage(async () => undefined)
    await flush()

    // 内核的 RenderRegistry 明确不限制并发（其无从得知页面池容量），闸门只能置于此侧
    expect(pool.pending).toBe(1)

    release()
    await Promise.all([first, second])

    expect(pool.pending).toBe(0)
    // 已取用的页面不得残留，遗漏一个即构成泄漏
    expect(r.browsers[0]?.pages.every(page => page.closed)).toBe(true)

    await pool.dispose()
  })

  it("任务抛错时亦须关闭页面，错误原样抛给调用方", async () => {
    const pool = make()

    await expect(
      pool.withPage(async () => {
        throw new Error("模板渲染失败")
      })
    ).rejects.toThrow("模板渲染失败")

    const browser = r.browsers[0]
    expect(browser?.pages).toHaveLength(1)
    expect(browser?.pages[0]?.closed).toBe(true)

    await pool.dispose()
  })

  it("渲染达到阈值后重启浏览器，计数重新开始", async () => {
    const pool = make({ restartAfter: 2 }, 1)

    await pool.withPage(async () => undefined)
    await pool.withPage(async () => undefined)
    expect(pool.renders).toBe(2)
    expect(r.launched).toHaveLength(1)

    await pool.withPage(async () => undefined)

    expect(r.launched).toHaveLength(2)
    expect(r.browsers[0]?.closes).toBe(1)
    // 该次渲染已在新浏览器上执行
    expect(pool.renders).toBe(1)

    await pool.dispose()
  })

  it("存在其他正在执行的渲染时不重启 —— 否则将关闭正在使用的浏览器", async () => {
    const pool = make({ restartAfter: 1 }, 2)
    await pool.withPage(async () => undefined)

    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const a = pool.withPage(async () => {
      await held
    })
    const b = pool.withPage(async () => {
      await held
    })
    await flush()

    // 二者均观测到 active === 2，故均不执行回收
    expect(r.launched).toHaveLength(1)
    expect(r.browsers[0]?.closes).toBe(0)

    release()
    await Promise.all([a, b])

    await pool.dispose()
  })

  it("断开后不立即重启，待下一次渲染时启动，并一并清除失效地址", async () => {
    const pool = make()
    await pool.withPage(async () => undefined)
    expect(await kv.get<string>(ENDPOINT_KEY)).toBe("ws://fake/1")

    r.browsers[0]?.fire()
    await flush()

    expect(pool.alive).toBe(false)
    // 保留该地址只会使下次启动多作一次无效重连
    expect(await kv.get<string>(ENDPOINT_KEY)).toBeUndefined()
    // 断开后不立即重启：每日仅出图一次的实例不应为此常驻一个 Chromium 进程
    expect(r.launched).toHaveLength(1)

    await pool.withPage(async () => undefined)

    expect(r.launched).toHaveLength(2)
    expect(pool.alive).toBe(true)

    await pool.dispose()
  })

  it("可接管上次残留的浏览器，且该来源应 close 而非 disconnect", async () => {
    await kv.set(ENDPOINT_KEY, "ws://orphan")
    r.connectImpl = async endpoint => {
      const browser = fakeBrowser(endpoint)
      r.browsers.push(browser)
      return browser
    }

    const pool = make()
    await pool.withPage(async () => undefined)

    expect(r.connected).toEqual(["ws://orphan"])
    expect(r.launched).toHaveLength(0)

    await pool.dispose()

    // 该进程为无人管理的孤儿进程，接管后即应由本插件负责关闭
    expect(r.browsers[0]?.closes).toBe(1)
    expect(r.browsers[0]?.disconnects).toBe(0)
  })

  it("残留地址连接失败时将其删除，转为自行启动", async () => {
    await kv.set(ENDPOINT_KEY, "ws://dead")
    const pool = make()

    await pool.withPage(async () => undefined)

    expect(r.connected).toEqual(["ws://dead"])
    expect(r.launched).toHaveLength(1)
    // 旧地址被新启动的地址替换，而非持续保留导致每次均作一次无效尝试
    expect(await kv.get<string>(ENDPOINT_KEY)).toBe("ws://fake/1")

    await pool.dispose()
  })

  it("配置外部地址后仅连接而不启动，停机时仅断开连接", async () => {
    r.connectImpl = async endpoint => {
      const browser = fakeBrowser(endpoint)
      r.browsers.push(browser)
      return browser
    }
    await kv.set(ENDPOINT_KEY, "ws://mine")
    const pool = make({ wsEndpoint: "  ws://ext:9222  " })

    await pool.withPage(async () => undefined)

    expect(r.connected).toEqual(["ws://ext:9222"])
    expect(r.launched).toHaveLength(0)

    await pool.dispose()

    // 该浏览器由他方管理，关闭它属于越权 —— 判据是连接方式，不能靠 isConnected 推断
    expect(r.browsers[0]?.disconnects).toBe(1)
    expect(r.browsers[0]?.closes).toBe(0)
    // 该地址记录的是本插件自行启动过的浏览器，与外部地址无关，不应被一并删除
    expect(await kv.get<string>(ENDPOINT_KEY)).toBe("ws://mine")
  })

  it("invalidate 废弃当前浏览器，下一次渲染以新配置重启", async () => {
    const pool = make()
    await pool.withPage(async () => undefined)

    await pool.invalidate()

    expect(pool.alive).toBe(false)
    expect(r.browsers[0]?.closes).toBe(1)
    // 不影响后续渲染：此为"变更 Chromium 路径"时的应有行为
    expect(pool.available()).toBe(true)

    await pool.withPage(async () => undefined)
    expect(r.launched).toHaveLength(2)

    await pool.dispose()
  })

  it("dispose 重复调用仅关闭一次，此后不再执行渲染", async () => {
    const pool = make()
    await pool.withPage(async () => undefined)

    // 内核 RenderRegistry 注销时亦会调用 dispose，重复调用必须无副作用
    await pool.dispose()
    await pool.dispose()

    expect(r.browsers[0]?.closes).toBe(1)
    expect(pool.alive).toBe(false)
    expect(pool.available()).toBe(false)
    await expect(pool.withPage(async () => undefined)).rejects.toThrow("已停止")
    expect(r.launched).toHaveLength(1)
  })

  it("available：未探测到浏览器且未配置地址即为不可用，空白地址不视为已配置", () => {
    expect(make({ launch: undefined }).available()).toBe(false)
    expect(make({ launch: undefined, wsEndpoint: "ws://x:9222" }).available()).toBe(true)
    expect(make({ launch: undefined, wsEndpoint: "   " }).available()).toBe(false)
  })

  it("两条路径均不可用时渲染直接抛错，且不尝试启动", async () => {
    const pool = make({ launch: undefined })

    await expect(pool.withPage(async () => undefined)).rejects.toThrow(/无可用的浏览器/)
    expect(r.launched).toHaveLength(0)
  })

  it("未指定页面上限时按机器规格推断，且不小于 1", () => {
    const pool = make({}, 0)
    expect(pool.limit).toBeGreaterThanOrEqual(1)
  })
})
