# Hypit Skill 安装与使用

Skill 是给 AI 的制作说明。完整安装需要技能、工具程序和用户自己的 API；只复制 SKILL.md 不够。

## 零基础用户：推荐这样做

1. 从[本项目完整工具包下载页](https://github.com/ymh3753201/hypit-replication-toolkit/releases/latest)下载用户工具包 ZIP，完整解压。
2. 在能操作文件和终端的 Codex 或 Claude Code 中打开工具包根目录，把 `一键安装提示词.md` 发给 AI。
3. AI 先安装／检查完整技能，再补齐程序依赖、配置 API 和检查本地渲染。官方 H3 默认无需 OSS。
4. 技能文件已就绪后，在下一轮选择 hypit。Codex 可输入 `$hypit`，Claude Code 可输入 `/hypit`；不识别时重新打开项目，让 AI 确认来源路径。

新手不用另找 Skill、复制隐藏目录或安装全局其他版本。

## 已配套哪些文件

- `.agents/skills/hypit/SKILL.md`：Codex 项目技能入口。
- `.claude/skills/hypit/SKILL.md`：Claude Code 项目技能入口。
- 两个技能目录均包含全部 73 个文件，其中包括 references/ 的创作、模型配置、制作、审阅、示例等资料；文件与完整配套 Skill 一致。
- `docs/hypit-skill-files.json`：完整技能的文件指纹清单。
- `scripts/install-skills.py`：仅用 Python 标准库安装／检查技能，无模型调用，不修改全局技能；不同旧版本保存在 `.skill-backups`。
- `AGENTS.md`、`CLAUDE.md`：提醒 AI 使用本工具的模型、入口、费用保护与验收规则。

完整包另有 `hypit/skills/hypit/` 原始技能副本；不要修改 Skill 原文来替代项目规则。

## AI 执行的免费命令

在完整工具包根目录执行：

```sh
python3 scripts/install-skills.py
python3 scripts/install-skills.py --check
```

按平台单独检查可加 `--agent codex` 或 `--agent claude-code`。默认 `scripts/install.sh` 会先检查／安装技能，再安装程序依赖。

报告必须区分：技能文件齐全、AI 实际读过技能、当前会话可选择技能、工具入口可用、API 已配置、真实出片验收。文件存在不能当作加载成功；免费测试不能当作付费模型或人物/声音/口型验收。

## 只安装技能的用户

公开仓库已经直接包含完整 `.agents/skills/hypit/` 和 `.claude/skills/hypit/`，可以克隆本仓库并执行上述技能安装命令；这只取得技能与指南。执行引擎、二开源码和环境安装脚本在完整 ZIP 中，制作视频仍需使用完整工具包。

也可以把本项目地址发给 AI，让它将完整 hypit 文件夹放入你的实际项目技能目录，保留所有参考文件。不要只粘贴 SKILL.md。不建议本课程默认全局安装，避免调用已有的同名其他版本。

## 第一次制作怎么说

```text
使用当前工具目录的 Hypit Skill。先读取 AGENTS.md、工具使用说明.md 和完整 SKILL.md，再按任务读取相关 references/；确认工具入口为本包 ./bin/hypit 和 ./bin/replicate。
参考视频：〔本地文件或链接〕；目标人物/商品图：〔文件〕；时长和画幅：〔填写〕；保留：〔填写〕；替换：〔填写〕；声音目标与台词：〔填写〕。
先免费分析、规划和检查，列出素材、模型调用次数与预计费用，等我给出预算和次数授权后才生成。完成后检查真实画面与声音并打开本次 Studio，不用静态贴图或旧作品冒充复刻完成。
```

使用已有全局同名技能时，AI 应核对本次实际加载来源；优先明确读取项目内完整技能和业务规则。若 UI 还未识别，可直接让 AI 读取项目技能与相关参考文件继续当前回合，并说明尚未验证自动加载。

路径依据（2026-10-03 核对）：[Codex 技能位置](https://learn.chatgpt.com/docs/build-skills)、[Claude Code 项目技能](https://code.claude.com/docs/en/skills)。
