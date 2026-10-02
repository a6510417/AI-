# AI 漫剧工作室

共享方法与工具在 `studio/`，故事在 `projects/`，九个任务入口在 `.agents/skills/`。从这里进入日常工作。

直接在对话中告诉 AI 要做什么，由当前 AI 读取项目并调用工具，无需用户打开终端或操作菜单。[工作室中文入口](工作室入口.md)提供中文目录导航。新增制作文件使用中文名称，已有系统目录和资产编号保持兼容，原因见[重构实施说明](studio/docs/重构实施说明.md)。

- [当前项目：大反派今天也不想上班](projects/IP001_大反派今天也不想上班/项目入口.md)
- [独立项目：最强狂暴系统](projects/IP003_最强狂暴系统/项目入口.md)
- [选择任务和技能](studio/使用说明/04_工作室日常使用.md)
- [工作室执行规则](studio/docs/工作室执行规则.md)
- [工具与迁移使用说明](studio/docs/重构实施说明.md)
- [数据协议](studio/docs/数据协议.md)与[接口规范](studio/docs/接口规范.md)
- [历史记录](archive/README.md)
- [小说→漫剧全链路审查与重构](studio/docs/研究/2026-10-02_小说漫剧全链路审查与重构.md)
- [本次重构验收与回退位置](archive/重构验收_2026-10-01.md)

## 日常操作

工具使用本机 Node.js 22 或更新版本，无需安装第三方运行依赖。以下命令由当前 AI 在工作区根目录执行：

```powershell
node studio/bin/studio.mjs status --project "projects/IP001_大反派今天也不想上班" --json
node studio/bin/studio.mjs validate --project "projects/IP001_大反派今天也不想上班" --strict --json
```

继续制作先读状态，再读取对应采用快照。项目入口是带读取时点的导航，不替代采用指针。图片、视频、声音与成片分别按实际检查范围验收。

新项目的资产按类型与编号保存，制作记录放 `production/`，交付包放 `deliveries/`。工作室管理与制作命令统一使用 `studio/bin/studio.mjs`，保留中文命令别名；无参数或 `--help` 仅显示帮助。

小说接入使用可复用的 `studio/bin/novel-intake.mjs`：原稿与按需无损分章存档，实际取材才建立正式来源资产；选章阅读可追溯清理，详细命令见[接口规范](studio/docs/接口规范.md)。续作包默认只携带一份冻结资产；报告阅览默认本地精确引用，需要跨机携带再显式生成便携包。

## 维护

```powershell
npm test
npm run check:docs
```

本地 Git 管理共享程序、规范和技能。故事、原始素材、冻结历史和备份通过完整文件备份保护；迁移及升级前确认无并行写入。`sources/inbox/` 中材料的项目归属待确认，不能自动成为故事依据。
