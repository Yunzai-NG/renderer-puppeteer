/**
 * 模块职责：配置 schema 的测试 —— 只固定那些「改了会静默影响别人」的缺省值
 * 依赖方向：测试文件，依赖 config.ts
 * 生命周期：纯函数，无需夹具
 * 注意事项：**`tailwind` 缺省必须为 false，这一条只能由测试固定。** 它曾是 true，
 *          后果是任何插件（哪怕压根没用工具类、也没装 tailwindcss）每渲染一张图都会
 *          撞一次 `Cannot find module 'tailwindcss'` 告警 —— 报错里出现的还是**它自己**的
 *          模板目录，读起来像是它的问题。
 *
 *          改回 true 不会让任何现存用例失败（编译失败一律降级为不注入样式，图照出），
 *          所以这里必须有一条断言拦住它。
 */
import { describe, expect, it } from "vitest"
import { CONFIG_SCHEMA } from "./config.js"

/** schema 的字段描述表 */
const fields = CONFIG_SCHEMA.describe().properties ?? {}

describe("配置 schema", () => {
  it("tailwind 缺省关闭：插件未声明即不编译，不去碰 tailwindcss", () => {
    expect(fields["tailwind"]?.default).toBe(false)
  })

  it("解析一份空配置即得到全部缺省值，其中 tailwind 为 false", () => {
    // 走 parse 而非只看 describe：面板读的是 describe，而运行期读的是 parse 的产物，
    // 两者若分叉，界面显示「关闭」而实际仍在编译
    expect(CONFIG_SCHEMA.parse({}).tailwind).toBe(false)
  })

  it("tailwindEntry 缺省为 tailwind.css，与 template.ts 内的同名缺省一致", () => {
    expect(fields["tailwindEntry"]?.default).toBe("tailwind.css")
  })
})
