# DSH IDE

一个内置在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面里的 IDE 插件。

## 功能

- 侧边栏独立 IDE 入口
- 文件树、快速打开、搜索/替换、文件多标签
- 语法高亮、自动括号、括号匹配、当前行高亮、文档补全
- 大纲、Problems 诊断、检查点历史
- AI 助手（模型选择、API Key 配置、单文件 diff、多文件 `dsh-patch` 补丁）
- Git 面板：init / status / stage / unstage / commit / diff
- 终端：多标签、ANSI 颜色、真实 PTY
- LSP：定义、引用、悬停、补全、诊断（Python / TypeScript / JavaScript）
- 可选 CodeMirror 6 编辑器 Beta：多光标、折叠、语义补全、诊断 Gutter

## 环境要求

- DeepSeek Harness **0.2.1-rc.5**（插件按该版本 API 开发）
- Node.js 20+（开发和 LSP 推荐 24）
- Windows 是当前主要验证平台
- Python / TypeScript 语言服务按需使用：
  - Python：Pyright（随 `dsh-ide-lsp` 依赖安装）
  - TypeScript/JavaScript：`typescript-language-server`（随依赖安装）

## 安装（普通用户）

1. 下载本仓库 ZIP，解压到任意目录。
2. 在该目录双击 `install.cmd`，或在 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会安装 `dsh-ide-lsp/node_modules`，这是 LSP 必需的本地依赖。

3. 打开 DSH 桌面端 → 插件管理 → 从本地安装，依次选择：

```text
dsh-ide-lsp
dsh-ide-plugin
```

4. 重启 DSH（或重新加载 Web 页面）。
5. 在 DSH Web 界面打开 IDE 侧边栏入口。

> 必须同时安装 `dsh-ide-lsp` 和 `dsh-ide-plugin`，并且让它们保持在同一父目录下。IDE 的补全/诊断桥会按相对路径找 `../dsh-ide-lsp/node_modules`。

## 使用

- **AI 模型**：AI 助手标题下方的下拉框选择 Provider / Model；旁边的 `API` 可保存 API Key（写入 DSH 凭证服务）。
- **CodeMirror Beta**：状态栏的 `CM 6 off` 点击切换。出现问题时点回 `CM 6 off` 即可回退旧编辑器。
- **终端**：`Ctrl + 反引号` 打开；`+` 新建标签，`×` 关闭。
- **Git**：左侧分支图标。
- **LSP**：Python/TS/JS 文件的面包屑右侧有“定义 / 引用 / 悬停”，也支持 `Ctrl+Click`。

## 开发

```powershell
# 安装 LSP 依赖
npm --prefix dsh-ide-lsp install --ignore-scripts

# 安装 CodeMirror 构建依赖
npm --prefix dsh-ide-editor install --ignore-scripts

# 重新生成 assets/codemirror.js
npm --prefix dsh-ide-editor run build

# 运行 CodeMirror 集成测试
npm --prefix dsh-ide-editor test
```

## 目录结构

```text
dsh-ide-plugin/     # Host + Client 插件（含构建后的 CodeMirror 资源）
dsh-ide-lsp/        # LSP 配置包：Pyright + typescript-language-server
dsh-ide-editor/     # CodeMirror 6 构建工程和测试
install.ps1         # 安装 LSP 本地依赖
GITHUB.md           # 上传到 GitHub / 发布 Release 的步骤
```

## 已知限制

- LSP 的补全/诊断走 IDE 自己的桥；Python 诊断基于磁盘文件，未保存修改可能滞后。
- CodeMirror 仍是 Beta，默认未切换；浅色主题适配不完整。
- 完整 TUI（vim/htop）暂不支持，终端是 ANSI 彩色行输入模式。
- AI 多文件补丁使用整文件替换，不是 diff hunk 合并。
- 没有浏览器自动化测试；核心 CodeMirror 行为用 jsdom 测试覆盖。

## License

MIT。见 [LICENSE](LICENSE)。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
