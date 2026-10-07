# 随记 · Jot for Hermes

[English](README.md) · [使用与权限](docs/GUIDE.zh-CN.md) · [验证记录](docs/VALIDATION.md)

![Jot](assets/readme/jot-icon.svg)

**在 Hermes 旁边记下想法、待办和文档。人随时编辑，需要时让 agent 帮忙。**

> 本地适配候选版。尚未发布仓库或提交插件目录；真实 Desktop 交互验收和截图仍待完成。

## 可以做什么

- 在完整工作台或对话旁的面板里写笔记；搜索标题与正文，查看最近修改和置顶笔记。
- 使用标题、粗体、斜体、下划线、列表、核对清单、引用、代码、文字颜色和高亮。
- 插入表格，前后加行／列、拖动列宽、自动适应宽度。
- 自行创建文件夹，也可以一直不分类；支持排序、多选、复制、移动和回收站。
- 添加图片和文件、摘录选中的文字；使用附件预览、下载和默认应用打开入口。
- 导出 TXT、Markdown、PDF、Word（DOCX），也可以将多篇笔记按文件夹打包导出。
- 按需打开 AI 协作：agent 可以查找、读取、新建、追加、勾选待办和移到回收站；已有笔记的 AI 修改可以人工撤销。

## 人始终控制笔记

AI 协作默认关闭。六个 Jot 工具每次调用都会检查开关；工具不能自行打开它。修改要求精确版本，避免覆盖更新；整篇文本替换遇到表格、图片或其他富格式时会拒绝，优先保留原文后追加。

笔记按 Hermes profile 分开，存放在宿主管理的 `plugin-data/jot/`，不在插件安装目录。模型和密钥由 Hermes 管理，Jot 不需要额外 API Key，也不会把密钥传给笔记引擎。AI 工具的开关不替代操作系统文件权限。

## 当前安装方式

现在只提供本地开发包。安装包包含已构建的界面和笔记引擎，运行时不需要再次执行 npm install。

要求：近期 Hermes Desktop / 插件 SDK、Hermes 管理的 Node.js 22.19+。当前验证基线见[验证记录](docs/VALIDATION.md)。

1. 将完整插件目录放到当前 Hermes 数据目录的 `plugins/jot/`。
2. 执行 `hermes plugins validate /path/to/jot`。
3. 执行 `hermes plugins enable jot --no-allow-tool-override`。
4. 在 Desktop 的“技能与工具 → 插件”重新扫描并启用 Jot 的桌面部分；已有后端进程可能需要重启或重新加载插件。

Python 后端和 Desktop 界面是两个独立开关。Jot 内的“允许 AI 协作”只控制笔记工具，不影响人工编辑。

开发者在源码目录运行：

```sh
npm ci
npm run check
hermes --run-module unittest discover -s tests_py -v
hermes plugins validate . --json
```

完整本地检查并打包：`python3 scripts/check.py --package`。开发目录同步到宿主使用 `python3 scripts/install_local.py --home /path/to/hermes-home --replace`；已有本地安装会先备份，笔记数据不移动。请复制实际目录，Desktop 的统一包扫描不会跟随开发符号链接。

## 主题

工作台、正文编辑器和弹窗统一跟随 Hermes 当前主题，并支持明暗模式。

## 语言

Hermes 版默认使用英文。在“Sort and options → Interface language → 简体中文”切换为中文，随记会记住选择，不影响 Hermes 的语言设置。笔记内容保留你书写的语言。首页 README 和演示材料优先使用英文。

## 界面与快捷键

完整页、右侧面板和输入框入口均通过 Hermes SDK 注册。三条命令为“打开随记”“新建笔记”“摘录选中的文字”，默认不占用快捷键，由用户在 Hermes 设置中绑定。`/jot`、`/jot new`、`/jot capture` 用于打开相应入口。

编辑器沿用 Mac 的 ⌘ 和 Windows/Linux 的 Ctrl 习惯。复制、剪切、粘贴、全选保持系统操作；支持撤销／重做、粗体／斜体／下划线、当前笔记查找和保存。

## 适配方式

复用 [dsh-jot](https://github.com/Totoro-qaq/dsh-jot) 的文档模型、持久化、冲突保护、附件与导出逻辑。Python 将 Hermes 的认证、profile 和工具注册接到打包好的 Node 引擎，使用标准输入输出通信，不新开服务端口。

富文本编辑器运行在官方 `SandboxedFrame` 的不透明来源里；笔记列表、命令和宿主操作仍由 SDK 提供。编辑器没有宿主密钥、文件访问桥或网络权限，只与创建它的父组件交换明确列出的编辑消息。

当前没有独立的 Web Dashboard 界面，也不提供云同步、OCR、多人实时协同或手写画板。完整限制见[使用说明](docs/GUIDE.zh-CN.md)。

## 许可

MIT。原始 Jot 代码与视觉资产的来源记录在 [UPSTREAM.json](UPSTREAM.json)。离线中文 PDF 字体附带其许可证；打包的第三方依赖许可证随发布包提供。
