# @replication/workflow 0.1.0

项目独立业务扩展，使用 Node.js 内置 API 与 ffprobe/ffmpeg。通过上游公开 CLI 编译、规划、执行与导出；不直接改 Hypit 内核。

- `plan.mjs`：要求、素材角色、时长、模式、范围、费用和版本核对，生成原生 H3 Run 与专用 Runtime。
- `policy.mjs`：实际 POST 前核对最终请求、素材字节和真实 `need.id` 来源；`operation` 是上游运行操作编号，单独记录。已验证真实 Worker，不能把 plan 的步骤编号当 operation。
- `ledger.mjs`：共享授权、原子写入、进程锁、未知提交占用及恢复。
- `review.mjs`：官方下载指纹、完成 Build 登记、逐项人工验收、证据失效和跨任务复用。
- `media.mjs`：完整视频分段；平台下载沿用上游。
- `cli.mjs`：业务命令入口，所有付费请求必须已有真实授权。

其他独立包：`@replication/h3-kits` 生成普通提示词；`@replication/scenes` 生成原生媒体、字幕和音频轨。无额外收费 LLM、TTS 或 IR 服务。

[使用说明](../../docs/复刻优化使用说明.md)；测试入口 `./bin/test-replication`。测试只用合成媒体、模拟 HTTP 和本机 HTTP，不读真实 API 密钥，不上传 OSS，不证明真实模型质量。

核心约束：不删除账本、不释放未知支出、不覆盖同一个授权编号，不让缓存或局部成功成为整片通过；变更输出或证据后必须重新审阅。
