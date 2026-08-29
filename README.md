# renderer-puppeteer

Yunzai NG 的渲染器插件：art-template 编译 HTML，交由 Chromium 截图出图，兼容旧 Yunzai 的
HTML 模板写法。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `renderer-puppeteer` → 安装。

亦可手工克隆至主目录的 `plugins/` 下：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/renderer-puppeteer.git
cd renderer-puppeteer
pnpm install
pnpm run build
pnpm run install:browser
```

## 浏览器

本插件使用 `puppeteer-core`，需另行下载一份无头浏览器：

```powershell
pnpm run install:browser   # 约 100MB，装到主目录的 cache/puppeteer 下
pnpm run check:browser     # 只查看是否已装，不下载
```

下载的是 `chrome-headless-shell`（Chrome for Testing 的无头构建），体积不到完整 Chrome 的
一半。**不探测系统上的 Edge 与 Chrome**：系统浏览器的版本随机器漂移，而 `puppeteer-core`
只与一个固定构建配套，用系统浏览器出图时「某台机器上少一块背景」这类问题无从复现。构建号记在
`package.json` 的 `yunzai.browserBuildId`。

国内网络可先设镜像：

```powershell
$env:YZNG_CHROMIUM_MIRROR = "https://cdn.npmmirror.com/binaries/chrome-for-testing"
pnpm run install:browser
```

探测顺序为「配置中明确指定 → 环境变量（`YZNG_CHROMIUM_PATH`、`PUPPETEER_EXECUTABLE_PATH`、
`CHROME_PATH`、`CHROMIUM_PATH`）→ 已下载的固定构建 → 缓存中的其他构建」，来源越明确者优先。

**Linux ARM64 与 Termux 例外**：Chrome for Testing 不发布这两个平台的构建，需自行用包管理器
安装（`apt install chromium` / `pkg install chromium`），本插件会自动使用系统的那一份。

未探测到时本插件向内核报告不可用，内核回落至下一个渲染器；**缺少渲染器不会导致启动失败**，
仅调用 `ctx.render` 的命令会告知用户渲染不可用。

低内存设备（Termux、小内存 VPS）上占用内存的主体是 Chromium 而非内核，建议将 `pages` 设为 1、
`restartAfter` 调小（如 50）。

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\renderer-puppeteer
pnpm install
pnpm run link:framework # 在 node_modules/@yunzai-ng 下建立指向框架的链接
pnpm run verify         # build → typecheck:test → lint → test
```

`link:framework` 按 `YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng` → `../../yunzai-ng` →
`../../code` 的顺序查找框架仓库。目录布局与上述不同时设置该环境变量即可。

框架发布之后，`pnpm install` 即可满足依赖，该步骤不再必需。

## 许可

AGPL-3.0-or-later
