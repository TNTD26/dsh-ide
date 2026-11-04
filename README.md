# DSH IDE

[English](README.en.md) · [Release Notes](RELEASE_NOTES.md) · [GitHub 上传说明](GITHUB.md)

![License](https://img.shields.io/github/license/TNTD26/dsh-ide)
![Release](https://img.shields.io/github/v/release/TNTD26/dsh-ide)

一个内置在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面里的完整 IDE 插件。

## 功能

- 侧边栏独立 IDE 入口
- 文件树、快速打开、搜索/替换、文件多标签
- 语法高亮、自动括号、括号匹配、当前行高亮、文档补全
- 大纲、Problems 诊断、检查点历史
- AI 助手：模型选择、API Key 配置、单文件 diff、多文件 `dsh-patch` 补丁
- Git 面板：init / status / stage / unstage / commit / diff
- 终端：多标签、ANSI 颜色、真实 PTY
- LSP：定义、引用、悬停、补全、诊断（Python / TypeScript / JavaScript）
- 可选 CodeMirror 6 编辑器 Beta：多光标、折叠、语义补全、诊断 Gutter

## 环境要求

- DeepSeek Harness **0.2.1-rc.5**
- Node.js **20+**（推荐 24）
- Windows 是当前主要验证平台
- Python / TypeScript 语言服务随包自动安装：Pyright、typescript-language-server

## 安装

> 如果安装过旧版双包（`@local/dsh-ide` + `@local/dsh-ide-lsp`），请先在 DSH 插件管理里卸载它们，再安装本单包。两个版本使用同一个 IDE 路由，不能同时启用。

### 方式 1：下载 Release ZIP（推荐）

1. 打开 [Releases](https://github.com/TNTD26/dsh-ide/releases/latest)，下载最新 ZIP；
2. 解压到任意目录；
3. 双击 `install.cmd`（或执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`）；
4. 打开 DSH 桌面端 → 插件管理 → 从本地安装，选择**解压后的根目录**（只安装这一个目录）；
5. 重启 DSH，或刷新 Web 页面。

### 方式 2：DSH CLI 从 GitHub 安装

```powershell
dsh plugin --profile <你的profile> add github:TNTD26/dsh-ide
```

> 需要本机可访问 GitHub，并让 DSH 安装 npm 依赖。安装完成后同样需要重启 DSH。

## 使用

- **AI 模型**：AI 助手标题下方的下拉框选择 Provider / Model；旁边的 `API` 可保存 API Key（写入 DSH 凭证服务，不保存在浏览器）。
- **CodeMirror Beta**：状态栏的 `CM 6 off` 点击切换。出现问题时点回 `CM 6 off`。
- **终端**：`Ctrl + 反引号` 打开；`+` 新建标签，`×` 关闭。
- **Git**：左侧分支图标。
- **LSP**：Python/TS/JS 文件的面包屑右侧有“定义 / 引用 / 悬停”，也支持 `Ctrl+Click`。

## 开发

```powershell
# 根包依赖（IDE + LSP）
npm install --ignore-scripts

# CodeMirror 构建依赖
npm --prefix dsh-ide-editor install --ignore-scripts

# 重新生成 assets/codemirror.js
npm --prefix dsh-ide-editor run build

# CodeMirror 集成测试
npm --prefix dsh-ide-editor test
```

## 目录结构

```text
index.js                   # Host：文件、Git、终端、AI、LSP 桥
client.js                  # IDE Web 客户端
assets/codemirror.js       # 构建后的 CodeMirror 6
cordis.patch.yml           # DSH bundle patch
dsh-ide-editor/            # CodeMirror 构建工程和测试
install.cmd / install.ps1  # 安装根包依赖
GITHUB.md                  # 上传/发版步骤
SCREENSHOTS.md             # 截图清单（英文）
截图清单.md                # 截图清单（中文，含拍摄步骤）
```

## 截图

截图放在 `docs/screenshots/`，清单和拍摄方法见 [中文截图清单](截图清单.md) 或 [SCREENSHOTS.md](SCREENSHOTS.md)。

## 已知限制

- LSP 的补全/诊断走 IDE 自己的桥；Python 诊断基于磁盘文件，未保存修改可能滞后。
- CodeMirror 仍是 Beta，默认未切换；浅色主题适配不完整。
- 完整 TUI（vim/htop）暂不支持，终端是 ANSI 彩色行输入模式。
- AI 多文件补丁使用整文件替换，不是 diff hunk 合并。

## License

MIT。见 [LICENSE](LICENSE)。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
