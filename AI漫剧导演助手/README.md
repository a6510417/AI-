# 旧工具路径兼容入口

日常工作从工作区根的 [README](../README.md) 进入。正式工具及资料在 [studio](../studio/docs/重构实施说明.md)，活动项目在根 `projects/`。

`tools/ip-tool.mjs` 保留原公开函数和命令入口，创建项目默认布局 v1；`studio/bin/studio.mjs` 创建项目默认布局 v2。两者都能操作已识别的 v1/v2 项目。

重构前的完整助手与项目保留在 `archive/legacy-assistant/`，适用于[回退核对](../archive/README.md)；当前活动项目位置请读取根入口，不沿用历史路径。
