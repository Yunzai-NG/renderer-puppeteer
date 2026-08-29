/**
 * 模块职责：Tailwind 编译层的测试
 * 依赖方向：测试文件，依赖 tailwind.ts；`tailwindcss` 为本仓库的可选依赖，此处真实编译
 * 生命周期：每个用例自建临时目录存放入口 CSS，afterEach 清理
 * 注意事项：**「裸包名从渲染器自身解析」这一条必须由测试固定。** 该 bug 的形态是
 *          `tailwindcss` 明明已装，却每渲染一张图都报一次 `Cannot find module`——
 *          因为解析起点曾是发起插件的模板目录，而 Node 沿起点上溯永远走不到
 *          渲染器自己的 `node_modules`。用例以一个与本仓库毫无关系的临时目录作模板根，
 *          正是为复现那条路径：若解析起点退回 base，此处必然失败。
 *
 *          告警去重同样只能由测试固定：它的收益（日志不被淹没）在人工观察下才显现，
 *          而回归时无声无息。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeLogger } from "@yunzai-ng/core/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TailwindCompiler, extractCandidates } from "./tailwind.js"

/** 临时目录，充当发起插件的模板根 */
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "yzng-tw-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("extractCandidates", () => {
  it("只取 class 属性的值", () => {
    expect(extractCandidates(`<div class="flex gap-2"><p>flex</p></div>`)).toEqual(["flex", "gap-2"])
  })

  it("单引号与双引号同等对待", () => {
    expect(extractCandidates(`<i class='p-1'></i>`)).toEqual(["p-1"])
  })

  it("收集 var() 引用的主题变量", () => {
    // v4 的 @theme 变量只在被引用时才输出，故模板里直接写 var(--gold) 也须成为候选
    expect(extractCandidates(`<b style="color:var(--gold)"></b>`)).toEqual(["--gold"])
  })

  it("去重且排序，使缓存键与书写顺序无关", () => {
    expect(extractCandidates(`<a class="z-10 flex"></a><b class="flex"></b>`)).toEqual(["flex", "z-10"])
  })

  it("无 class 时给出空数组", () => {
    expect(extractCandidates(`<p>纯文本</p>`)).toEqual([])
  })
})

describe("TailwindCompiler", () => {
  it("从渲染器自身解析 tailwindcss，与模板根位置无关", async () => {
    // root 是 /tmp 下的临时目录，其上溯路径里没有任何 node_modules ——
    // 解析起点若退回这里，就会重现 `Cannot find module 'tailwindcss'`
    const logger = fakeLogger()
    const compiler = new TailwindCompiler({ logger })

    const out = await compiler.apply(`<html><head></head><body><div class="flex"></div></body></html>`, join(root, "tailwind.css"))

    expect(out).toContain("data-yunzai-tailwind")
    expect(out).toContain("display: flex")
    expect(logger.lines.filter(l => l.startsWith("warn"))).toEqual([])
  })

  it("入口 CSS 不存在时用内置的 @import \"tailwindcss\"", async () => {
    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    const out = await compiler.apply(`<div class="hidden"></div>`, join(root, "缺失.css"))
    expect(out).toContain("display: none")
  })

  it("采用插件提供的入口 CSS 定制主题", async () => {
    const entry = join(root, "tailwind.css")
    await writeFile(entry, '@import "tailwindcss";\n@theme { --color-brand: #123456; }', "utf8")

    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    const out = await compiler.apply(`<div class="text-brand"></div>`, entry)
    expect(out).toContain("#123456")
  })

  it("无候选时原样返回，不触碰 Tailwind", async () => {
    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    const html = `<p>没有任何 class</p>`
    expect(await compiler.apply(html, join(root, "tailwind.css"))).toBe(html)
  })

  it("同一候选集合第二次命中缓存", async () => {
    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    const html = `<div class="flex"></div>`
    const entry = join(root, "tailwind.css")

    await compiler.apply(html, entry)
    await compiler.apply(html, entry)

    expect(compiler.stats.hits).toBe(1)
  })

  it("编译失败只告警一次，重复失败降为 debug", async () => {
    const entry = join(root, "tailwind.css")
    // 指向一个不存在的包：loadStylesheet 两侧都解析不到，必然抛出
    await writeFile(entry, '@import "@yunzai-ng/根本没有这个包";', "utf8")

    const logger = fakeLogger()
    const compiler = new TailwindCompiler({ logger })
    const html = `<div class="flex"></div>`

    await compiler.apply(html, entry)
    await compiler.apply(html, entry)
    await compiler.apply(html, entry)

    // 三次渲染只有第一次告警 —— 原先每张图都报一次，日志会被彻底淹没
    expect(logger.lines.filter(l => l.startsWith("warn"))).toHaveLength(1)
    expect(logger.lines.filter(l => l.startsWith("debug") && l.includes("仍在失败"))).toHaveLength(2)
  })

  it("失败不影响出图：原样返回 HTML", async () => {
    const entry = join(root, "tailwind.css")
    await writeFile(entry, '@import "不存在的包";', "utf8")

    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    const html = `<div class="flex"></div>`
    expect(await compiler.apply(html, entry)).toBe(html)
  })

  it("clear() 释放缓存", async () => {
    const compiler = new TailwindCompiler({ logger: fakeLogger() })
    await compiler.apply(`<div class="flex"></div>`, join(root, "tailwind.css"))
    expect(compiler.stats.size).toBe(1)

    compiler.clear()
    expect(compiler.stats.size).toBe(0)
  })
})
