# DSH Plus · 会话删除

[English](README.md) | 中文

从 DSH 侧边栏彻底删除已归档的旧会话。

属于 [DSH Plus](https://github.com/ArakawaHenri/dshplus) 系列插件（`@dshplus/session-delete`）。

## 安装

在 DSH 插件管理器中安装 `@dshplus/session-delete`（或直接安装 [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) 总包）：

```text
@dshplus/session-delete
```

## 用法

1. 先把不需要的会话归档。
2. 在归档列表里点开该会话的 `…` 菜单，选择**永久删除…**。
3. 确认后会删掉该会话的 JSONL 日志，并清理工作区关联和归档记录。

为避免误删，只有已归档且没有后台任务或提醒的会话才能删除。工作区里的代码文件、上传过的附件以及已经分叉到其他会话的历史不受影响。

## 许可

MIT
