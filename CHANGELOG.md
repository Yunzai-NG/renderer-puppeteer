# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.3.0 — 2026-09-14

> **BREAKING CHANGE**：要求 `core >=0.6.0`（用到了那一版新增的 `s.object().deprecated()`）。

### 修复

- **启动时不再为一个从未存在过的配置项 `headless` 报「无法识别的配置项」。**

  本插件的 schema 里从来没有这个键，理由写在 `config.ts`：下载的是 `chrome-headless-shell`，
  它只能无头运行，给一个必然失败的开关比不给更坏。但早期手写过配置的实例，yaml 里留着那一行，
  于是每次启动都要看一句告警 —— 而内核对未知键的处置（warn 并原样保留）本身是对的，它照顾的是
  拼错的键与来自暂时卸载的插件的键。

  现在用 core 0.6.0 的 `deprecated("headless")` 把它登记为废弃键：静默丢弃，既不告警也不落盘。
  使用者不必手工去删那一行。

### 变更

- **peer 抬到 `core >=0.6.0`。** `deprecated()` 在更早的内核上不存在，而 schema 是模块加载期
  构造的 —— 装在老内核上会直接 TypeError，表现为插件压根装不上，而错误信息指向 `config.ts`。
- 删掉 `browser.ts`、`chromium.ts`、`tailwind.ts`、`template.ts` 文件头里重复论证同一判据的段落。
  保留判据本身：构建号必须与 puppeteer-core 同步、`ownRequire` 的解析起点必须是渲染器自身、
  ARM64 与 Termux 回落系统 chromium 的例外。

100 条用例，无变化。

## 0.2.0 — 2026-08-30

> **BREAKING CHANGE**：不再兼容 `@yunzai-ng/types` 0.1.x。

### 变更

- **peer 的 types 下限抬到 0.2.0。** `RenderRequest.tailwind` 由内核那侧的「模板可声明是否使用
  Tailwind 工具类」加入，而它落在 types 0.1.1 发布**之后**，那次没抬版本号。于是本插件声明
  `>=0.1.0` 却用着 0.1.1 里不存在的字段：装了 npm 上那份 types 的实例，编译时报
  `RenderRequest 上不存在属性 tailwind`，而报错指向本插件自己的 `provider.ts`，看不出真实原因是
  「装到的 types 太旧」。core 一并抬到 `>=0.2.0`：本插件用的 `ctx.http` 随卸载中止那套行为也自
  那一版起。
- **`tailwind` 配置的缺省值由 `true` 改为 `false`**，语义变为纯 opt-in。此前未声明的插件也会走
  一次编译，于是每渲染一张图都在日志里留一句 `Cannot find module 'tailwindcss'` —— 而那个包对它
  毫无意义：插件自己用 art-template 编好 HTML 交给 `ctx.render`，模板里一个工具类都没有。现在
  插件在 `defineTemplate()` 的第三参里声明 `tailwind: true` 才编译，既不必装 `tailwindcss`，也
  不会看到与它无关的告警。配置项保留，供「自己写模板又不想逐个声明」的人打开。
- 补 `config.test.ts` 把上述缺省值钉住。它是行为契约而非实现细节，翻回 `true` 的代价是每个不用
  工具类的插件重新开始刷告警。
- README 补一句：经市场安装时 `build` 与 `install:browser` 现由内核代跑，无须手工执行。

### 修复

- **peer 范围 `^0.1.0` 不可满足。** 它按 semver 等于 `>=0.1.0 <0.2.0`，把当时的内核 0.2.0 排除
  在外，本插件在其上装不了。改为 `>=`。

## 0.1.0 — 2026-08-29

art-template 编译 HTML，交由 Chromium 截图出图，兼容旧 Yunzai 的 HTML 模板写法。

浏览器由 `pnpm run install:browser` 显式下载（未挂在 postinstall 上），装的是
`chrome-headless-shell`，版本固定为 `package.json` 的 `yunzai.browserBuildId`。不探测系统上的
Edge 与 Chrome：系统浏览器的版本随机器漂移，而 `puppeteer-core` 只与一个固定构建配套。

`browser.ts` 与 `screenshot.ts` 刻意不 import puppeteer，故页面池调度与截图选项在没装浏览器的
机器上也受测。100 条用例。
