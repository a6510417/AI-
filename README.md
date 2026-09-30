# AI 漫剧工作室

共享方法与工具在 `studio/`，故事在 `projects/`，九个任务入口在 `.agents/skills/`。从这里进入日常工作。

- [当前项目：大反派今天也不想上班](projects/IP001_大反派今天也不想上班/项目入口.md)
- [选择任务和技能](studio/使用说明/04_工作室日常使用.md)
- [工作室执行规则](studio/docs/工作室执行规则.md)
- [工具与迁移使用说明](studio/docs/重构实施说明.md)
- [数据协议](studio/docs/数据协议.md)与[接口规范](studio/docs/接口规范.md)
- [历史记录](archive/README.md)、[发行包](releases/README.md)
- [本次重构验收与回退位置](archive/重构验收_2026-10-01.md)

## 日常操作

使用本机 Node.js 22 或更新版本，无需安装第三方运行依赖。在工作区根目录运行：

```powershell
node studio/bin/studio.mjs status --project "projects/IP001_大反派今天也不想上班" --json
node studio/bin/studio.mjs validate --project "projects/IP001_大反派今天也不想上班" --strict --json
```

继续制作先读状态，再读取对应采用快照。项目入口是带读取时点的导航，不替代采用指针。图片、视频、声音与成片分别按实际检查范围验收。

新项目使用布局 v2：资产按类型与编号保存，制作记录放 `production/`，交付包放 `deliveries/`。旧布局 v1 继续可读，旧工具路径 `AI漫剧导演助手/tools/ip-tool.mjs` 保留兼容。

## 维护

```powershell
npm test
npm run check:docs
```

本地 Git 管理共享程序、规范和技能。故事、原始素材、冻结历史和备份通过完整文件备份保护；迁移及升级前确认无并行写入。`sources/inbox/` 中材料的项目归属待确认，不能自动成为故事依据。
