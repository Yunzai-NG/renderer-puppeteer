/**
 * 模块职责：art-template 编译层的测试 —— 承载本阶段的验收标准"旧 miao 模板可直接出图"
 * 依赖方向：测试文件，依赖 template.ts 与内核 testing 包
 * 生命周期：每个用例使用一套临时模板目录，afterEach 完整删除
 * 注意事项：主用例刻意照录 miao-plugin `user/uid-list.html` 的真实写法：
 *          `{{extend elemLayout}}`（布局为数据中给出的绝对路径）、`{{block}}`、
 *          `{{ set ... }}`、`{{each}}`、可选链、三元表达式、相对路径 `{{include}}`。
 *          上述语法须一并通过，方可认定"旧模板无需修改"。
 *
 *          缓存用例断言 `stats` 的**具体数值**而非"大于 0"：一次重复渲染应恰好
 *          命中三次（主模板、布局、include），少一次即意味着子模板仍在每次渲染时
 *          重新编译。
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { RenderRequest, RuntimePaths } from "@yunzai-ng/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TemplateEngine, injectBase, prepareData } from "./template.js"

/** 构造一份目录布局 */
function fakePaths(home: string): RuntimePaths {
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

/** 目录的 file URL（带尾斜杠），与 template.ts 内部算法一致 */
function dirUrl(dir: string): string {
  const href = pathToFileURL(dir).href
  return href.endsWith("/") ? href : `${href}/`
}

/** 写入文件，并一并创建目录 */
async function put(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
}

/** 布局模板，结构与 miao-plugin 的 `common/layout/elem.html` 同形 */
const LAYOUT = `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" type="text/css" href="{{_res_path}}common/common.css"/>
    {{block 'css'}}{{/block}}
  </head>
  <body class="body_box" {{sys.scale}}>
    <div class="container" id="container">
      {{block 'main'}}{{/block}}
      <div class="copyright">Created By {{_plugin}}</div>
    </div>
  </body>
</html>
`

/** 被 include 的片段 */
const TIPS = `<ul class="tips"><li>原神及通用命令以#开头</li></ul>
`

/** 主模板，语法逐条对应 miao-plugin 的 user/uid-list.html */
const PAGE = `{{extend elemLayout}}

{{block 'css'}}
<link rel="stylesheet" type="text/css" href="{{_res_path}}html/user/uid-list.css"/>
{{/block}}

{{block 'main'}}
{{ set gameMap = {
gs: { mark: '#' },
sr: { mark: '*' }
}; }}
{{include './tips.html'}}
<div class="uid-list">
  {{each uids game}}
  {{set mark = gameMap[game.key]?.mark}}
  <div class="game-title">{{mark}}{{game.name}}</div>
  {{if game.uidList?.length > 0}}
  {{each game.uidList uid idx}}
  <div class="game-li {{game.uid*1 === uid.uid*1 ? 'active' : ''}}">{{idx+1}} {{uid.uid}}</div>
  {{/each}}
  {{else}}
  <div class="no-uid">暂无uid</div>
  {{/if}}
  {{/each}}
</div>
{{/block}}
`

describe("injectBase", () => {
  const base = "file:///c:/tpl/user/"

  it("注入于 <head> 之后", () => {
    const out = injectBase("<html><head><title>x</title></head><body></body></html>", base)
    expect(out).toBe(`<html><head><base href="${base}"><title>x</title></head><body></body></html>`)
  })

  it("模板自行书写 <base> 时不作改动", () => {
    const html = `<html><head><base href="file:///other/"></head></html>`
    expect(injectBase(html, base)).toBe(html)
  })

  it("仅存在 <html> 时补充一个 <head>", () => {
    const out = injectBase("<html><body>x</body></html>", base)
    expect(out).toBe(`<html><head><base href="${base}"></head><body>x</body></html>`)
  })

  it("不含 <html> 的片段则置于最前", () => {
    // 模板输出片段而非整页属合法用法，此时浏览器会自动补充 head，base 仍然生效
    expect(injectBase("<div>x</div>", base)).toBe(`<base href="${base}"><div>x</div>`)
  })

  it("大写标签同样被识别", () => {
    expect(injectBase("<HTML><HEAD></HEAD></HTML>", base)).toContain(`<HEAD><base href="${base}">`)
  })

  it("注释中的 base 示例不得使注入被跳过", () => {
    // art-template 将 HTML 注释一并编译进输出。曾因 head 片段的注释中写有一个 base
    // 示例，使真正的注入被跳过，浏览器转而采用该示例地址，全部模板样式静默失效
    const html = `<html><head><!-- 渲染器会注入 <base href="file:///x/"> --><title>t</title></head></html>`
    const out = injectBase(html, base)

    expect(out).toContain(`<head><base href="${base}">`)
    // 注释本身原样保留：它是文档，不应被渲染器改写
    expect(out).toContain("渲染器会注入")
  })

  it("注释中的 head 字样不得被当作插入点", () => {
    const html = `<!-- 本片段提供 <head> 内容 --><html><head><title>t</title></head></html>`
    const out = injectBase(html, base)

    expect(out).toContain(`<head><base href="${base}"><title>t</title>`)
    expect(out.startsWith("<!-- 本片段提供 <head> 内容 -->")).toBe(true)
  })
})

describe("prepareData", () => {
  const req: RenderRequest = {
    template: "player/index",
    data: {},
    templateRoot: join(tmpdir(), "tpl"),
    resourceRoot: join(tmpdir(), "res"),
    origin: "demo"
  }

  it("资源根以带尾斜杠的 file URL 给出，并补齐旧模板的三个别名", () => {
    const data = prepareData(req, { keepHtml: false, scale: 1 })
    const res = dirUrl(req.resourceRoot)

    // 尾斜杠并非装饰：缺失时模板中的 {{res}}img/x.png 将解析至上一级目录
    expect(res.endsWith("/")).toBe(true)
    expect(data["res"]).toBe(res)
    // 旧 miao 模板识别此三者，缺少任一即须修改模板
    expect(data["_res_path"]).toBe(res)
    expect(data["pluResPath"]).toBe(res)
    expect(data["resPath"]).toBe(res)
    expect(data["_plugin"]).toBe("demo")
    expect(data["_tpl_path"]).toBe(dirUrl(req.templateRoot))
  })

  it("调用方提供的同名字段优先，缺省值仅作回落", () => {
    const data = prepareData({ ...req, data: { res: "https://cdn.example/", extra: 1 } }, { keepHtml: false, scale: 1 })

    expect(data["res"]).toBe("https://cdn.example/")
    expect(data["extra"]).toBe(1)
  })

  it("sys 为合并而非覆盖", () => {
    const data = prepareData({ ...req, data: { sys: { copyright: "x" } } }, { keepHtml: false, scale: 1 })

    // 模板普遍读取 sys.scale，而调用方通常仅需追加 copyright；
    // 直接覆盖将使 {{sys.scale}} 渲染为 undefined
    expect(data["sys"]).toEqual({ scale: 1, copyright: "x" })
  })

  it("调用方显式提供 sys.scale 时以其为准", () => {
    const data = prepareData({ ...req, data: { sys: { scale: 2 } } }, { keepHtml: false, scale: 1 })
    expect(data["sys"]).toEqual({ scale: 2 })
  })

  it("sys 被写为非对象时予以忽略，避免整次渲染失败", () => {
    const data = prepareData({ ...req, data: { sys: "oops" } }, { keepHtml: false, scale: 1 })
    expect(data["sys"]).toEqual({ scale: 1 })
  })
})

describe("TemplateEngine", () => {
  let root: string
  let paths: RuntimePaths
  let templateRoot: string
  let resourceRoot: string
  let engine: TemplateEngine

  /** 两个游戏：原神含两个 uid（首个为当前使用），星穹铁道无 uid */
  const UIDS = [
    { key: "gs", name: "原神", uid: "100000001", uidList: [{ uid: "100000001" }, { uid: "100000002" }] },
    { key: "sr", name: "星穹铁道", uidList: [] }
  ]

  /** 构造一份指向临时模板树的渲染请求 */
  const request = (over: Partial<RenderRequest> = {}): RenderRequest => ({
    template: "user/uid-list",
    data: { elemLayout: join(templateRoot, "layout", "default.html"), uids: UIDS },
    templateRoot,
    resourceRoot,
    origin: "demo",
    ...over
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "yzng-tpl-"))
    paths = fakePaths(root)
    resourceRoot = join(root, "resources")
    templateRoot = join(resourceRoot, "html")

    await put(join(templateRoot, "layout", "default.html"), LAYOUT)
    await put(join(templateRoot, "user", "tips.html"), TIPS)
    await put(join(templateRoot, "user", "uid-list.html"), PAGE)

    engine = new TemplateEngine({ max: 32, paths, logger: fakeLogger() })
  })

  afterEach(async () => {
    engine.clear()
    await rm(root, { recursive: true, force: true })
  })

  it("旧 miao 模板原样渲染：extend / block / set / each / 可选链 / include 全部生效", async () => {
    const prepared = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    const html = await readFile(prepared.file, "utf8")

    // 布局来自 {{extend elemLayout}}，而 elemLayout 为数据中的绝对路径 ——
    // 旧模板即为此写法，绝对路径必须原样通行
    expect(html).toContain('id="container"')
    // {{block 'css'}} 的内容被注入布局的 head
    expect(html).toContain("html/user/uid-list.css")
    // {{ set gameMap }} + {{each}} + gameMap[game.key]?.mark
    expect(html).toContain("#原神")
    expect(html).toContain("*星穹铁道")
    // {{each ... uid idx}} 与三元表达式
    expect(html).toContain(">1 100000001<")
    expect(html).toContain(">2 100000002<")
    expect(html).toContain('class="game-li active"')
    // uidList 为空时进入 {{else}} 分支
    expect(html).toContain("暂无uid")
    // 相对路径 {{include './tips.html'}}
    expect(html).toContain("原神及通用命令以#开头")

    await prepared.cleanup()
  })

  it("注入的 base 指向主模板所在目录，资源变量替换为资源根的 file URL", async () => {
    const prepared = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    const html = await readFile(prepared.file, "utf8")

    // 中间 HTML 位于临时目录，缺少 base 时模板中的 ./style.css 必然 404，
    // 表现为白屏；靠计算 `../` 层数规避则模板目录层级一变就再次失效
    expect(html).toContain(`<base href="${dirUrl(join(templateRoot, "user"))}">`)
    expect(html).toContain(`${dirUrl(resourceRoot)}html/user/uid-list.css`)
    expect(html).toContain(`${dirUrl(resourceRoot)}common/common.css`)

    await prepared.cleanup()
  })

  it("主模板、布局、include 三份编译结果均进入缓存，第二次渲染全部命中", async () => {
    const first = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    await first.cleanup()

    expect(engine.stats.size).toBe(3)
    expect(engine.stats.misses).toBe(3)
    expect(engine.stats.hits).toBe(0)

    const second = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    await second.cleanup()

    // 命中三次而非一次：主模板、布局、include 各一次。
    // 少一次即意味着 include/extend 的某一层仍在每次渲染时重新读盘与解析
    expect(engine.stats.hits).toBe(3)
    expect(engine.stats.misses).toBe(3)
  })

  it("模板文件变更后即重新编译，无需任何文件监听器", async () => {
    const first = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    expect(await readFile(first.file, "utf8")).toContain("原神及通用命令以#开头")
    await first.cleanup()

    const tips = join(templateRoot, "user", "tips.html")
    await put(tips, `<ul class="tips"><li>修改后的提示</li></ul>\n`)
    // 显式将 mtime 推后：同一毫秒内改写会使 mtime 保持不变，该问题属于测试的时序问题，
    // 而非被测逻辑的缺陷
    const later = new Date(Date.now() + 2000)
    await utimes(tips, later, later)

    const second = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    const html = await readFile(second.file, "utf8")
    await second.cleanup()

    expect(html).toContain("修改后的提示")
    expect(html).not.toContain("原神及通用命令以#开头")
  })

  it("缓存条数设有上限，模板数量增加时缓存规模不超过该上限", async () => {
    const small = new TemplateEngine({ max: 2, paths, logger: fakeLogger() })
    for (const name of ["a", "b", "c", "d"]) {
      await put(join(templateRoot, "plain", `${name}.html`), `<div id="container">${name}</div>`)
      const prepared = await small.prepare(request({ template: `plain/${name}` }), { keepHtml: false, scale: 1 })
      await prepared.cleanup()
    }

    // 缓存必须有上限，否则模板数量增加后内存只升不降
    expect(small.stats.max).toBe(2)
    expect(small.stats.size).toBe(2)
    small.clear()
    expect(small.stats.size).toBe(0)
  })

  it("模板标识未书写扩展名时补充 .html，已书写扩展名者与绝对路径均原样通行", () => {
    const page = join(templateRoot, "user", "uid-list.html")

    expect(engine.resolveTemplate(request())).toBe(page)
    expect(engine.resolveTemplate(request({ template: "user/uid-list.html" }))).toBe(page)
    // 绝对路径必须通行：旧 miao 模板的 defaultLayout / elemLayout 即为绝对路径
    const layout = join(templateRoot, "layout", "default.html")
    expect(engine.resolveTemplate(request({ template: layout }))).toBe(layout)
  })

  it("缺省于渲染完成后删除，且两次渲染各自使用独立的文件名", async () => {
    const a = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    const b = await engine.prepare(request(), { keepHtml: false, scale: 1 })

    // 文件名相同将使两名同时查询同一模板的使用者相互截取到对方的图片
    expect(a.file).not.toBe(b.file)
    expect(existsSync(a.file)).toBe(true)
    expect(existsSync(b.file)).toBe(true)
    expect(a.url).toBe(pathToFileURL(a.file).href)

    await a.cleanup()
    await b.cleanup()

    // 中间 HTML 由 cleanup 即时删除，不依赖任何定期清理器
    expect(existsSync(a.file)).toBe(false)
    expect(existsSync(b.file)).toBe(false)
  })

  it("keepHtml 启用时文件名固定、渲染完成后保留 —— 反复覆盖同一文件，天然有界", async () => {
    const first = await engine.prepare(request(), { keepHtml: true, scale: 1 })
    await first.cleanup()
    expect(existsSync(first.file)).toBe(true)

    const second = await engine.prepare(request(), { keepHtml: true, scale: 1 })
    await second.cleanup()

    expect(second.file).toBe(first.file)
    expect(existsSync(second.file)).toBe(true)
  })

  it("中间 HTML 位于 temp/render/<来源> 之下，来源中的路径符号被规约", async () => {
    const normal = await engine.prepare(request(), { keepHtml: false, scale: 1 })
    expect(dirname(normal.file)).toBe(join(paths.temp, "render", "demo"))
    await normal.cleanup()

    // origin 取自插件名称，而插件名称为配置中的字符串：不得允许 "../" 将文件写至 temp 之外
    const evil = await engine.prepare(request({ origin: "../evil" }), { keepHtml: false, scale: 1 })
    expect(dirname(evil.file)).toBe(join(paths.temp, "render", "_evil"))
    expect(evil.file.startsWith(join(paths.temp, "render") + sep)).toBe(true)
    await evil.cleanup()
  })

  it("模板不存在时直接抛错，而非输出一张内容为错误信息的图片", async () => {
    // art-template 缺省会将错误渲染至输出；此处依靠 bail:true 使其抛出，
    // 否则使用者收到的是一张"图片正常、内容为 {Template Error}"的图片
    await expect(engine.prepare(request({ template: "user/查无此模板" }), { keepHtml: false, scale: 1 })).rejects.toThrow()
  })
})

