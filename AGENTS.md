# AI 漫剧工作室项目入口

本工作区用于AI漫剧工作室的故事、图片资产、即梦视频提示词及工作室制作交接。用户本轮目标、明确授权和停止点优先；不要因为流程完整就执行尚未要求的生成、上传、剪辑或发布。

## 开始工作

1. 实际读取 [工作室执行规则](studio/docs/工作室执行规则.md)。来源、采用、任务进度与操作证据沿用 [AI执行规范](studio/docs/AI执行规范.md)。
2. 确认工作区根 `projects/` 内的实际项目目录。共享资料在 `studio/`，历史只读资料在 `archive/`；续做先用 `node studio/bin/studio.mjs status --project <项目目录> --json`，再读取采用指针对应的冻结快照；工作稿标题、聊天记忆、批次清单不能取代采用基准。
3. 选择本轮入口并实际读取需要的手册；只加载当前分支。技能可自动匹配，但文件存在、出现技能名不等于已经执行。

## 九个项目入口

| 本轮任务 | 入口 |
| --- | --- |
| 跨阶段制作、选择下一步 | [comic-studio](.agents/skills/comic-studio/SKILL.md) |
| GPT 人物、场景、道具、首帧与图片编辑 | [comic-image-assets](.agents/skills/comic-image-assets/SKILL.md) |
| 即梦 2.0／2.5 分镜、运镜与视频提示词 | [jimeng-video-prompts](.agents/skills/jimeng-video-prompts/SKILL.md) |
| 图片、视频、声音检查与返修交接 | [comic-media-review](.agents/skills/comic-media-review/SKILL.md) |
| 制片排期、成本及尝试预算 | [comic-production](.agents/skills/comic-production/SKILL.md) |
| 声音导演、配音与声音素材制作 | [comic-audio](.agents/skills/comic-audio/SKILL.md) |
| 剪映专业版后期与成片交付 | [comic-capcut-post](.agents/skills/comic-capcut-post/SKILL.md) |
| 素材来源与发布前检查 | [comic-rights-release](.agents/skills/comic-rights-release/SKILL.md) |
| 生产及发行复盘 | [comic-production-retro](.agents/skills/comic-production-retro/SKILL.md) |

## 保存与完成

新增、修改、审核、采用和交接遵循已有 [数据协议](studio/docs/数据协议.md) 与 [接口规范](studio/docs/接口规范.md)。正式采用绑定精确审核编号，正式导出启用现有章节审核约束；它们不能证明影片已看完或声音已听检。

按用户授权完成实际成果，报告文件位置、当前采用基准、已查与未查范围及具体下一步。并行制作先声明写入范围，避免覆盖他人的文件、采用指针和历史。历史、备份、项目资产及个人配置不因维护共享技能而改写。

## 目录与维护职责

工作区根的[README](README.md)是人读入口。当前工具、规则、方法、模板和知识资料集中在 `studio/`；活动项目在 `projects/`；历史记录在 `archive/`；发行包和完整备份分别在 `releases/`、`backups/`。不从历史目录选择活动项目。

新项目使用布局v2，工作资产位于 `assets/<TYPE>/<ID>/`，资产内容schema保持v1。迁移、停用与恢复先读[重构实施说明](studio/docs/重构实施说明.md)，不手动删除资产、改快照、改哈希或跨项目替换引用。公共规则由工作室执行规则和AI执行规范各按职责维护，阶段方法链接模板库的唯一骨架；机器字段只由数据协议定义。
