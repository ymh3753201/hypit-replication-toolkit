# 视频与图片模型 API 配置指南

日期：2026-10-03。推荐的是用户可选择的模型；是否可用取决于账号权限、服务商文档和实际连接。

## 1. 推荐选项与本包现状

| 用途 | 推荐模型 | 当前接入情况 |
|---|---|---|
| 参考视频复刻、人物表演、带声音视频 | MiniMax H3 | 包内官方适配器可用于受保护的 `replicate` 流程。仍需视频密钥、用户私有 OSS 和真实出片验收 |
| 按参考动作/镜头生成 | Seedance 2.0 | 包内有 Seedance 语法和原苍远 SD14 连接；需用户服务/密钥/OSS。SD14 为 720p，现有流程去掉模型音轨。SD12 暂停 |
| 较长叙事、多模态参考与视频编辑 | Seedance 2.5 | 运行引擎已有 2.5 模型语法；本包默认未启用 2.5 线路，`replicate` 不能直接执行。AI 按实际服务完成 Provider、规划与授权保护，验证后启用 |
| 人物、商品、场景参考图片 | Seedream 5.0 系列 | 推荐按账号提供的 5.0 pro / flash / lite 等实际型号选择。运行引擎有 Seedream 组件，但不能把旧线路视为已兼容新型号；AI 对照服务 API 验证或补充接入 |
| 图片生成与编辑 | GPT Image 2.5 | 推荐按实际可用 ID 选择，例如 `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare`。运行引擎有 GPT Image 组件；实际 2.5 请求字段、输出处理和服务绑定需核对 |
| 不另配图片 API | Codex 内置生图 | 官方账号登录且当前会话具备内置工具时直接生图；结果复制到本任务目录后使用。不能把 Codex 账号登录凭据转成 Hypit API 密钥 |

服务商可能使用与官方不同的模型 ID；让 AI 使用文档中的准确 ID。不要填写“GPT Image2.5”这类展示名称后就认定接口支持。

## 2. 安装之后还要发送什么给 AI

请告诉 AI：

```text
视频服务商：
视频 API 文档地址：
视频 API Base URL：
视频模型的准确 ID：
图片方式：Codex 内置生图 / 图片 API
图片 API 文档地址（API 方式）：
图片 API Base URL（API 方式）：
图片模型的准确 ID（API 方式）：
账号可用额度或计费说明：
密钥：通过本机安全配置交给 AI，不要放进公共报告。
```

**配置阶段只授权配置，不自动授权收费。** 真正制作另给预算、请求次数和范围。没有图片 API 也没有内置生图时，可以直接提供现成的人物/商品图片。

## 3. 默认官方 H3 的具体配置

`hypit/hypit.runtime.cangyuan.json` 中实际启用的是 `minimax.official`。它通过环境凭据存储读取 `MINIMAX_API_KEY`；本包 `bin/hypit` / `bin/replicate` 会安全加载用户自己的 `.env.local`。官方适配器只接受 `https://api.minimax.cn` 或 `https://api.minimax.io`，不能拿一个第三方中转地址直接替换官方地址。

当前官方模型 ID：`MiniMax-H3`。生成语法为 `h3:TextVideo`、`h3:FrameVideo` 或 `h3:ReferenceVideo`。正式调用由 `replicate prepare/check` 生成受保护的 Runtime，并在实际 POST 前核对模型、素材、次数和金额。

多媒体参考的上传依赖随包提供的 `hypit/packages/provider-cangyuan/runtime/oss_storage.py`，安装脚本配置 Python SDK。用户自己的 OSS 必填信息：`AI_DSP_OSS_ACCESS_KEY_ID`、`AI_DSP_OSS_ACCESS_KEY_SECRET`、`AI_DSP_OSS_BUCKET`、`AI_DSP_OSS_REGION`、`AI_DSP_OSS_ENDPOINT`。临时前缀和签名时间见 `.env.example`；生命周期由用户实际桶配置决定，变量本身不会创建删除规则。

AI 先用 doctor 只读核对；模型及 OSS 的实际费用另说明，不能为检测密钥而直接生成视频或上传素材。

## 4. Seedance 的配置边界

`config/hypit.runtime.seedance.example.json` 是占位示例，不能直接运行付费任务。苍远 Provider 要求其对应的 `/v1/videos` 异步接口契约；不是所有 OpenAI 风格的视频接口都可接到它上面。

用户选择其他服务或 Seedance 2.5 时，AI 先检查 `hypit/packages/seedance` 及供应商包，按 API 文档确定上传、字段、创建、查询、结果下载与收费保护。不得把 `sd14-seedance-2.0` 改成 `seedance-2.5` 就宣布升级完成。复刻业务规划器当前固定 H3，新的 Seedance 受保护入口需适配与免费测试；未完成时明确报告。

原 SD12 被暂停，不因为新用户安装就恢复。Seedance 2.5 不受原 SD14 的 15 秒/720p 限制表代表，必须按选择的真实服务核对。失败不能自动轮换付费模型。

## 5. 图片的两种正确用法

**Codex 内置生图方式：** 用户用官方账号，AI 确认当前会话存在内置生图工具后生成图片。保存到 `productions/<任务名>/`，再写入 task.json 的 `assets`。这条方式不需要 `IMAGE_API_KEY`，也不需要为 Hypit 配置 OpenAI API；账号用量及可用性仍按当前 Codex 提供的规则处理。若当前会话没有工具，说明情况，不擅自改成收费 API。

**图片 API 方式：** 用户提供 Seedream 或 GPT Image 的服务地址、准确模型 ID、API 文档和密钥。AI 核对实际 Provider 与字段，配置凭据引用和能力绑定；不支持时在独立扩展中补充连接，或用独立图片生成工具产出本地图片再导入。不能声称已填 `IMAGE_API_*` 就能让 Hypit 自动生图。

图片进入视频前检查人物和商品身份、比例、分辨率及格式。图片成功不等于视频成功；每段动态输出和最后全屏/小窗仍要检查。

## 6. AI 配置后的报告模板

```text
基础安装：通过 / 未通过（原因）
视频模型与服务：实际名称、ID、端点
视频 API：凭据已安全配置 / 缺失；免费检查结果
OSS：用户自有桶与私有访问检查结果；不显示密钥或签名链接
图片方式：内置生图可调用 / API 已连接 / 仍需适配
受保护复刻入口：可用模型、仍缺的功能
付费请求：本次 0 次；首次真实测试待用户给出预算和次数
真实画面、声音、口型验收：未执行 / 依据真实输出逐项报告
```

## 7. 官方资料

以下资料供 AI 安装时重新核对，不以文档日期固定将来的价格或账号权限。

- [Seedance 视频 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
- [Seedance 2.5 教程](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)
- [Seedream 图片 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)
- [GPT Image 2.5 图像 API 指南](https://developers.openai.com/api/docs/guides/image-generation)
- [MiniMax 官方平台](https://platform.minimax.cn/)
- [Codex 内置图片能力](https://learn.chatgpt.com/docs/image-generation)

官方接口与第三方平台可用性是两件事；以用户账号和所选平台的文档、实际测试为准。
