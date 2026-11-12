# Hypit 复刻视频智能体工具包 0.1.5

本包配套 Hypit 0.3.2。完整解压后，在 Codex 或 Claude Code 打开本文件所在目录，把 给AI的安装指令.md 交给 AI，并按 安装部署操作指南.md 安装。

首次安装需要联网获取软件依赖。模型服务使用自己的 API，具体任务的预算与请求次数由用户提供。Codex 当前会话具有内置生图能力时，可以先生成参考图片再导入本任务。

文件版本见 DISTRIBUTION.json，文件核对使用 python3 scripts/verify-package.py，实际测试结果见 安装包验证报告.md。

旧版使用者先备份任务、结果、Runtime 和收费账本，再按引擎 migrations 目录的中文指南迁移需要继续编辑的作品。
