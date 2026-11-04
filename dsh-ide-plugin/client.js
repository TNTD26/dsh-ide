window.__ModuleLoader__.load({
  id: '@local/dsh-ide',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const {
      useState, useEffect, useRef, useMemo, useCallback, useReducer,
      createContext, useContext, Fragment,
    } = React

    // -----------------------------------------------------------------------
    // Constants and tiny utilities
    // -----------------------------------------------------------------------

    const API = '/dsh-ide/api'
    let TOKEN = typeof window !== 'undefined' ? window.__DSH_IDE_TOKEN__ || '' : ''
    const LS = {
      side: 'dsh-ide.sideWidth',
      chat: 'dsh-ide.chatWidth',
      chatOpen: 'dsh-ide.chatOpen',
      terminalOpen: 'dsh-ide.terminalOpen',
      terminalHeight: 'dsh-ide.terminalHeight',
      root: 'dsh-ide.root',
      active: 'dsh-ide.active:',
    }
    const MONO = 'var(--dsh-font-family-code, ui-monospace), SFMono-Regular, "Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", monospace'

    // Survives switching the central panel (the slot unmounts this subtree)
    // while staying scoped to the current page session.
    const ideMemory = {
      root: '',
      tabs: [],
      active: null,
      tree: {},
      expanded: { '': true },
      view: 'explorer',
      chatMessages: [],
      terminal: { root: '', id: null, output: '', exited: false },
    }

    function readLS(key, fallback) {
      try {
        const value = window.localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeLS(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch {
        /* private mode */
      }
    }

    function readNumber(key, fallback) {
      const raw = Number(readLS(key, fallback))
      return Number.isFinite(raw) ? raw : fallback
    }

    function readBool(key, fallback) {
      const raw = readLS(key, fallback ? '1' : '0')
      return raw === '1' || raw === 'true'
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function resolveRevealInfo(text, info) {
      if (!info) return null
      if (Number.isFinite(info.index)) return { index: info.index, length: info.length || 0 }
      if (Number.isFinite(info.line)) {
        const lines = String(text ?? '').split('\n')
        const lineIndex = clamp(info.line - 1, 0, Math.max(0, lines.length - 1))
        let offset = 0
        for (let index = 0; index < lineIndex; index += 1) offset += lines[index].length + 1
        const column = clamp((info.column || 1) - 1, 0, lines[lineIndex]?.length || 0)
        return { index: offset + column, length: 0 }
      }
      return null
    }

    function basename(rel) {
      const parts = String(rel || '').split('/')
      return parts[parts.length - 1] || rel
    }

    function dirname(rel) {
      const parts = String(rel || '').split('/')
      parts.pop()
      return parts.join('/')
    }

    function joinRel(parent, name) {
      return parent ? `${parent}/${name}` : name
    }

    function languageOf(rel) {
      const name = basename(rel).toLowerCase()
      if (name === 'dockerfile') return 'dockerfile'
      if (name === 'makefile') return 'makefile'
      if (name.startsWith('.env')) return 'ini'
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot + 1) : ''
      const map = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
        ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
        json: 'json', jsonc: 'json', json5: 'json',
        css: 'css', scss: 'scss', sass: 'scss', less: 'less',
        html: 'html', htm: 'html', xhtml: 'html', vue: 'vue', svelte: 'svelte',
        xml: 'xml', svg: 'xml',
        md: 'markdown', markdown: 'markdown', mdx: 'markdown',
        py: 'python', pyw: 'python', rb: 'ruby', php: 'php',
        go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
        c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
        cs: 'csharp', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r',
        sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
        ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
        yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
        sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
        txt: 'plaintext', log: 'plaintext',
      }
      return map[ext] || 'plaintext'
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function fileTone(name) {
      const base = basename(name).toLowerCase()
      if (base.endsWith('.ts') || base.endsWith('.tsx') || base.endsWith('.mts')) return 'blue'
      if (base.endsWith('.js') || base.endsWith('.jsx') || base.endsWith('.mjs') || base.endsWith('.cjs')) return 'yellow'
      if (base.endsWith('.json') || base.endsWith('.jsonc')) return 'amber'
      if (base.endsWith('.css') || base.endsWith('.scss') || base.endsWith('.less')) return 'purple'
      if (base.endsWith('.html') || base.endsWith('.vue') || base.endsWith('.svelte')) return 'orange'
      if (base.endsWith('.md') || base.endsWith('.mdx')) return 'cyan'
      if (base.endsWith('.py')) return 'green'
      if (base.endsWith('.go')) return 'sky'
      if (base.endsWith('.rs')) return 'rust'
      if (base.endsWith('.yml') || base.endsWith('.yaml')) return 'pink'
      if (base.endsWith('.sh') || base.endsWith('.ps1')) return 'lime'
      return 'slate'
    }

    function stripAnsi(value) {
      return String(value)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .replace(/\x1b[=>]/g, '')
        .replace(/\x1b/g, '')
    }

    function stripAnsiExceptColors(value) {
      return String(value)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[([0-?]*)([ -/]*)([@-~])/g, (match, params, intermediate, command) => (
          command === 'm' ? match : ''
        ))
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .replace(/\x1b[=>]/g, '')
        .replace(/\x1b/g, '')
    }

    function cleanTerminalText(value, raw = false, keepAnsi = false) {
      const text = (keepAnsi ? stripAnsiExceptColors(value) : stripAnsi(value)).replace(/\r\n/g, '\n')
      if (raw || keepAnsi) {
        return text
          .replace(/\r/g, '\n')
          .replace(/\x08/g, '')
          .replace(/\x07/g, '')
          .replace(/\x00/g, '')
      }
      let output = ''
      for (const character of text) {
        if (character === '\r') {
          const lineStart = output.lastIndexOf('\n')
          output = output.slice(0, lineStart + 1)
        } else if (character === '\x08') {
          output = output.slice(0, -1)
        } else if (character === '\x07' || character === '\x00') {
          /* control characters */
        } else {
          output += character
        }
      }
      return output
    }

    const ANSI_BASIC = ['#94a3b8', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#e5e7eb']
    const ANSI_BRIGHT = ['#cbd5e1', '#fca5a5', '#86efac', '#fde047', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff']
    const ANSI_BG = ['#1e293b', '#7f1d1d', '#14532d', '#713f12', '#1e3a8a', '#581c87', '#164e63', '#334155']
    const ANSI_BG_BRIGHT = ['#334155', '#991b1b', '#166534', '#854d0e', '#1e40af', '#6b21a8', '#155e75', '#475569']

    function ansi256Color(value) {
      const index = Number(value)
      if (!Number.isFinite(index)) return ''
      if (index < 8) return ANSI_BASIC[index]
      if (index < 16) return ANSI_BRIGHT[index - 8]
      if (index >= 232) {
        const level = Math.max(0, Math.min(255, 8 + (index - 232) * 10))
        return `rgb(${level}, ${level}, ${level})`
      }
      const offset = index - 16
      const r = Math.floor(offset / 36)
      const g = Math.floor((offset % 36) / 6)
      const b = offset % 6
      const channel = (n) => (n === 0 ? 0 : 55 + n * 40)
      return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
    }

    function applySgr(state, params) {
      const next = { ...state }
      const values = (params ? params.split(';') : ['0']).map((part) => (part === '' ? 0 : Number(part)))
      for (let index = 0; index < values.length; index += 1) {
        const code = values[index]
        if (code === 0) {
          next.fg = ''
          next.bg = ''
          next.bold = false
          next.dim = false
          next.italic = false
          next.underline = false
          next.inverse = false
        } else if (code === 1) next.bold = true
        else if (code === 2) next.dim = true
        else if (code === 3) next.italic = true
        else if (code === 4) next.underline = true
        else if (code === 7) next.inverse = true
        else if (code === 22) { next.bold = false; next.dim = false }
        else if (code === 23) next.italic = false
        else if (code === 24) next.underline = false
        else if (code === 27) next.inverse = false
        else if (code >= 30 && code <= 37) next.fg = ANSI_BASIC[code - 30]
        else if (code >= 90 && code <= 97) next.fg = ANSI_BRIGHT[code - 90]
        else if (code >= 40 && code <= 47) next.bg = ANSI_BG[code - 40]
        else if (code >= 100 && code <= 107) next.bg = ANSI_BG_BRIGHT[code - 100]
        else if (code === 39) next.fg = ''
        else if (code === 49) next.bg = ''
        else if (code === 38 || code === 48) {
          const target = code === 38 ? 'fg' : 'bg'
          if (values[index + 1] === 5) {
            next[target] = ansi256Color(values[index + 2])
            index += 2
          } else if (values[index + 1] === 2) {
            next[target] = `rgb(${values[index + 2] || 0}, ${values[index + 3] || 0}, ${values[index + 4] || 0})`
            index += 4
          }
        }
      }
      return next
    }

    function terminalAnsiLines(text) {
      const source = String(text || '').slice(-120000)
      const lines = [[]]
      let state = { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, inverse: false }
      const pushText = (value) => {
        if (!value) return
        const style = {}
        const fg = state.inverse ? state.bg : state.fg
        const bg = state.inverse ? state.fg : state.bg
        if (fg) style.color = fg
        if (bg) style.backgroundColor = bg
        if (state.bold) style.fontWeight = 600
        if (state.dim) style.opacity = 0.72
        if (state.italic) style.fontStyle = 'italic'
        if (state.underline) style.textDecoration = 'underline'
        lines[lines.length - 1].push({ text: value, style })
      }
      const pattern = /\x1b\[([0-9;]*)m/g
      let last = 0
      for (const match of source.matchAll(pattern)) {
        if (match.index > last) pushText(source.slice(last, match.index))
        state = applySgr(state, match[1])
        last = match.index + match[0].length
      }
      if (last < source.length) pushText(source.slice(last))
      const split = []
      for (const line of lines) {
        const pieces = []
        for (const span of line) {
          const parts = span.text.split('\n')
          parts.forEach((part, index) => {
            if (part) pieces.push({ text: part, style: span.style })
            if (index < parts.length - 1) {
              split.push(pieces.slice())
              pieces.length = 0
            }
          })
        }
        split.push(pieces)
      }
      return split
    }

    function TerminalAnsi({ text }) {
      const lines = useMemo(() => terminalAnsiLines(text), [text])
      return h(Fragment, null, lines.map((line, index) => h('div', {
        key: index,
        className: 'ide-terminal-ansi-line',
      }, line.length === 0
        ? '\u00a0'
        : line.map((span, spanIndex) => h('span', { key: spanIndex, style: span.style }, span.text)))))
    }

    function buildAiDiff(oldText, newText) {
      if (oldText === newText) return ''
      const oldLines = oldText.split('\n')
      const newLines = newText.split('\n')
      let prefix = 0
      while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
      let suffix = 0
      while (
        suffix < oldLines.length - prefix
        && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
      ) suffix += 1
      const removed = oldLines.slice(prefix, oldLines.length - suffix)
      const added = newLines.slice(prefix, newLines.length - suffix)
      const output = ['--- 当前内容', '+++ AI 建议']
      if (removed.length || added.length) {
        output.push(`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`)
      }
      for (const line of removed) output.push(`-${line}`)
      for (const line of added) output.push(`+${line}`)
      return output.join('\n')
    }

    /**
     * Parse the full-replacement multi-file patch protocol used by the IDE
     * assistant. Paths are workspace-relative; no diff application is needed.
     */
    function parseMultiFilePatch(text) {
      const lines = String(text || '').split('\n')
      const patches = []
      let current = null
      for (const line of lines) {
        if (/^\s*\*\*\*\s+End Patch\s*$/i.test(line)) {
          current = null
          continue
        }
        const marker = line.match(/^\s*\*\*\*\s+(?:Replace|Create|Update)\s+File:\s*(.+?)\s*$/i)
        if (marker) {
          current = { path: marker[1].replace(/^["'`]|["'`]$/g, ''), lines: [] }
          patches.push(current)
          if (patches.length >= 20) break
          continue
        }
        if (current) current.lines.push(line)
      }
      return patches
        .filter((patch) => patch.path)
        .map((patch) => ({
          path: patch.path.replace(/\\/g, '/'),
          text: patch.lines.join('\n').slice(0, 2 * 1024 * 1024),
        }))
    }

    function extractSymbols(text, language) {
      if (!text) return []
      const lines = String(text).split('\n')
      const symbols = []
      const push = (lineIndex, name, kind, indent) => {
        if (symbols.length >= 200 || !name) return
        symbols.push({
          name: String(name).trim(),
          kind,
          line: lineIndex + 1,
          indent: Math.max(0, Math.min(12, indent)),
        })
      }

      const patterns = language === 'python'
        ? [
          [/^(\s*)class\s+([A-Za-z_]\w*)/, 'class'],
          [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
        ]
        : (['typescript', 'javascript'].includes(language)
          ? [
            [/^(\s*)(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
            [/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
            [/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|=>)/, 'variable'],
          ]
          : (language === 'markdown'
            ? [[/^(#{1,6})\s+(.+)$/, 'heading']]
            : []))

      lines.forEach((line, index) => {
        if (language === 'markdown') {
          const match = line.match(/^(#{1,6})\s+(.+)$/)
          if (match) push(index, match[2].replace(/[#*`]/g, ''), 'heading', match[1].length - 1)
          return
        }
        for (const [pattern, kind] of patterns) {
          const match = line.match(pattern)
          if (!match) continue
          const whitespace = match[1] || ''
          const indent = language === 'python'
            ? Math.floor(whitespace.replace(/\t/g, '  ').length / 2)
            : Math.floor(whitespace.length / 2)
          push(index, match[2], kind, indent)
          break
        }
      })
      return symbols
    }

    // -----------------------------------------------------------------------
    // Locale
    // -----------------------------------------------------------------------

    const EN = {
      'IDE': 'IDE',
      '文件': 'File',
      '编辑': 'Edit',
      '选择': 'Selection',
      '视图': 'View',
      '帮助': 'Help',
      '资源管理器': 'Explorer',
      '搜索': 'Search',
      '替换': 'Replace',
      '新建文件': 'New File',
      '新建文件夹': 'New Folder',
      '刷新': 'Refresh',
      '折叠全部': 'Collapse All',
      '重命名': 'Rename',
      '删除': 'Delete',
      '复制相对路径': 'Copy Relative Path',
      '保存': 'Save',
      '全部保存': 'Save All',
      '关闭': 'Close',
      '关闭所有': 'Close All',
      '按名称搜索文件…': 'Search files by name…',
      '文件加载被中断，请点击重试': 'Loading was interrupted. Click Retry.',
      '复制失败': 'Copy failed',
      '关闭标签页': 'Close Tab',
      '未保存': 'Unsaved',
      '已保存': 'Saved',
      '已创建': 'Created',
      '已删除': 'Deleted',
      '已重命名': 'Renamed',
      '取消': 'Cancel',
      '确定': 'OK',
      '创建': 'Create',
      '打开': 'Open',
      '加载中': 'Loading',
      '没有匹配': 'No matches',
      '无结果': 'No results',
      '快速打开': 'Quick Open',
      '输入文件名': 'Type a file name',
      '转到文件': 'Go to File',
      '工作区': 'Workspace',
      '切换工作区': 'Switch Workspace',
      'AI 助手': 'AI Assistant',
      '新对话': 'New Chat',
      '清空对话': 'Clear Chat',
      '发送': 'Send',
      '停止': 'Stop',
      '思考过程': 'Reasoning',
      '复制': 'Copy',
      '应用': 'Apply',
      '插入': 'Insert',
      '已复制': 'Copied',
      '已应用到编辑器': 'Applied to editor',
      'AI 修改预览': 'Preview AI edit',
      '文件内容已变化，请重新预览': 'File changed. Preview the edit again.',
      '定义': 'Def',
      '引用': 'Refs',
      '悬停': 'Hover',
      '悬停信息': 'Hover',
      '没有悬停信息': 'No hover information.',
      '没有找到结果': 'No results.',
      '位置在工作区外': 'The location is outside the workspace.',
      '转到定义': 'Go to Definition',
      '查找引用': 'Find References',
      '转到实现': 'Go to Implementation',
      '大纲': 'Outline',
      '打开文件查看大纲': 'Open a file to see its outline',
      '没有可显示的符号': 'No symbols to show',
      '建议': 'Suggestions',
      '问题': 'Problems',
      '打开文件查看问题': 'Open a file to see its problems',
      '正在分析': 'Analyzing',
      '没有发现问题': 'No problems found',
      '请先打开文件': 'Open a file first',
      '包含当前文件': 'Include current file',
      '选中': 'Selected',
      '个字符': 'characters',
      '上下文': 'Context',
      '清空': 'Clear',
      '检查点': 'Checkpoints',
      'AI 修改前': 'Before AI edit',
      '重新加载前': 'Before disk reload',
      '恢复前': 'Before restore',
      '已恢复检查点': 'Checkpoint restored',
      '文件正在加载，请稍后重试': 'The file is loading. Try again shortly.',
      '文件当前不可用，无法恢复检查点': 'The file is unavailable; the checkpoint cannot be restored.',
      'AI 修改或磁盘重载前会自动保存检查点': 'Checkpoints are saved before AI edits and disk reloads',
      '多文件补丁': 'Multi-file patch',
      '应用多文件补丁': 'Apply multi-file patch',
      '应用多文件': 'Apply files',
      '没有解析到多文件补丁': 'No multi-file patch was found.',
      '补丁包含非法路径': 'The patch contains an invalid path.',
      '将直接写入磁盘并覆盖同名文件': 'Writes directly to disk and overwrites existing files',
      '行': 'lines',
      '已打开文件的本地修改会先进入检查点。': 'Local edits to open files are saved as checkpoints first.',
      '应用并保存': 'Apply and save',
      '多文件补丁前': 'Before multi-file patch',
      '已应用 {count} 个文件': 'Applied {count} files',
      '加载编辑器引擎': 'Loading editor engine',
      'CodeMirror 6 编辑器': 'CodeMirror 6 editor',
      '选择模型': 'Select model',
      '加载模型…': 'Loading models…',
      '模型 API 配置': 'Model API settings',
      '请填写 API Key': 'Enter an API key',
      '保存并刷新模型': 'Save and refresh models',
      'API Key 会写入 DSH 凭证服务，不保存在浏览器里。保存后会自动刷新可选模型。': 'The API key is stored in DSH credentials, not the browser. Models refresh after saving.',
      '模型': 'Model',
      '未配置模型': 'No model configured',
      '开始对话': 'Start a conversation',
      '让 AI 解释当前文件': 'Explain the current file',
      '为选中代码添加注释': 'Comment the selected code',
      '生成单元测试': 'Generate unit tests',
      '重构这段代码': 'Refactor this code',
      '代码搜索': 'Code Search',
      '搜索结果': 'Search Results',
      '个文件': 'files',
      '处匹配': 'matches',
      '全部替换': 'Replace All',
      '替换此处的匹配': 'Replace this match',
      '区分大小写': 'Match Case',
      '正则表达式': 'Use Regular Expression',
      '全字匹配': 'Match Whole Word',
      '文件筛选': 'Files to include',
      '例如 src/**/*.ts': 'e.g. src/**/*.ts',
      '搜索内容': 'Search',
      '替换为': 'Replace with',
      '行': 'Ln',
      '列': 'Col',
      '空格': 'Spaces',
      '编码': 'Encoding',
      '换行符': 'Line Endings',
      '语言': 'Language',
      '就绪': 'Ready',
      '错误': 'Error',
      '警告': 'Warning',
      '此文件无法预览': 'This file cannot be previewed',
      '二进制文件': 'Binary file',
      '重试': 'Retry',
      '重新加载': 'Reload',
      '保存并关闭': 'Save and Close',
      '不保存': 'Don\'t Save',
      '放弃更改': 'Discard Changes',
      '有未保存的更改': 'Unsaved changes',
      '关闭后将丢失': 'will be lost if you close it.',
      '删除确认': 'Delete',
      '此操作不可撤销': 'This action cannot be undone.',
      '确定删除': 'Delete',
      '路径': 'Path',
      '名称': 'Name',
      '请输入名称': 'Enter a name',
      '名称不能为空': 'Name is required',
      '打开文件': 'Open File',
      '从左侧选择文件': 'Choose a file from the explorer',
      '或按 Ctrl+P 快速打开': 'or press Ctrl+P to quick open',
      '新建': 'New',
      '无打开的文件': 'No file open',
      '显示/隐藏 AI 面板': 'Toggle AI panel',
      '显示/隐藏侧栏': 'Toggle sidebar',
      '展开': 'Expand',
      '折叠': 'Collapse',
      '代码': 'Code',
      '纯文本': 'Plain Text',
      '只读': 'Read only',
      '已停止': 'Stopped',
      '终端': 'Terminal',
      '新建终端': 'New terminal',
      '关闭终端': 'Close terminal',
      '清空终端': 'Clear terminal',
      '隐藏终端': 'Hide terminal',
      '调整终端高度': 'Resize terminal',
      '运行中': 'Running',
      '启动中': 'Starting',
      '未连接': 'Disconnected',
      '已退出': 'Exited',
      '终端已就绪，输入命令…': 'Terminal ready. Type a command…',
      '输入命令，回车执行': 'Type a command and press Enter',
      '进程已退出，点击 + 新建终端': 'Process exited. Click + for a new terminal.',
      '发送 Ctrl+C': 'Send Ctrl+C',
      '终端连接失败': 'Terminal connection failed',
      '终端错误': 'Terminal error',
      '终端连接已断开': 'Terminal connection closed',
      '源代码管理': 'Source Control',
      '提交': 'Commit',
      '提交信息': 'Commit message',
      '暂存': 'Stage',
      '取消暂存': 'Unstage',
      '暂存全部': 'Stage all',
      '取消全部暂存': 'Unstage all',
      '已暂存': 'Staged',
      '更改': 'Changes',
      '工作区没有更改': 'No changes in the working tree',
      '该文件夹不是 Git 仓库': 'This folder is not a Git repository',
      '初始化 Git 仓库': 'Initialize Git repository',
      'Git 仓库已初始化': 'Git repository initialized',
      '提交成功': 'Committed',
      '请先暂存文件': 'Stage files first',
      '没有已暂存的文件': 'No staged files',
      '文件已从磁盘上删除': 'File was deleted on disk',
      '保留文本': 'Keep text',
      '文件已在磁盘上更改': 'File changed on disk',
      '保留我的更改': 'Keep my changes',
      '已从磁盘重新加载': 'Reloaded from disk',
      '没有差异': 'No differences',
      '生成中': 'Generating',
      '等待响应': 'Waiting',
      '请求失败': 'Request failed',
      '网络错误': 'Network error',
      '令牌缺失，请刷新页面': 'Session token missing. Refresh the page.',
      '个结果': 'results',
      '匹配': 'match',
      '保存全部': 'Save all',
      '工作区根目录': 'Workspace root',
      '复制路径': 'Copy path',
      '在编辑器中打开': 'Open in editor',
      '字数': 'Characters',
      '大小': 'Size',
      '文件已变化': 'File changed on disk',
      '无法读取文件': 'Unable to read file',
      '输入问题，向 AI 提问…': 'Ask the AI about your code…',
      'Enter 发送 · Shift+Enter 换行': 'Enter to send · Shift+Enter for a new line',
      'AI 可以读取当前文件与选中片段，建议需手动应用。': 'The assistant can read the current file and selection. Suggestions must be applied manually.',
      '当前文件': 'Current file',
      '选中内容': 'Selection',
      '个文件已修改': 'files changed',
      '没有修改': 'No changes',
      '工作区中没有匹配的文件': 'No matching files in this workspace',
      '开始输入以搜索整个工作区': 'Start typing to search the whole workspace',
      '包含': 'include',
      '已停止生成': 'Generation stopped',
      '思考中': 'Thinking',
      '回答': 'Answer',
      '正在读取上下文…': 'Reading context…',
      '可在对话中让 AI：': 'Ask the assistant to:',
      '收起': 'Collapse',
      '展开全部': 'Expand all',
      '文件': 'File',
      '文件夹': 'Folder',
      '个匹配': 'matches',
      '搜索中…': 'Searching…',
      '替换中…': 'Replacing…',
      '点击替换': 'Replace',
      '没有可替换的匹配': 'No match to replace',
      '确认替换全部': 'Replace all?',
      '这将修改所有匹配位置，操作不可撤销。': 'This rewrites every match and cannot be undone.',
      '已替换 {count} 处': 'Replaced {count} matches',
      '没有可替换的内容': 'Nothing to replace',
      '当前工作区': 'Current workspace',
      '打开文件夹': 'Open folder',
      '输入文件夹路径': 'Enter folder path',
      '文件夹路径': 'Folder path',
      '请输入文件夹路径': 'Enter a folder path',
      '最近的文件': 'Recent files',
      '无匹配文件': 'No matching files',
      '文件列表': 'Files',
      '上下文已附加': 'Context attached',
      '未附加文件内容': 'File content not attached',
      '会话已清空': 'Chat cleared',
      '复制代码': 'Copy code',
      '应用代码': 'Apply code',
      '按 Esc 关闭': 'Press Esc to close',
      '输入以筛选': 'Type to filter',
      '没有可显示的根目录': 'No workspace root available',
      '工作区加载失败': 'Failed to load workspace',
    }

    const ZH = {}
    for (const key of Object.keys(EN)) ZH[key] = key

    function useT(ctx) {
      const [revision, bump] = useReducer((value) => value + 1, 0)
      useEffect(() => ctx.locale.subscribe(() => bump()), [ctx])
      return useCallback((key, vars) => {
        let value
        try {
          value = ctx.locale.bind('dsh-ide')(key)
        } catch {
          value = key
        }
        if (!value || value === key) {
          let active = 'zh'
          try {
            active = ctx.locale.getSnapshot().active || 'zh'
          } catch {
            /* keep Chinese */
          }
          if (!String(active).toLowerCase().startsWith('zh')) value = EN[key] || key
        }
        if (vars) {
          value = String(value).replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? `{${name}}` : String(vars[name])))
        }
        return value
      }, [ctx, revision])
    }

    // -----------------------------------------------------------------------
    // Icons
    // -----------------------------------------------------------------------

    const ICON_PATHS = {
      code: ['m9 8-5 4 5 4', 'm15 8 5 4-5 4', 'm13 5-2 14'],
      file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5'],
      folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
      folderOpen: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1', 'M3 10h18l-2 8a2 2 0 0 1-2 1.6H5A2 2 0 0 1 3 18Z'],
      chevronRight: ['m9 6 6 6-6 6'],
      chevronDown: ['m6 9 6 6 6-6'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
      replace: ['M4 7h11a4 4 0 0 1 4 4v1', 'm16 9 3 3 3-3', 'M20 17H9a4 4 0 0 1-4-4v-1', 'm8 15-3-3-3 3'],
      close: ['M6 6l12 12', 'M18 6 6 18'],
      plus: ['M12 5v14', 'M5 12h14'],
      minus: ['M5 12h14'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
      trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 11v6', 'M14 11v6'],
      edit: ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z', 'M14 6l3 3'],
      chat: ['M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z', 'M8 12h8', 'M8 9h5', 'M8 15h6'],
      send: ['M4 12 21 3l-7 18-3-8Z', 'M11 13 21 3'],
      stop: ['M6 6h12v12H6z'],
      sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z', 'M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9Z'],
      save: ['M5 3h11l3 3v15H5Z', 'M8 3v6h7V3', 'M8 14h8v7H8Z'],
      more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
      check: ['m5 12 4 4L19 6'],
      alert: ['M12 4 2.8 20h18.4Z', 'M12 9v5', 'M12 17h.01'],
      copy: ['M9 9h11v11H9Z', 'M5 15H4V4h11v1'],
      insert: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16'],
      settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
      branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M18 9a9 9 0 0 1-9 9'],
      layout: ['M3 4h18v16H3Z', 'M9 4v16', 'M3 9h18'],
      panelRight: ['M3 4h18v16H3Z', 'M15 4v16'],
      filePlus: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z', 'M14 3v5h5', 'M12 12v6', 'M9 15h6'],
      folderPlus: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M12 11v6', 'M9 14h6'],
      collapse: ['m8 9 4 4 4-4', 'M4 4h16v16H4Z'],
      expand: ['m8 7 4 4 4-4', 'M4 4h16v16H4Z'],
      arrowUp: ['m6 15 6-6 6 6'],
      arrowDown: ['m6 9 6 6 6-6'],
      eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
      eyeOff: ['M3 3l18 18', 'M10.6 10.6a2 2 0 0 0 2.8 2.8', 'M9.9 5.2A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 4', 'M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.1-.9'],
      closeAll: ['M4 6h9', 'M4 10h9', 'M4 14h6', 'm14 14 5 5', 'm19 14-5 5'],
      terminal: ['M3 5h18v14H3Z', 'm7 9 3 3-3 3', 'M13 15h4'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      clock: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
      external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    }

    function Icon({ name, size = 16, className }) {
      const paths = ICON_PATHS[name] || ICON_PATHS.file
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: name === 'stop' ? 0 : 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        className, 'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d, fill: name === 'stop' ? 'currentColor' : 'none' })))
    }

    function IconButton({ name, title, onClick, active, disabled, size = 16, className, children }) {
      return h('button', {
        type: 'button',
        className: ['ide-iconbtn', active ? 'is-active' : '', className || ''].filter(Boolean).join(' '),
        title,
        'aria-label': title,
        onClick,
        disabled,
        onMouseDown: (event) => event.preventDefault(),
      }, children || h(Icon, { name, size }))
    }

    function Spinner({ size = 14 }) {
      return h('span', { className: 'ide-spinner', style: { width: size, height: size }, 'aria-hidden': true })
    }

    function FileGlyph({ name, size = 14 }) {
      return h('span', { className: `ide-fileglyph tone-${fileTone(name)}` }, h(Icon, { name: 'file', size }))
    }

    // -----------------------------------------------------------------------
    // Syntax highlighting
    // -----------------------------------------------------------------------

    const KEYWORDS = new Set((
      'abstract as async await break case catch class const constructor continue debugger declare default defer delete do ' +
      'else enum export extends false final finally for from function get goto if implements import in instanceof interface ' +
      'let namespace new null of package private protected public readonly return satisfies set static super switch this ' +
      'throw true try type typeof undefined var void while with yield ' +
      'def elif except global lambda nonlocal pass raise ' +
      'fn impl mod mut pub struct trait use where match loop ' +
      'and or not is nil package range select chan go map var ' +
      'public private protected static final synchronized throws volatile transient native ' +
      'select from where insert update delete create table join left right inner outer group order by limit offset ' +
      'echo exit local export unset source alias'
    ).split(/\s+/))

    const TYPE_WORDS = new Set((
      'string number boolean any unknown never object symbol bigint Array Promise Record Partial Pick Omit Readonly ' +
      'int float double char long short byte bool decimal str list dict tuple set void ' +
      'i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize String Vec Option Result'
    ).split(/\s+/))

    const PUNCT = new Set('{}()[];,.:?!+-*/%=<>|&^~@#$\\'.split(''))

    function readQuoted(line, start, quote) {
      let index = start + 1
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2
          continue
        }
        if (line[index] === quote) return index + 1
        index += 1
      }
      return line.length
    }

    function isIdentStart(char) {
      return /[A-Za-z_$]/.test(char)
    }

    function isIdentPart(char) {
      return /[A-Za-z0-9_$]/.test(char)
    }

    function codeLine(line, state, lang) {
      const tokens = []
      let plain = ''
      const flush = () => {
        if (plain) {
          tokens.push(['plain', plain])
          plain = ''
        }
      }
      const push = (type, text) => {
        flush()
        if (text) tokens.push([type, text])
      }

      let index = 0
      if (state.blockComment) {
        const end = line.indexOf('*/')
        if (end < 0) {
          push('com', line)
          return tokens
        }
        push('com', line.slice(0, end + 2))
        index = end + 2
        state.blockComment = false
      }

      if (state.tripleQuote && lang === 'python') {
        const end = line.indexOf('"""')
        if (end < 0) {
          push('str', line)
          return tokens
        }
        push('str', line.slice(0, end + 3))
        index = end + 3
        state.tripleQuote = false
      }

      while (index < line.length) {
        const rest = line.slice(index)
        const char = line[index]

        if (rest.startsWith('/*')) {
          const end = line.indexOf('*/', index + 2)
          if (end < 0) {
            push('com', rest)
            state.blockComment = true
            break
          }
          push('com', line.slice(index, end + 2))
          index = end + 2
          continue
        }

        if (rest.startsWith('//') && ['javascript', 'typescript', 'json', 'go', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'swift', 'dart', 'scss', 'less', 'vue', 'svelte', 'graphql', 'protobuf'].includes(lang)) {
          push('com', rest)
          break
        }

        if (char === '#' && ['python', 'shell', 'yaml', 'toml', 'ini', 'ruby', 'r', 'powershell', 'makefile', 'dockerfile'].includes(lang)) {
          push('com', rest)
          break
        }

        if (rest.startsWith('--') && lang === 'sql') {
          push('com', rest)
          break
        }

        if (lang === 'python' && rest.startsWith('"""')) {
          const end = line.indexOf('"""', index + 3)
          if (end < 0) {
            push('str', rest)
            state.tripleQuote = true
            break
          }
          push('str', line.slice(index, end + 3))
          index = end + 3
          continue
        }

        if (char === '"' || char === "'" || char === '`') {
          const end = readQuoted(line, index, char)
          const text = line.slice(index, end)
          const next = line.slice(end).match(/^\s*:/)
          push(next && lang === 'json' ? 'key' : 'str', text)
          index = end
          continue
        }

        if (char === '#' && /^#[0-9a-fA-F]{3,8}\b/.test(rest) && ['css', 'scss', 'less'].includes(lang)) {
          const match = rest.match(/^#[0-9a-fA-F]{3,8}\b/)
          push('num', match[0])
          index += match[0].length
          continue
        }

        if (/[0-9]/.test(char) && (index === 0 || !/[A-Za-z0-9_$]/.test(line[index - 1]))) {
          const match = rest.match(/^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[a-zA-Z%]+)?/)
          if (match) {
            push('num', match[0])
            index += match[0].length
            continue
          }
        }

        if (isIdentStart(char)) {
          let end = index + 1
          while (end < line.length && isIdentPart(line[end])) end += 1
          const word = line.slice(index, end)
          const after = line.slice(end)
          if (KEYWORDS.has(word)) push('kw', word)
          else if (['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity'].includes(word)) push('lit', word)
          else if (TYPE_WORDS.has(word)) push('type', word)
          else if (lang === 'json' && /^\s*:/.test(after)) push('key', word)
          else if (lang === 'css' || lang === 'scss' || lang === 'less') {
            if (/^\s*:/.test(after)) push('key', word)
            else push('plain', word)
          } else if (/^\s*\(/.test(after)) push('fn', word)
          else plain += word
          index = end
          continue
        }

        if (PUNCT.has(char)) {
          push('punct', char)
          index += 1
          continue
        }

        plain += char
        index += 1
      }

      flush()
      return tokens
    }

    function markupLine(line, state) {
      const tokens = []
      let index = 0
      let plain = ''
      const flush = () => {
        if (plain) {
          tokens.push(['plain', plain])
          plain = ''
        }
      }
      const push = (type, text) => {
        flush()
        if (text) tokens.push([type, text])
      }

      if (state.htmlComment) {
        const end = line.indexOf('-->')
        if (end < 0) {
          push('com', line)
          return tokens
        }
        push('com', line.slice(0, end + 3))
        index = end + 3
        state.htmlComment = false
      }

      while (index < line.length) {
        const rest = line.slice(index)
        if (rest.startsWith('<!--')) {
          const end = line.indexOf('-->', index + 4)
          if (end < 0) {
            push('com', rest)
            state.htmlComment = true
            break
          }
          push('com', line.slice(index, end + 3))
          index = end + 3
          continue
        }

        if (line[index] === '<') {
          let end = index + 1
          let quote = ''
          while (end < line.length) {
            const char = line[end]
            if (quote) {
              if (char === '\\') end += 2
              else {
                if (char === quote) quote = ''
                end += 1
              }
              continue
            }
            if (char === '"' || char === "'") {
              quote = char
              end += 1
              continue
            }
            if (char === '>') {
              end += 1
              break
            }
            end += 1
          }
          const tag = line.slice(index, end)
          const tagMatch = tag.match(/^<\/?\s*([A-Za-z0-9:_-]+)/)
          if (tagMatch) {
            const nameStart = tag.indexOf(tagMatch[1])
            push('punct', tag.slice(0, nameStart))
            push('tag', tagMatch[1])
            const nameEnd = tagMatch[0].length
            let cursor = nameEnd
            while (cursor < tag.length) {
              const attr = tag.slice(cursor).match(/^\s+([A-Za-z_:][A-Za-z0-9:_.-]*)/)
              if (attr) {
                push('plain', attr[0].slice(0, attr[0].length - attr[1].length))
                push('attr', attr[1])
                cursor += attr[0].length
                continue
              }
              const eq = tag.slice(cursor).match(/^\s*=\s*/)
              if (eq) {
                push('punct', eq[0])
                cursor += eq[0].length
                const quote = tag[cursor]
                if (quote === '"' || quote === "'") {
                  const strEnd = readQuoted(tag, cursor, quote)
                  push('str', tag.slice(cursor, strEnd))
                  cursor = strEnd
                }
                continue
              }
              push('punct', tag[cursor])
              cursor += 1
            }
          } else {
            push('punct', tag)
          }
          index = end
          continue
        }

        const next = line.indexOf('<', index)
        if (next < 0) {
          plain += line.slice(index)
          break
        }
        plain += line.slice(index, next)
        index = next
      }

      flush()
      return tokens
    }

    function markdownInline(text) {
      const tokens = []
      const regex = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
      let last = 0
      let match
      while ((match = regex.exec(text))) {
        if (match.index > last) tokens.push(['plain', text.slice(last, match.index)])
        const value = match[0]
        if (value.startsWith('**') || value.startsWith('__')) tokens.push(['head', value.slice(2, -2)])
        else if (value.startsWith('`')) tokens.push(['str', value.slice(1, -1)])
        else {
          const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          tokens.push(['link', link ? link[1] : value])
        }
        last = match.index + value.length
      }
      if (last < text.length) tokens.push(['plain', text.slice(last)])
      return tokens
    }

    function markdownLine(line, state) {
      if (state.fence) {
        if (/^\s*```/.test(line)) {
          state.fence = false
          return [['com', line]]
        }
        return [['str', line]]
      }
      if (/^\s*```/.test(line)) {
        state.fence = true
        return [['com', line]]
      }
      if (/^#{1,6}\s/.test(line)) return [['head', line]]
      if (/^\s*>\s?/.test(line)) return [['com', line]]
      if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
        const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s)(.*)$/)
        return [['kw', match[1]], ...markdownInline(match[2])]
      }
      if (/^\s*\|/.test(line)) return [['plain', line]]
      return markdownInline(line)
    }

    function tokenize(code, language) {
      const lines = String(code ?? '').split('\n')
      if (String(code ?? '').length > 500000) {
        return lines.map((line, index) => ({ number: index + 1, tokens: [['plain', line]] }))
      }
      const state = { blockComment: false, tripleQuote: false, htmlComment: false, fence: false }
      return lines.map((line, index) => {
        let tokens
        if (language === 'markdown') tokens = markdownLine(line, state)
        else if (['html', 'xml', 'vue', 'svelte'].includes(language)) tokens = markupLine(line, state)
        else tokens = codeLine(line, state, language)
        return { number: index + 1, tokens }
      })
    }

    function renderTokens(tokens) {
      return tokens.map(([type, text], index) => (
        type === 'plain' ? text : h('span', { key: index, className: `tok-${type}` }, text)
      ))
    }

    /**
     * Find the bracket pair touched by a caret. This is a visual aid, so it
     * deliberately ignores strings and comments rather than pretending to parse.
     */
    function findBracketPair(text, index) {
      const openers = { '(': ')', '[': ']', '{': '}' }
      const closers = { ')': '(', ']': '[', '}': '{' }
      let position = index
      if (!openers[text[position]] && !closers[text[position]]) {
        position -= 1
        if (position < 0 || (!openers[text[position]] && !closers[text[position]])) return null
      }
      const character = text[position]
      if (openers[character]) {
        const close = openers[character]
        let depth = 0
        for (let cursor = position; cursor < text.length; cursor += 1) {
          if (text[cursor] === character) depth += 1
          else if (text[cursor] === close) {
            depth -= 1
            if (depth === 0) return { open: position, close: cursor }
          }
        }
      } else {
        const open = closers[character]
        let depth = 0
        for (let cursor = position; cursor >= 0; cursor -= 1) {
          if (text[cursor] === character) depth += 1
          else if (text[cursor] === open) {
            depth -= 1
            if (depth === 0) return { open: cursor, close: position }
          }
        }
      }
      return null
    }

    /**
     * Compute the visual selection/caret from character offsets with the same
     * font metrics as the highlighted layer. The native textarea selection is
     * hidden; these rects are what the user actually sees.
     */
    function buildSelectionLayer(text, selectionStart, selectionEnd, fontSpec) {
      if (!fontSpec) return null
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return null
      context.font = fontSpec

      const widths = new Map()
      const measure = (value) => {
        let total = 0
        for (const character of value) {
          let width = widths.get(character)
          if (width === undefined) {
            width = context.measureText(character).width
            widths.set(character, width)
          }
          total += width
        }
        return total
      }
      const expandTabs = (value) => {
        let output = ''
        let column = 0
        for (const character of value) {
          if (character === '\t') {
            const spaces = 2 - (column % 2)
            output += ' '.repeat(spaces)
            column += spaces
          } else {
            output += character
            column += 1
          }
        }
        return output
      }

      const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const sourceLines = normalizedText.split('\n')
      const lineStarts = []
      let offset = 0
      for (const line of sourceLines) {
        lineStarts.push(offset)
        offset += line.length + 1
      }
      const normalizedLength = Math.max(0, offset - 1)
      const start = clamp(Math.min(selectionStart, selectionEnd), 0, normalizedLength)
      const end = clamp(Math.max(selectionStart, selectionEnd), 0, normalizedLength)

      if (start === end) {
        let lineIndex = sourceLines.length - 1
        for (let index = 0; index < sourceLines.length; index += 1) {
          if (start <= lineStarts[index] + sourceLines[index].length) {
            lineIndex = index
            break
          }
        }
        const line = sourceLines[lineIndex] || ''
        const column = clamp(start - lineStarts[lineIndex], 0, line.length)
        const brackets = []
        const pair = findBracketPair(normalizedText, start)
        if (pair) {
          for (const position of [pair.open, pair.close]) {
            let bracketLine = sourceLines.length - 1
            for (let index = 0; index < sourceLines.length; index += 1) {
              if (position <= lineStarts[index] + sourceLines[index].length) {
                bracketLine = index
                break
              }
            }
            const bracketText = sourceLines[bracketLine] || ''
            const bracketColumn = clamp(position - lineStarts[bracketLine], 0, bracketText.length)
            brackets.push({
              line: bracketLine,
              left: measure(expandTabs(bracketText.slice(0, bracketColumn))),
              width: measure(bracketText[bracketColumn] || ''),
            })
          }
        }
        return {
          caret: { line: lineIndex, left: measure(expandTabs(line.slice(0, column))) },
          rects: null,
          brackets,
        }
      }

      const rects = {}
      for (let index = 0; index < sourceLines.length; index += 1) {
        const lineStart = lineStarts[index]
        const lineEnd = lineStart + sourceLines[index].length
        if (lineEnd < start) continue
        if (lineStart > end) break
        const from = Math.max(start, lineStart)
        const to = Math.min(end, lineEnd)
        if (to <= from) continue
        const line = sourceLines[index]
        rects[index] = {
          left: measure(expandTabs(line.slice(0, from - lineStart))),
          width: measure(expandTabs(line.slice(from - lineStart, to - lineStart))),
        }
      }
      return {
        caret: null,
        rects: Object.keys(rects).length > 0 ? rects : null,
        brackets: [],
      }
    }

    // -----------------------------------------------------------------------
    // Editor
    // -----------------------------------------------------------------------

    let codeMirrorPromise = null

    function loadCodeMirror() {
      if (window.DSHCodeMirror) return Promise.resolve(window.DSHCodeMirror)
      if (!codeMirrorPromise) {
        codeMirrorPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script')
          script.src = `${API}/assets/codemirror.js?v=3`
          script.async = true
          script.onload = () => {
            if (window.DSHCodeMirror) resolve(window.DSHCodeMirror)
            else reject(new Error('CodeMirror 资源加载失败'))
          }
          script.onerror = () => reject(new Error('CodeMirror 资源加载失败'))
          document.head.appendChild(script)
        })
      }
      return codeMirrorPromise
    }

    function CodeMirrorEditor({ tab, root, reveal, onChange, onSelection, onSave, onLsp, t }) {
      const hostRef = useRef(null)
      const viewRef = useRef(null)
      const suppressRef = useRef(false)
      const callbacksRef = useRef({})
      const revealRef = useRef(reveal)
      revealRef.current = reveal
      const [loaded, setLoaded] = useState(false)
      const [error, setError] = useState('')
      callbacksRef.current = { onChange, onSelection, onSave, onLsp, root }

      useEffect(() => {
        let live = true
        let view = null
        setLoaded(false)
        setError('')
        loadCodeMirror().then((CM) => {
          if (!live || !hostRef.current) return
          let language = null
          if (tab.language === 'python') language = CM.python()
          else if (tab.language === 'typescript' || tab.language === 'javascript') {
            language = CM.javascript({
              typescript: tab.language === 'typescript',
              jsx: true,
            })
          }
          const theme = CM.EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--ide-bg)', color: 'var(--ide-text)' },
            '.cm-scroller': { fontFamily: 'var(--ide-mono)', fontSize: '12.5px', lineHeight: '1.6' },
            '.cm-content': { caretColor: 'var(--ide-accent)' },
            '.cm-gutters': { backgroundColor: 'var(--ide-panel)', color: 'var(--ide-muted)', border: 'none' },
            '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ide-accent) 4%, transparent)' },
            '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--ide-accent) 6%, transparent)' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
              backgroundColor: 'color-mix(in srgb, var(--ide-accent) 26%, transparent)',
            },
            '.cm-cursor': { borderLeftColor: 'var(--ide-accent)' },
            '.cm-foldPlaceholder': {
              backgroundColor: 'var(--ide-hover)',
              color: 'var(--ide-muted)',
              border: '1px solid var(--ide-border)',
            },
            '.cm-panels': { backgroundColor: 'var(--ide-panel)', color: 'var(--ide-text)' },
            '.cm-tooltip': {
              backgroundColor: 'var(--ide-elevated)',
              border: '1px solid var(--ide-border-strong)',
              color: 'var(--ide-text)',
            },
          }, { dark: true })
          const supportsLanguageService = ['python', 'typescript', 'javascript'].includes(tab.language)
          const completionSource = async (context) => {
            const word = context.matchBefore(/[A-Za-z_$][\w$]*/)
            if (!word || (!context.explicit && word.to - word.from < 2)) return null
            const docText = context.state.doc.toString()
            const line = context.state.doc.lineAt(context.pos)
            try {
              const response = await api('/lsp/completion', {
                method: 'POST',
                body: JSON.stringify({
                  root,
                  path: tab.path,
                  text: docText,
                  line: line.number - 1,
                  character: context.pos - line.from,
                }),
              })
              const items = Array.isArray(response.items) ? response.items : []
              if (items.length === 0) return null
              return {
                from: word.from,
                options: items.map((item) => ({
                  label: String(item.label || ''),
                  detail: String(item.detail || ''),
                  apply: String(item.insertText || item.label || ''),
                })).filter((item) => item.label),
                validFor: /^[A-Za-z_$][\w$]*$/,
              }
            } catch {
              return null
            }
          }
          const diagnosticsSource = async (currentView) => {
            const docText = currentView.state.doc.toString()
            try {
              const response = await api('/lsp/diagnostics', {
                method: 'POST',
                body: JSON.stringify({
                  root,
                  path: tab.path,
                  text: docText,
                }),
              })
              const list = Array.isArray(response.diagnostics) ? response.diagnostics : []
              return list.map((item) => {
                const doc = currentView.state.doc
                const startLine = doc.line(clamp(Number(item.line) || 1, 1, doc.lines))
                const endLine = doc.line(clamp(Number(item.endLine) || Number(item.line) || 1, 1, doc.lines))
                const from = startLine.from + clamp((Number(item.character) || 1) - 1, 0, startLine.length)
                const to = endLine.from + clamp((Number(item.endCharacter) || Number(item.character) || 1) - 1, 0, endLine.length)
                return {
                  from,
                  to: Math.max(from, to),
                  severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : item.severity === 3 ? 'info' : 'hint',
                  message: String(item.message || ''),
                  source: String(item.source || ''),
                }
              })
            } catch {
              return []
            }
          }
          const extensions = [
            CM.basicSetup,
            CM.oneDark,
            CM.foldGutter(),
          ]
          if (supportsLanguageService) {
            extensions.push(
              CM.lintGutter(),
              CM.linter(diagnosticsSource, { delay: 1300 }),
              CM.autocompletion({ override: [completionSource] }),
            )
          }
          extensions.push(
            CM.keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  callbacksRef.current.onSave?.(tab.path)
                  return true
                },
              },
              ...CM.foldKeymap,
              ...CM.defaultKeymap,
              ...CM.historyKeymap,
              ...CM.searchKeymap,
              CM.indentWithTab,
              { key: 'Mod-Alt-ArrowUp', run: CM.addCursorAbove, preventDefault: true },
              { key: 'Mod-Alt-ArrowDown', run: CM.addCursorBelow, preventDefault: true },
              { key: 'Mod-d', run: CM.selectNextOccurrence, preventDefault: true },
            ]),
            CM.EditorView.updateListener.of((update) => {
              if (update.docChanged && !suppressRef.current) {
                callbacksRef.current.onChange?.(update.state.doc.toString())
              }
              if (update.selectionSet || update.docChanged) {
                const range = update.state.selection.main
                callbacksRef.current.onSelection?.(range.from, range.to)
              }
            }),
            CM.EditorView.domEventHandlers({
              mousedown(event, currentView) {
                if (!(event.ctrlKey || event.metaKey)) return false
                const position = currentView.posAtCoords({ x: event.clientX, y: event.clientY })
                if (position == null) return false
                currentView.dispatch({ selection: { anchor: position, head: position } })
                callbacksRef.current.onLsp?.('goToDefinition', position)
                event.preventDefault()
                return true
              },
            }),
            theme,
          )
          if (language) extensions.push(language)
          const state = CM.EditorState.create({ doc: tab.text, extensions })
          view = new CM.EditorView({ state, parent: hostRef.current })
          viewRef.current = view
          setLoaded(true)
          view.focus()
          const initialSelection = view.state.selection.main
          callbacksRef.current.onSelection?.(initialSelection.from, initialSelection.to)
          const pending = revealRef.current
          if (pending && pending.path === tab.path) {
            const position = clamp(pending.index || 0, 0, view.state.doc.length)
            const end = clamp(position + (pending.length || 0), position, view.state.doc.length)
            view.dispatch({
              selection: { anchor: position, head: end },
              scrollIntoView: true,
            })
          }
        }).catch((cause) => {
          if (live) setError(cause.message)
        })
        return () => {
          live = false
          if (view) view.destroy()
          if (viewRef.current === view) viewRef.current = null
        }
      }, [tab.path, tab.language])

      useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const current = view.state.doc.toString()
        if (current === tab.text) return
        suppressRef.current = true
        view.dispatch({
          changes: { from: 0, to: current.length, insert: tab.text },
        })
        suppressRef.current = false
      }, [tab.text])

      useEffect(() => {
        const view = viewRef.current
        if (!view || !reveal || reveal.path !== tab.path) return
        const position = clamp(reveal.index || 0, 0, view.state.doc.length)
        const end = clamp(position + (reveal.length || 0), position, view.state.doc.length)
        view.dispatch({
          selection: { anchor: position, head: end },
          scrollIntoView: true,
        })
        view.focus()
      }, [reveal, tab.path])

      return h('div', { className: 'ide-codemirror-wrap' },
        h('div', { className: 'ide-codemirror', ref: hostRef }),
        !loaded && !error
          ? h('div', { className: 'ide-editor-state' }, h(Spinner, { size: 20 }), h('div', null, t('加载编辑器引擎')))
          : null,
        error ? h('div', { className: 'ide-editor-state is-error' }, h(Icon, { name: 'alert', size: 22 }), h('div', null, error)) : null,
      )
    }

    function Editor({ tab, t, onChange, onSelection, reveal, onSave, onLsp, root }) {
      const textareaRef = useRef(null)
      const highlightRef = useRef(null)
      const gutterRef = useRef(null)
      const [focused, setFocused] = useState(false)
      const [localSelection, setLocalSelection] = useState({ start: 0, end: 0 })
      const [fontSpec, setFontSpec] = useState('')
      const [suggest, setSuggest] = useState(null)
      const suggestSeq = useRef(0)

      const text = tab.text || ''
      const lines = useMemo(() => tokenize(text, tab.language), [text, tab.language])
      const lineCount = lines.length
      const gutterWidth = Math.max(46, String(Math.max(lineCount, 9)).length * 8 + 26)

      const sync = useCallback(() => {
        const area = textareaRef.current
        if (!area) return
        if (highlightRef.current) {
          highlightRef.current.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`
        }
        if (gutterRef.current) {
          gutterRef.current.style.transform = `translateY(${-area.scrollTop}px)`
        }
      }, [])

      useEffect(() => {
        const node = highlightRef.current
        if (!node) return
        const style = window.getComputedStyle(node)
        const area = textareaRef.current
        if (area) {
          area.style.fontFamily = style.fontFamily
          area.style.fontSize = style.fontSize
          area.style.fontStyle = style.fontStyle
          area.style.fontWeight = style.fontWeight
          area.style.lineHeight = style.lineHeight
          area.style.letterSpacing = style.letterSpacing
          area.style.fontFeatureSettings = style.fontFeatureSettings
          area.style.fontVariantLigatures = style.fontVariantLigatures
          area.style.fontKerning = style.fontKerning
          area.style.textRendering = style.textRendering
          area.style.paddingTop = style.paddingTop
          area.style.paddingRight = style.paddingRight
          area.style.paddingBottom = style.paddingBottom
          area.style.paddingLeft = style.paddingLeft
          area.style.tabSize = style.tabSize
        }
        setFontSpec(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`)
      }, [tab.loading, tab.language])

      useEffect(() => {
        const area = textareaRef.current
        if (!area) return
        area.scrollTop = 0
        area.scrollLeft = 0
        area.focus({ preventScroll: true })
        sync()
      }, [tab.path, tab.loading, sync])

      const lastReveal = useRef(0)
      useEffect(() => {
        if (!reveal || reveal.path !== tab.path || reveal.nonce === lastReveal.current) return
        lastReveal.current = reveal.nonce
        const area = textareaRef.current
        if (!area) return
        const position = clamp(reveal.index || 0, 0, text.length)
        const endPosition = clamp(position + (reveal.length || 0), 0, text.length)
        area.focus()
        area.setSelectionRange(position, endPosition)
        const before = text.slice(0, position)
        const line = before.split('\n').length
        area.scrollTop = Math.max(0, (line - 6) * 20)
        area.scrollLeft = 0
        sync()
        setLocalSelection({ start: position, end: endPosition })
        onSelection?.(position, endPosition)
      }, [reveal, tab.path, text, sync, onSelection])

      const reportSelection = useCallback(() => {
        const area = textareaRef.current
        if (!area) return
        const start = area.selectionStart
        const end = area.selectionEnd
        setLocalSelection((previous) => (
          previous.start === start && previous.end === end ? previous : { start, end }
        ))
        onSelection?.(start, end)
      }, [onSelection])

      const selectionLayer = useMemo(
        () => buildSelectionLayer(text, localSelection.start, localSelection.end, fontSpec),
        [text, localSelection, fontSpec],
      )

      const applySuggestion = useCallback((index) => {
        if (!suggest) return
        const item = suggest.items[index]
        if (!item) return
        const area = textareaRef.current
        if (!area) return
        suggestSeq.current += 1
        const end = area.selectionStart
        const insertion = String(item.insertText || item.label || '')
        const next = text.slice(0, suggest.start) + insertion + text.slice(end)
        setSuggest(null)
        onChange(next)
        requestAnimationFrame(() => {
          area.focus()
          const position = suggest.start + insertion.length
          area.setSelectionRange(position, position)
          reportSelection()
        })
      }, [onChange, reportSelection, suggest, text])

      const openSuggestions = useCallback(async () => {
        const area = textareaRef.current
        if (!area) return
        const position = area.selectionStart
        const before = text.slice(0, position)
        const prefixMatch = before.match(/[A-Za-z_$][\w$]*$/)
        const prefix = prefixMatch ? prefixMatch[0] : ''
        const line = before.split('\n').length
        const character = position - before.lastIndexOf('\n')
        const sequence = suggestSeq.current + 1
        suggestSeq.current = sequence
        let semantic = []
        try {
          const response = await api('/lsp/completion', {
            method: 'POST',
            body: JSON.stringify({
              root,
              path: tab.path,
              text,
              line: line - 1,
              character: character - 1,
            }),
          })
          semantic = Array.isArray(response.items) ? response.items : []
        } catch {
          /* fall back to document words */
        }
        if (suggestSeq.current !== sequence || !area.isConnected) return
        if (area.value !== text || area.selectionStart !== position) return

        const words = new Set()
        for (const symbol of extractSymbols(text, tab.language)) words.add(symbol.name)
        for (const match of text.matchAll(/[A-Za-z_$][\w$]{1,60}/g)) words.add(match[0])
        const lower = prefix.toLowerCase()
        const starts = []
        const includes = []
        for (const word of words) {
          if (word === prefix) continue
          if (!lower) starts.push(word)
          else if (word.toLowerCase().startsWith(lower)) starts.push(word)
          else if (word.toLowerCase().includes(lower)) includes.push(word)
        }
        starts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        includes.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        const seen = new Set()
        const items = []
        for (const item of semantic) {
          const label = String(item.label || '')
          if (!label || seen.has(label)) continue
          seen.add(label)
          items.push({ label, insertText: String(item.insertText || label), detail: String(item.detail || '') })
          if (items.length >= 24) break
        }
        for (const word of [...starts, ...includes]) {
          if (seen.has(word)) continue
          seen.add(word)
          items.push({ label: word, insertText: word, detail: '' })
          if (items.length >= 24) break
        }
        if (items.length === 0) {
          setSuggest(null)
          return
        }
        const layer = buildSelectionLayer(text, position, position, fontSpec)
        const caret = layer?.caret || { line: 0, left: 0 }
        const popupHeight = Math.min(190, items.length * 24 + 32)
        let top = 10 + (caret.line + 1) * 20 - (area.scrollTop || 0)
        const viewportHeight = area.clientHeight || 300
        if (top + popupHeight > viewportHeight - 4) {
          top = Math.max(6, 10 + caret.line * 20 - (area.scrollTop || 0) - popupHeight)
        }
        const left = clamp(
          18 + caret.left - (area.scrollLeft || 0),
          6,
          Math.max(6, (area.clientWidth || 320) - 250),
        )
        setSuggest({ items, index: 0, start: position - prefix.length, prefix, left, top })
      }, [fontSpec, root, tab.language, tab.path, text])

      const insert = useCallback((value, selectStart, selectEnd) => {
        const area = textareaRef.current
        if (!area) {
          onChange(text + value)
          return
        }
        const start = area.selectionStart
        const end = area.selectionEnd
        const next = text.slice(0, start) + value + text.slice(end)
        onChange(next)
        requestAnimationFrame(() => {
          area.focus()
          const position = selectStart === undefined ? start + value.length : start + selectStart
          area.setSelectionRange(position, start + (selectEnd === undefined ? value.length : selectEnd))
          reportSelection()
        })
      }, [text, onChange, reportSelection])

      const handleKeyDown = (event) => {
        if (event.nativeEvent?.isComposing) return
        if (suggest) {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSuggest((previous) => previous && ({ ...previous, index: Math.min(previous.items.length - 1, previous.index + 1) }))
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSuggest((previous) => previous && ({ ...previous, index: Math.max(0, previous.index - 1) }))
            return
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            applySuggestion(suggest.index)
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            suggestSeq.current += 1
            setSuggest(null)
            return
          }
          suggestSeq.current += 1
          setSuggest(null)
        }
        if (
          ((event.ctrlKey || event.metaKey) && event.code === 'Space')
          || (event.altKey && event.key === '/')
        ) {
          event.preventDefault()
          openSuggestions()
          return
        }
        const area = textareaRef.current
        if (area && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const start = area.selectionStart
          const end = area.selectionEnd
          const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
          const closers = { ')': '(', ']': '[', '}': '{', '"': '"', "'": "'", '`': '`' }

          if (event.key === 'Backspace' && start === end && start > 0 && start < text.length) {
            const before = text[start - 1]
            const after = text[start]
            if (pairs[before] === after) {
              event.preventDefault()
              const next = text.slice(0, start - 1) + text.slice(start + 1)
              onChange(next)
              requestAnimationFrame(() => {
                area.setSelectionRange(start - 1, start - 1)
                reportSelection()
              })
              return
            }
          }

          if (event.key.length === 1 && pairs[event.key]) {
            event.preventDefault()
            if (start !== end) {
              const selected = text.slice(start, end)
              insert(`${event.key}${selected}${pairs[event.key]}`, 1, 1 + selected.length)
              return
            }
            if (text[start] === event.key && closers[event.key]) {
              area.setSelectionRange(start + 1, start + 1)
              reportSelection()
              return
            }
            insert(`${event.key}${pairs[event.key]}`, 1, 1)
            return
          }

          if (event.key.length === 1 && closers[event.key] && start === end && text[start] === event.key) {
            event.preventDefault()
            area.setSelectionRange(start + 1, start + 1)
            reportSelection()
            return
          }
        }

        if (event.key === 'Tab') {
          event.preventDefault()
          insert('  ')
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const target = textareaRef.current
          if (!target) return
          const start = target.selectionStart
          const end = target.selectionEnd
          if (start !== end) return
          const before = text.slice(0, start)
          const line = before.slice(before.lastIndexOf('\n') + 1)
          const indent = (line.match(/^\s*/) || [''])[0]
          const extra = /[{[(]\s*$/.test(line) ? '  ' : ''
          if (indent || extra) {
            event.preventDefault()
            insert(`\n${indent}${extra}`)
          }
        }
      }

      if (tab.loading) {
        return h('div', { className: 'ide-editor-state' }, h(Spinner, { size: 22 }), h('div', null, t('加载中')))
      }

      if (tab.error) {
        return h('div', { className: 'ide-editor-state is-error' },
          h(Icon, { name: 'alert', size: 28 }),
          h('div', null, tab.error),
          h('button', { type: 'button', className: 'ide-button', onClick: () => onSave?.(tab.path, true) }, t('重试')),
        )
      }

      return h('div', { className: `ide-editor${focused ? ' is-focused' : ''}` },
        h('div', { className: 'ide-gutter', style: { width: gutterWidth } },
          h('div', { className: 'ide-gutter-inner', ref: gutterRef },
            lines.map((line) => h('div', { key: line.number, className: 'ide-gutter-line' }, line.number)),
          ),
        ),
        h('div', { className: 'ide-code' },
          h('pre', { className: 'ide-highlight', ref: highlightRef, 'aria-hidden': true },
            lines.map((line, index) => {
              const rect = selectionLayer && selectionLayer.rects && selectionLayer.rects[index]
              const caret = selectionLayer && selectionLayer.caret
              const brackets = (selectionLayer && selectionLayer.brackets || []).filter((mark) => mark.line === index)
              return h('div', { key: line.number, className: 'ide-code-line' },
                focused && caret && caret.line === index
                  ? h('span', { className: 'ide-active-line' })
                  : null,
                rect ? h('span', {
                  className: 'ide-selection',
                  style: { left: rect.left, width: rect.width },
                }) : null,
                brackets.map((mark, markIndex) => h('span', {
                  key: `bracket-${markIndex}`,
                  className: 'ide-bracket-match',
                  style: { left: mark.left, width: mark.width },
                })),
                h('span', { className: 'ide-line-text' }, renderTokens(line.tokens)),
                focused && caret && caret.line === index
                  ? h('span', { className: 'ide-caret', style: { left: caret.left } })
                  : null,
              )
            }),
          ),
          h('textarea', {
            ref: textareaRef,
            className: `ide-textarea${selectionLayer ? ' has-custom-selection' : ''}${focused && selectionLayer ? ' has-custom-caret' : ''}`,
            value: text,
            spellCheck: false,
            autoCapitalize: 'off',
            autoCorrect: 'off',
            wrap: 'off',
            onChange: (event) => {
              suggestSeq.current += 1
              setSuggest(null)
              onChange(event.target.value)
              reportSelection()
            },
            onScroll: () => {
              suggestSeq.current += 1
              setSuggest(null)
              sync()
            },
            onSelect: reportSelection,
            onKeyUp: reportSelection,
            onClick: (event) => {
              suggestSeq.current += 1
              setSuggest(null)
              reportSelection()
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault()
                onLsp?.('goToDefinition', event.currentTarget.selectionStart)
              }
            },
            onFocus: () => {
              setFocused(true)
              reportSelection()
            },
            onBlur: () => {
              setFocused(false)
              suggestSeq.current += 1
              setSuggest(null)
            },
            onKeyDown: (event) => {
              handleKeyDown(event)
              if (!event.defaultPrevented) requestAnimationFrame(reportSelection)
            },
            'aria-label': tab.name,
          }),
          suggest ? h('div', {
            className: 'ide-suggest',
            style: { left: suggest.left, top: suggest.top },
            onMouseDown: (event) => event.preventDefault(),
          },
          h('div', { className: 'ide-suggest-head' }, t('建议')),
          suggest.items.map((item, index) => h('button', {
            key: item.label,
            type: 'button',
            className: `ide-suggest-row${index === suggest.index ? ' is-selected' : ''}`,
            onMouseDown: (event) => event.preventDefault(),
            onMouseEnter: () => setSuggest((previous) => previous && ({ ...previous, index })),
            onClick: () => applySuggestion(index),
          },
          h('span', { className: 'ide-suggest-label' }, item.label),
          item.detail ? h('span', { className: 'ide-suggest-detail' }, item.detail) : null,
          )),
          ) : null,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Tabs and breadcrumb
    // -----------------------------------------------------------------------

    function TabBar({ tabs, active, dirty, t, onSelect, onClose, onCloseAll }) {
      const scrollerRef = useRef(null)
      useEffect(() => {
        const node = scrollerRef.current?.querySelector('[data-active="true"]')
        node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }, [active, tabs.length])

      if (!tabs.length) return null

      return h('div', { className: 'ide-tabs', ref: scrollerRef },
        tabs.map((tab) => h('div', {
          key: tab.path,
          className: `ide-tab${tab.path === active ? ' is-active' : ''}`,
          'data-active': tab.path === active ? 'true' : 'false',
          title: tab.path,
          onClick: () => onSelect(tab.path),
          onAuxClick: (event) => {
            if (event.button === 1) {
              event.preventDefault()
              onClose(tab.path)
            }
          },
        },
        h(FileGlyph, { name: tab.name, size: 13 }),
        h('span', { className: 'ide-tab-name' }, tab.name),
        dirty.has(tab.path) ? h('span', { className: 'ide-dirty-dot', title: t('未保存') }) : null,
        h('button', {
          type: 'button',
          className: 'ide-tab-close',
          title: t('关闭标签页'),
          onClick: (event) => {
            event.stopPropagation()
            onClose(tab.path)
          },
          onMouseDown: (event) => event.stopPropagation(),
        }, h(Icon, { name: 'close', size: 12 })),
        )),
        h('div', { className: 'ide-tabs-spacer' }),
        h('button', { type: 'button', className: 'ide-tab-action', title: t('关闭所有'), onClick: onCloseAll },
          h(Icon, { name: 'closeAll', size: 14 })),
      )
    }

    function Breadcrumb({ tab, t, onLsp, lspBusy }) {
      if (!tab) return null
      const parts = String(tab.path || '').split('/').filter(Boolean)
      const nodes = []
      let current = ''
      parts.forEach((part, index) => {
        current = current ? `${current}/${part}` : part
        nodes.push(h(Fragment, { key: current },
          index > 0 ? h(Icon, { name: 'chevronRight', size: 12, className: 'ide-crumb-sep' }) : null,
          h('span', { className: index === parts.length - 1 ? 'ide-crumb is-file' : 'ide-crumb' }, part),
        ))
      })
      return h('div', { className: 'ide-breadcrumb', title: tab.path },
        h(Icon, { name: 'folderOpen', size: 13, className: 'ide-crumb-icon' }),
        nodes,
        h('span', { className: 'ide-breadcrumb-spacer' }),
        ['python', 'typescript', 'javascript'].includes(tab.language) ? h('div', { className: 'ide-lsp-actions' },
          lspBusy ? h(Spinner, { size: 11 }) : null,
          h('button', {
            type: 'button',
            className: 'ide-lsp-action',
            title: `${t('转到定义')} (Ctrl+点击)`,
            disabled: lspBusy,
            onClick: () => onLsp?.('goToDefinition'),
          }, t('定义')),
          h('button', {
            type: 'button',
            className: 'ide-lsp-action',
            title: t('查找引用'),
            disabled: lspBusy,
            onClick: () => onLsp?.('findReferences'),
          }, t('引用')),
          h('button', {
            type: 'button',
            className: 'ide-lsp-action',
            title: t('悬停'),
            disabled: lspBusy,
            onClick: () => onLsp?.('hover'),
          }, t('悬停')),
        ) : null,
        tab.text !== tab.original ? h('span', { className: 'ide-breadcrumb-badge' }, t('未保存')) : null,
      )
    }

    // -----------------------------------------------------------------------
    // File explorer
    // -----------------------------------------------------------------------

    function Explorer({
      t, tree, expanded, active, dirty, loading, filter, setFilter, quick, rootTitle,
      onToggleDir, onOpenFile, onContextMenu, onNewFile, onNewFolder, onRefresh, onCollapseAll,
    }) {
      const entries = tree[''] || []
      const filtering = filter.trim().length > 0

      function TreeNode({ node, depth }) {
        const isDir = node.type === 'directory'
        const isOpen = Boolean(expanded[node.rel])
        const children = tree[node.rel]
        const isActive = active === node.rel
        const isDirty = dirty.has(node.rel)
        return h('div', { className: 'ide-tree-node' },
          h('div', {
            className: `ide-tree-row${isActive ? ' is-active' : ''}${isDir ? ' is-dir' : ''}`,
            style: { paddingLeft: 8 + depth * 12 },
            title: node.rel,
            onClick: () => (isDir ? onToggleDir(node.rel) : onOpenFile(node.rel)),
            onContextMenu: (event) => {
              event.preventDefault()
              event.stopPropagation()
              onContextMenu(event, node)
            },
          },
          isDir
            ? h(Icon, { name: isOpen ? 'chevronDown' : 'chevronRight', size: 12, className: 'ide-tree-chevron' })
            : h('span', { className: 'ide-tree-chevron-spacer' }),
          isDir
            ? h(Icon, { name: isOpen ? 'folderOpen' : 'folder', size: 15, className: 'ide-tree-folder' })
            : h(FileGlyph, { name: node.name, size: 13 }),
          h('span', { className: 'ide-tree-name' }, node.name),
          isDirty ? h('span', { className: 'ide-dirty-dot' }) : null,
          ),
          isDir && isOpen
            ? (children
              ? h('div', { className: 'ide-tree-children' },
                children.map((child) => h(TreeNode, { key: child.rel, node: child, depth: depth + 1 })))
              : h('div', { className: 'ide-tree-loading', style: { paddingLeft: 20 + depth * 12 } }, h(Spinner, { size: 11 })))
            : null,
        )
      }

      return h('div', { className: 'ide-explorer' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'folder', size: 14 }),
            h('span', null, rootTitle || t('资源管理器')),
          ),
          h('div', { className: 'ide-side-actions' },
            h(IconButton, { name: 'filePlus', title: t('新建文件'), size: 14, onClick: onNewFile }),
            h(IconButton, { name: 'folderPlus', title: t('新建文件夹'), size: 14, onClick: onNewFolder }),
            h(IconButton, { name: 'collapse', title: t('折叠全部'), size: 14, onClick: onCollapseAll }),
            h(IconButton, { name: 'refresh', title: t('刷新'), size: 14, onClick: onRefresh }),
          ),
        ),
        h('div', { className: 'ide-explorer-filter' },
          h(Icon, { name: 'search', size: 13 }),
          h('input', {
            value: filter,
            placeholder: t('按名称搜索文件…'),
            onChange: (event) => setFilter(event.target.value),
            spellCheck: false,
          }),
          filter ? h('button', {
            type: 'button', className: 'ide-mini-clear', title: t('清空'),
            onClick: () => setFilter(''),
          }, h(Icon, { name: 'close', size: 11 })) : null,
        ),
        h('div', { className: 'ide-explorer-scroll' },
          filtering
            ? (quick.length
              ? h('div', { className: 'ide-quick-list' },
                quick.map((item) => h('button', {
                  key: item.path,
                  type: 'button',
                  className: 'ide-quick-row',
                  onClick: () => onOpenFile(item.path),
                  title: item.path,
                },
                h(FileGlyph, { name: item.path, size: 13 }),
                h('span', { className: 'ide-quick-name' }, basename(item.path)),
                h('span', { className: 'ide-quick-dir' }, dirname(item.path)),
                )))
              : h('div', { className: 'ide-empty-small' }, t('无匹配文件')))
            : (loading && entries.length === 0
              ? h('div', { className: 'ide-tree-skeleton' }, Array.from({ length: 7 }).map((_, index) => h('div', { key: index, className: 'ide-skeleton-row', style: { width: `${52 + (index % 4) * 11}%` } })))
              : (entries.length
                ? h('div', { className: 'ide-tree' }, entries.map((node) => h(TreeNode, { key: node.rel, node, depth: 0 })))
                : h('div', { className: 'ide-empty-small' }, t('工作区中没有匹配的文件')))),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Outline
    // -----------------------------------------------------------------------

    function OutlinePanel({ t, tab, onOpenLine }) {
      const symbols = useMemo(() => (
        tab ? extractSymbols(tab.text, tab.language) : []
      ), [tab && tab.text, tab && tab.language])

      return h('div', { className: 'ide-outline-panel' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'list', size: 14 }),
            h('span', null, t('大纲')),
          ),
          tab ? h('span', { className: 'ide-outline-file', title: tab.path }, tab.name) : null,
        ),
        !tab
          ? h('div', { className: 'ide-outline-empty' }, h(Icon, { name: 'list', size: 24 }), t('打开文件查看大纲'))
          : (symbols.length === 0
            ? h('div', { className: 'ide-outline-empty' }, h(Icon, { name: 'list', size: 24 }), t('没有可显示的符号'))
            : h('div', { className: 'ide-outline-list' }, symbols.map((symbol, index) => h('button', {
              key: `${symbol.line}:${symbol.name}:${index}`,
              type: 'button',
              className: 'ide-outline-row',
              style: { paddingLeft: 10 + symbol.indent * 11 },
              title: `${symbol.name} : ${symbol.line}`,
              onClick: () => onOpenLine(symbol.line),
            },
            h('span', { className: `ide-outline-kind is-${symbol.kind}` },
              symbol.kind === 'heading' ? '#' : symbol.kind === 'class' ? 'C' : symbol.kind === 'variable' ? 'V' : 'ƒ'),
            h('span', { className: 'ide-outline-name' }, symbol.name),
            h('span', { className: 'ide-outline-line' }, symbol.line),
            )))),
      )
    }

    // -----------------------------------------------------------------------
    // Problems
    // -----------------------------------------------------------------------

    function ProblemsPanel({ t, tab, diagnostics, busy, onOpen }) {
      const errors = diagnostics.filter((item) => item.severity === 1).length
      const warnings = diagnostics.filter((item) => item.severity === 2).length
      return h('div', { className: 'ide-problems-panel' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'alert', size: 14 }),
            h('span', null, t('问题')),
          ),
          h('span', { className: 'ide-problems-counts' },
            busy ? h(Spinner, { size: 11 }) : null,
            errors > 0 ? h('span', { className: 'is-error' }, `${errors}`) : null,
            warnings > 0 ? h('span', { className: 'is-warn' }, `${warnings}`) : null,
          ),
        ),
        !tab
          ? h('div', { className: 'ide-outline-empty' }, h(Icon, { name: 'alert', size: 24 }), t('打开文件查看问题'))
          : (diagnostics.length === 0
            ? h('div', { className: 'ide-outline-empty' },
              busy ? h(Spinner, { size: 24 }) : h(Icon, { name: 'check', size: 24 }),
              busy ? t('正在分析') : t('没有发现问题'))
            : h('div', { className: 'ide-problems-list' }, diagnostics.map((item, index) => h('button', {
              key: `${item.line}:${item.character}:${index}`,
              type: 'button',
              className: `ide-problem-row severity-${item.severity}`,
              title: item.message,
              onClick: () => onOpen(item),
            },
            h('span', { className: 'ide-problem-dot' }),
            h('span', { className: 'ide-problem-body' },
              h('span', { className: 'ide-problem-message' }, item.message),
              h('span', { className: 'ide-problem-meta' },
                `${item.line}:${item.character}`,
                item.code ? ` · ${item.code}` : '',
                item.source ? ` · ${item.source}` : '',
              ),
            ),
            )))),
      )
    }

    // -----------------------------------------------------------------------
    // Checkpoints
    // -----------------------------------------------------------------------

    function HistoryPanel({ t, history, onRestore, onClear }) {
      return h('div', { className: 'ide-history-panel' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'clock', size: 14 }),
            h('span', null, t('检查点')),
          ),
          history.length > 0
            ? h('button', { type: 'button', className: 'ide-history-clear', onClick: onClear }, t('清空'))
            : null,
        ),
        history.length === 0
          ? h('div', { className: 'ide-outline-empty' },
            h(Icon, { name: 'clock', size: 24 }),
            t('AI 修改或磁盘重载前会自动保存检查点'))
          : h('div', { className: 'ide-history-list' }, history.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            className: 'ide-history-row',
            title: `${entry.path} · ${new Date(entry.at).toLocaleString()}`,
            onClick: () => onRestore(entry),
          },
          h('span', { className: 'ide-history-label' }, entry.label),
          h('span', { className: 'ide-history-name' }, entry.name),
          h('span', { className: 'ide-history-time' }, new Date(entry.at).toLocaleTimeString()),
          ))),
      )
    }

    // -----------------------------------------------------------------------
    // Search and replace
    // -----------------------------------------------------------------------

    function SearchPanel({ t, root, active, notify, confirm, onOpenHit, onReplaced }) {
      const [query, setQuery] = useState('')
      const [replacement, setReplacement] = useState('')
      const [showReplace, setShowReplace] = useState(false)
      const [showInclude, setShowInclude] = useState(false)
      const [include, setInclude] = useState('')
      const [regex, setRegex] = useState(false)
      const [caseSensitive, setCaseSensitive] = useState(false)
      const [wholeWord, setWholeWord] = useState(false)
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [collapsed, setCollapsed] = useState({})
      const seq = useRef(0)
      const inputRef = useRef(null)

      useEffect(() => {
        if (active) requestAnimationFrame(() => inputRef.current?.focus())
      }, [active])

      const run = useCallback(async () => {
        const needle = query.trim()
        if (!needle || !root) {
          setResult(null)
          return
        }
        const id = ++seq.current
        setBusy(true)
        try {
          const data = await api('/search', {
            method: 'POST',
            body: JSON.stringify({ root, query: needle, regex, caseSensitive, wholeWord, include }),
          })
          if (id === seq.current) setResult(data)
        } catch (error) {
          if (id === seq.current) notify(error.message, 'error')
        } finally {
          if (id === seq.current) setBusy(false)
        }
      }, [query, root, regex, caseSensitive, wholeWord, include, notify])

      useEffect(() => {
        const needle = query.trim()
        if (!needle) {
          setResult(null)
          return undefined
        }
        const timer = setTimeout(() => { run() }, 380)
        return () => clearTimeout(timer)
      }, [query, regex, caseSensitive, wholeWord, include, root, run])

      const replaceOne = async (group, match) => {
        if (busy) return
        setBusy(true)
        try {
          await api('/replace', {
            method: 'POST',
            body: JSON.stringify({
              root, path: group.path, index: match.index, length: match.length,
              match: match.match, replacement,
            }),
          })
          notify(t('已替换 {count}', { count: 1 }), 'success')
          await run()
          onReplaced?.([group.path])
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const replaceAll = () => {
        const total = result?.total || 0
        if (!total) {
          notify(t('没有可替换的内容'), 'warn')
          return
        }
        confirm({
          title: t('确认替换全部'),
          message: `${t('这将修改所有匹配位置，操作不可撤销。')} (${total} ${t('处匹配')})`,
          confirmLabel: t('全部替换'),
          danger: true,
          run: async () => {
            const data = await api('/replace', {
              method: 'POST',
              body: JSON.stringify({ root, query: query.trim(), replacement, regex, caseSensitive, wholeWord, include }),
            })
            notify(t('已替换 {count}', { count: data.count || 0 }), 'success')
            await run()
            onReplaced?.((data.changed || []).map((entry) => entry.path))
          },
        })
      }

      const groups = result?.groups || []
      const total = result?.total || 0
      const fileCount = groups.length

      return h('div', { className: 'ide-search-panel' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'search', size: 14 }),
            h('span', null, t('代码搜索')),
          ),
          h('div', { className: 'ide-side-actions' },
            h(IconButton, { name: 'replace', title: t('替换'), size: 14, active: showReplace, onClick: () => setShowReplace((value) => !value) }),
            h(IconButton, { name: 'collapse', title: t('折叠全部'), size: 14, onClick: () => setCollapsed(Object.fromEntries(groups.map((group) => [group.path, true]))) }),
          ),
        ),
        h('div', { className: 'ide-search-form' },
          h('div', { className: 'ide-search-field' },
            h('div', { className: 'ide-search-input-row' },
              h(Icon, { name: 'search', size: 14 }),
              h('input', {
                ref: inputRef,
                value: query,
                placeholder: t('搜索内容'),
                spellCheck: false,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    run()
                  }
                },
              }),
              h('div', { className: 'ide-search-toggles' },
                h('button', {
                  type: 'button', className: `ide-toggle${caseSensitive ? ' is-on' : ''}`,
                  title: t('区分大小写'), 'aria-pressed': caseSensitive,
                  onClick: () => setCaseSensitive((value) => !value),
                }, 'Aa'),
                h('button', {
                  type: 'button', className: `ide-toggle${wholeWord ? ' is-on' : ''}`,
                  title: t('全字匹配'), 'aria-pressed': wholeWord,
                  onClick: () => setWholeWord((value) => !value),
                }, 'W'),
                h('button', {
                  type: 'button', className: `ide-toggle${regex ? ' is-on' : ''}`,
                  title: t('正则表达式'), 'aria-pressed': regex,
                  onClick: () => setRegex((value) => !value),
                }, '.*'),
              ),
            ),
            showReplace ? h('div', { className: 'ide-search-input-row is-replace' },
              h(Icon, { name: 'replace', size: 14 }),
              h('input', {
                value: replacement,
                placeholder: t('替换为'),
                spellCheck: false,
                onChange: (event) => setReplacement(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    replaceAll()
                  }
                },
              }),
              h('button', {
                type: 'button', className: 'ide-search-all', title: t('全部替换'),
                onClick: replaceAll, disabled: busy || total === 0,
              }, h(Icon, { name: 'check', size: 13 })),
            ) : null,
            h('button', {
              type: 'button', className: 'ide-include-toggle',
              onClick: () => setShowInclude((value) => !value),
            }, h(Icon, { name: showInclude ? 'chevronDown' : 'chevronRight', size: 11 }), t('文件筛选')),
            showInclude ? h('div', { className: 'ide-search-include' },
              h('input', {
                value: include,
                placeholder: t('例如 src/**/*.ts'),
                spellCheck: false,
                onChange: (event) => setInclude(event.target.value),
              })) : null,
          ),
        ),
        h('div', { className: 'ide-search-summary' },
          busy ? h(Spinner, { size: 12 }) : null,
          h('span', null, result
            ? `${total} ${t('处匹配')} · ${fileCount} ${t('个文件')}`
            : t('开始输入以搜索整个工作区')),
          result?.truncated ? h('span', { className: 'ide-search-truncated' }, '…') : null,
        ),
        h('div', { className: 'ide-search-results' },
          groups.length === 0 && result && !busy
            ? h('div', { className: 'ide-empty-small' }, t('没有匹配'))
            : groups.map((group) => h('div', { key: group.path, className: 'ide-result-group' },
              h('button', {
                type: 'button', className: 'ide-result-file',
                onClick: () => setCollapsed((prev) => ({ ...prev, [group.path]: !prev[group.path] })),
                title: group.path,
              },
              h(Icon, { name: collapsed[group.path] ? 'chevronRight' : 'chevronDown', size: 12 }),
              h(FileGlyph, { name: group.path, size: 13 }),
              h('span', { className: 'ide-result-file-name' }, basename(group.path)),
              h('span', { className: 'ide-result-file-dir' }, dirname(group.path)),
              h('span', { className: 'ide-result-count' }, group.matches.length),
              ),
              collapsed[group.path] ? null : h('div', { className: 'ide-result-matches' },
                group.matches.map((match, index) => h('div', {
                  key: `${group.path}:${match.index}:${index}`,
                  className: 'ide-result-row',
                  onClick: () => onOpenHit(group.path, match.index, match.length),
                  title: `${group.path}:${match.line}:${match.column}`,
                },
                h('span', { className: 'ide-result-loc' }, `${match.line}:${match.column}`),
                h('span', { className: 'ide-result-preview' },
                  match.before,
                  h('mark', { className: 'ide-result-mark' }, match.match),
                  match.after,
                ),
                h('button', {
                  type: 'button',
                  className: 'ide-result-replace',
                  title: t('替换此处的匹配'),
                  onClick: (event) => {
                    event.stopPropagation()
                    replaceOne(group, match)
                  },
                }, h(Icon, { name: 'replace', size: 12 })),
                )),
              ))),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Markdown rendering for the assistant
    // -----------------------------------------------------------------------

    function inlineNodes(text) {
      const parts = String(text).split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
      return parts.map((part, index) => {
        if (!part) return null
        if (part.startsWith('**') || part.startsWith('__')) {
          return h('strong', { key: index }, part.slice(2, -2))
        }
        if (part.startsWith('`')) {
          return h('code', { key: index, className: 'ide-inline-code' }, part.slice(1, -1))
        }
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (link) {
          const safe = /^https?:\/\//i.test(link[2])
          return h('a', {
            key: index,
            className: 'ide-md-link',
            href: safe ? link[2] : '#',
            target: safe ? '_blank' : undefined,
            rel: 'noreferrer noopener',
            onClick: safe ? undefined : (event) => event.preventDefault(),
          }, link[1])
        }
        return part
      })
    }

    function CodeBlock({ lang, code, t, onApply, onApplyPatch }) {
      const [copied, setCopied] = useState(false)
      const isPatch = /^dsh-patch\b/i.test(String(lang || '').trim())
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        } catch {
          /* clipboard unavailable */
        }
      }
      return h('div', { className: 'ide-codeblock' },
        h('div', { className: 'ide-codeblock-head' },
          h('span', { className: 'ide-codeblock-lang' }, isPatch ? t('多文件补丁') : (lang || t('代码'))),
          h('div', { className: 'ide-codeblock-actions' },
            h('button', { type: 'button', onClick: copy, title: t('复制代码') },
              h(Icon, { name: copied ? 'check' : 'copy', size: 12 }),
              h('span', null, copied ? t('已复制') : t('复制'))),
            isPatch && onApplyPatch ? h('button', { type: 'button', className: 'is-primary', onClick: () => onApplyPatch(code), title: t('应用多文件补丁') },
              h(Icon, { name: 'insert', size: 12 }),
              h('span', null, t('应用多文件'))) : null,
            !isPatch && onApply ? h('button', { type: 'button', className: 'is-primary', onClick: () => onApply(code), title: t('应用代码') },
              h(Icon, { name: 'insert', size: 12 }),
              h('span', null, t('应用'))) : null,
          ),
        ),
        h('pre', { className: 'ide-codeblock-body' }, h('code', null, code)),
      )
    }

    function Markdown({ text, t, onApply, onApplyPatch }) {
      const blocks = useMemo(() => {
        const lines = String(text || '').split('\n')
        const output = []
        let index = 0
        let key = 0
        while (index < lines.length) {
          const line = lines[index]
          if (/^\s*```/.test(line)) {
            const lang = line.replace(/^\s*```/, '').trim()
            index += 1
            const code = []
            while (index < lines.length && !/^\s*```/.test(lines[index])) {
              code.push(lines[index])
              index += 1
            }
            if (index < lines.length) index += 1
            output.push(h(CodeBlock, { key: key++, lang, code: code.join('\n'), t, onApply, onApplyPatch }))
            continue
          }
          const heading = line.match(/^(#{1,4})\s+(.*)$/)
          if (heading) {
            const level = heading[1].length
            output.push(h(`h${level + 2}`, { key: key++, className: 'ide-md-heading' }, inlineNodes(heading[2])))
            index += 1
            continue
          }
          if (/^\s*[-*+]\s+/.test(line)) {
            const items = []
            while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
              items.push(h('li', { key: index }, inlineNodes(lines[index].replace(/^\s*[-*+]\s+/, ''))))
              index += 1
            }
            output.push(h('ul', { key: key++, className: 'ide-md-list' }, items))
            continue
          }
          if (/^\s*\d+\.\s+/.test(line)) {
            const items = []
            while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
              items.push(h('li', { key: index }, inlineNodes(lines[index].replace(/^\s*\d+\.\s+/, ''))))
              index += 1
            }
            output.push(h('ol', { key: key++, className: 'ide-md-list' }, items))
            continue
          }
          if (/^\s*>\s?/.test(line)) {
            const quote = []
            while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
              quote.push(lines[index].replace(/^\s*>\s?/, ''))
              index += 1
            }
            output.push(h('blockquote', { key: key++, className: 'ide-md-quote' }, inlineNodes(quote.join(' '))))
            continue
          }
          if (!line.trim()) {
            index += 1
            continue
          }
          const paragraph = [line]
          index += 1
          while (index < lines.length && lines[index].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+\.\s|>)/.test(lines[index])) {
            paragraph.push(lines[index])
            index += 1
          }
          output.push(h('p', { key: key++, className: 'ide-md-p' }, inlineNodes(paragraph.join('\n'))))
        }
        return output
      }, [text, t, onApply])

      return h('div', { className: 'ide-markdown' }, blocks.length ? blocks : h('span', { className: 'ide-muted' }, '…'))
    }

    function ChatMessage({ message, t, onApply, onApplyPatch }) {
      if (message.role === 'user') {
        return h('div', { className: 'ide-msg is-user' },
          h('div', { className: 'ide-msg-bubble' }, message.content),
        )
      }
      return h('div', { className: 'ide-msg is-assistant' },
        h('div', { className: 'ide-msg-avatar' }, h(Icon, { name: 'sparkle', size: 14 })),
        h('div', { className: 'ide-msg-main' },
          h('div', { className: 'ide-msg-role' },
            h('span', null, t('AI 助手')),
            message.streaming ? h('span', { className: 'ide-msg-live' }, t('生成中')) : null,
          ),
          message.reasoning && message.reasoning.trim()
            ? h('details', { className: 'ide-reasoning' },
              h('summary', null, h(Icon, { name: 'sparkle', size: 11 }), t('思考过程')),
              h('pre', null, message.reasoning))
            : null,
          message.content
            ? h(Markdown, { text: message.content, t, onApply, onApplyPatch })
            : (message.streaming ? h('div', { className: 'ide-typing' }, h('span'), h('span'), h('span')) : null),
          message.error ? h('div', { className: 'ide-msg-error' }, h(Icon, { name: 'alert', size: 12 }), message.error) : null,
          message.usage ? h('div', { className: 'ide-msg-usage' },
            `${message.usage.inputTokens || 0} in · ${message.usage.outputTokens || 0} out`) : null,
        ),
      )
    }

    class ChatErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('IDE chat render failed', error, info)
      }

      render() {
        if (this.state.error) {
          return h('div', {
            className: 'ide-chat is-crashed',
            style: { width: this.props.open ? this.props.width : 0, display: this.props.open ? 'flex' : 'none' },
          },
          h(Icon, { name: 'alert', size: 22 }),
          h('div', { className: 'ide-chat-crash-title' }, 'AI 面板渲染失败'),
          h('pre', { className: 'ide-chat-crash-message' }, String(this.state.error?.message || this.state.error || '')),
          h('button', {
            type: 'button',
            className: 'ide-button',
            onClick: () => this.setState({ error: null }),
          }, '重试'),
          )
        }
        return this.props.children
      }
    }

    function ModelConfigModal({ modal, t, onClose }) {
      const entries = useMemo(() => (
        (modal.configurable || []).filter((entry) => (
          entry.settingsNs !== 'llm-deepseek-account'
          && Array.isArray(entry.nativeAuth?.env)
          && entry.nativeAuth.env.length > 0
        ))
      ), [modal.configurable])
      const [provider, setProvider] = useState(() => (
        entries.find((entry) => entry.provider === 'deepseek')?.provider || entries[0]?.provider || ''
      ))
      const entry = entries.find((item) => item.provider === provider)
      const [apiKey, setApiKey] = useState('')
      const [baseURL, setBaseURL] = useState(entry?.defaultBaseURL || '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const chooseProvider = (next) => {
        setProvider(next)
        const found = entries.find((item) => item.provider === next)
        setBaseURL(found?.defaultBaseURL || '')
      }

      const save = async () => {
        if (!provider || !apiKey.trim()) {
          setError(t('请填写 API Key'))
          return
        }
        setBusy(true)
        setError('')
        try {
          await api('/model-config/provider', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              apiKey: apiKey.trim(),
              baseURL: entry?.settingsNs === 'llm-pi-ai' ? baseURL.trim() : '',
            }),
          })
          await modal.onSaved?.()
          onClose()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'ide-button', onClick: onClose }, t('取消')),
          h('button', { key: 'save', type: 'button', className: 'ide-button is-primary', onClick: save, disabled: busy },
            busy ? h(Spinner, { size: 12 }) : null, t('保存并刷新模型')),
        ],
      },
      h('div', { className: 'ide-config-form' },
        h('label', null,
          h('span', null, 'Provider'),
          h('select', {
            value: provider,
            onChange: (event) => chooseProvider(event.target.value),
          }, entries.map((item) => h('option', { key: item.provider, value: item.provider }, item.displayName || item.provider))),
        ),
        h('label', null,
          h('span', null, 'API Key'),
          h('input', {
            type: 'password',
            value: apiKey,
            autoComplete: 'off',
            placeholder: entry?.nativeAuth?.env?.[0] || 'sk-…',
            onChange: (event) => setApiKey(event.target.value),
          }),
        ),
        entry?.settingsNs === 'llm-pi-ai'
          ? h('label', null,
            h('span', null, 'Base URL'),
            h('input', {
              type: 'text',
              value: baseURL,
              placeholder: entry?.defaultBaseURL || 'https://api.example.com/v1',
              onChange: (event) => setBaseURL(event.target.value),
            }),
          )
          : null,
        h('div', { className: 'ide-config-hint' },
          t('API Key 会写入 DSH 凭证服务，不保存在浏览器里。保存后会自动刷新可选模型。')),
        error ? h('div', { className: 'ide-form-error' }, error) : null,
      ),
      )
    }

    // -----------------------------------------------------------------------
    // AI chat panel
    // -----------------------------------------------------------------------

    function ChatPanel({ t, root, tab, cursor, model, width, open, onClose, onApply, onApplyPatch, notify, showModal }) {
      const [messages, setMessages] = useState(() => {
        const saved = Array.isArray(ideMemory.chatMessages) ? ideMemory.chatMessages : []
        return saved.map((message) => (message.streaming ? { ...message, streaming: false, stopped: true } : message))
      })
      const [input, setInput] = useState('')
      const [includeFile, setIncludeFile] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [catalog, setCatalog] = useState({ providers: [], current: null, configurable: [] })
      const [selectedModel, setSelectedModel] = useState(() => ideMemory.chatModel || null)
      const [modelsBusy, setModelsBusy] = useState(false)
      const messagesRef = useRef([])
      const scrollRef = useRef(null)
      const inputRef = useRef(null)
      const abortRef = useRef(null)
      const idRef = useRef(0)

      const loadModels = useCallback(async () => {
        setModelsBusy(true)
        try {
          const data = await api('/models')
          setCatalog(data)
          setSelectedModel((previous) => {
            if (previous) return previous
            return data.current || model || null
          })
        } catch {
          /* the chat still works with the default model */
        } finally {
          setModelsBusy(false)
        }
      }, [model])

      useEffect(() => {
        if (open) loadModels()
      }, [open, loadModels])

      useEffect(() => {
        if (selectedModel) ideMemory.chatModel = selectedModel
      }, [selectedModel])

      useEffect(() => { messagesRef.current = messages }, [messages])

      useEffect(() => {
        ideMemory.chatMessages = messages.slice(-60)
      }, [messages])

      useEffect(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messages, busy])

      useEffect(() => {
        const node = inputRef.current
        if (!node) return
        node.style.height = '0px'
        node.style.height = `${Math.min(148, node.scrollHeight)}px`
      }, [input])

      useEffect(() => () => abortRef.current?.abort(), [])

      const nextId = () => `m${Date.now().toString(36)}${(idRef.current += 1).toString(36)}`

      const patchAssistant = (id, updater) => {
        setMessages((previous) => {
          const next = previous.map((message) => (message.id === id ? updater(message) : message))
          messagesRef.current = next
          return next
        })
      }

      const send = async (preset) => {
        const text = String(preset ?? input).trim()
        if (!text || busy || !root) return
        const userId = nextId()
        const assistantId = nextId()
        const user = { id: userId, role: 'user', content: text }
        const assistant = { id: assistantId, role: 'assistant', content: '', reasoning: '', streaming: true }
        const history = [...messagesRef.current, user].map((message) => ({ role: message.role, content: message.content }))
        const selection = tab && cursor.path === tab.path && cursor.end > cursor.start
          ? tab.text.slice(cursor.start, cursor.end).slice(0, 8000)
          : ''
        const context = {
          path: tab?.path,
          language: tab?.language,
          includeFile,
          selection,
        }
        setMessages([...messagesRef.current, user, assistant])
        messagesRef.current = [...messagesRef.current, user, assistant]
        setInput('')
        setBusy(true)
        setError('')
        const controller = new AbortController()
        abortRef.current = controller

        try {
          await ensureToken()
          const chatOptions = {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-ide-token': TOKEN },
            body: JSON.stringify({ root, messages: history, context, ...(selectedModel ? { model: selectedModel } : {}) }),
            signal: controller.signal,
          }
          let response = await fetch(`${API}/chat`, chatOptions)
          if (response.status === 403) {
            TOKEN = ''
            await ensureToken(true)
            chatOptions.headers['x-dsh-ide-token'] = TOKEN
            response = await fetch(`${API}/chat`, chatOptions)
          }
          if (!response.ok) {
            let message = response.statusText || t('请求失败')
            try {
              const body = await response.json()
              message = body.error || message
            } catch {
              /* non-JSON error */
            }
            throw new Error(message)
          }
          const reader = response.body?.getReader()
          if (!reader) throw new Error(t('网络错误'))
          const decoder = new TextDecoder()
          let buffer = ''
          let finished = false

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf('\n')
              if (!line) continue
              let event
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }
              if (event.type === 'delta') {
                patchAssistant(assistantId, (message) => ({ ...message, content: message.content + event.text }))
              } else if (event.type === 'reasoning') {
                patchAssistant(assistantId, (message) => ({ ...message, reasoning: (message.reasoning || '') + event.text }))
              } else if (event.type === 'usage') {
                patchAssistant(assistantId, (message) => ({ ...message, usage: event.usage }))
              } else if (event.type === 'error') {
                finished = true
                setError(event.message)
                patchAssistant(assistantId, (message) => ({ ...message, streaming: false, error: event.message }))
              } else if (event.type === 'done') {
                finished = true
                patchAssistant(assistantId, (message) => ({ ...message, streaming: false }))
              }
            }
          }

          if (!finished) patchAssistant(assistantId, (message) => ({ ...message, streaming: false }))
        } catch (cause) {
          if (cause.name === 'AbortError') {
            patchAssistant(assistantId, (message) => ({ ...message, streaming: false, stopped: true }))
          } else {
            setError(cause.message)
            patchAssistant(assistantId, (message) => ({ ...message, streaming: false, error: cause.message }))
            notify(cause.message, 'error')
          }
        } finally {
          setBusy(false)
          abortRef.current = null
          patchAssistant(assistantId, (message) => (message.streaming ? { ...message, streaming: false } : message))
        }
      }

      const stop = () => {
        abortRef.current?.abort()
      }

      const clear = () => {
        abortRef.current?.abort()
        setMessages([])
        messagesRef.current = []
        setError('')
        notify(t('会话已清空'), 'success')
      }

      const starters = [
        { key: '让 AI 解释当前文件', icon: 'file' },
        { key: '为选中代码添加注释', icon: 'edit' },
        { key: '生成单元测试', icon: 'check' },
        { key: '重构这段代码', icon: 'code' },
      ]

      const selectedKey = selectedModel ? `${selectedModel.provider}::${selectedModel.model}` : ''
      const modelGroups = (catalog.providers || []).filter((provider) => (provider.models || []).length > 0)
      const selectedExists = modelGroups.some((provider) => (
        (provider.models || []).some((entry) => `${provider.id}::${entry.id}` === selectedKey)
      ))
      const openApiConfig = () => {
        if (!showModal) return
        showModal({
          kind: 'model-config',
          title: t('模型 API 配置'),
          configurable: catalog.configurable || [],
          onSaved: loadModels,
        })
      }

      return h('div', { className: 'ide-chat', style: { width: open ? width : 0, display: open ? 'flex' : 'none' } },
        h('div', { className: 'ide-chat-head' },
          h('div', { className: 'ide-chat-brand' },
            h('span', { className: 'ide-chat-logo' }, h(Icon, { name: 'sparkle', size: 15 })),
            h('div', { className: 'ide-chat-brand-text' },
              h('span', null, t('AI 助手')),
              h('div', { className: 'ide-chat-model-row' },
                h('select', {
                  className: 'ide-chat-model-select',
                  value: selectedKey,
                  disabled: modelsBusy,
                  title: selectedModel ? `${selectedModel.provider} / ${selectedModel.model}` : t('选择模型'),
                  onChange: (event) => {
                    const [provider, ...rest] = event.target.value.split('::')
                    const modelId = rest.join('::')
                    if (provider && modelId) setSelectedModel({ provider, model: modelId })
                  },
                },
                h('option', { value: '' }, modelsBusy ? t('加载模型…') : t('选择模型')),
                ...modelGroups.map((provider) => h('optgroup', { key: provider.id, label: provider.name || provider.id },
                  (provider.models || []).map((entry) => h('option', {
                    key: `${provider.id}::${entry.id}`,
                    value: `${provider.id}::${entry.id}`,
                    title: entry.description || `${provider.id} / ${entry.id}`,
                  }, entry.name || entry.id)))),
                selectedModel && !selectedExists
                  ? h('option', { value: selectedKey }, `${selectedModel.provider} / ${selectedModel.model}`)
                  : null,
                ),
                h('button', {
                  type: 'button',
                  className: 'ide-chat-api',
                  title: t('模型 API 配置'),
                  onClick: openApiConfig,
                }, 'API'),
              ),
            ),
          ),
          h('div', { className: 'ide-chat-actions' },
            h(IconButton, { name: 'trash', title: t('新对话'), size: 14, onClick: clear, disabled: messages.length === 0 }),
            h(IconButton, { name: 'panelRight', title: t('显示/隐藏 AI 面板'), size: 14, onClick: onClose }),
          ),
        ),
        h('div', { className: 'ide-chat-context' },
          tab
            ? h('span', { className: 'ide-context-chip', title: tab.path },
              h(FileGlyph, { name: tab.name, size: 12 }),
              h('span', { className: 'ide-context-name' }, tab.name))
            : h('span', { className: 'ide-context-chip is-empty' }, h(Icon, { name: 'file', size: 12 }), t('无打开的文件')),
          tab && cursor.path === tab.path && cursor.end > cursor.start
            ? h('span', { className: 'ide-context-chip is-selection' },
              `${t('选中')} ${cursor.end - cursor.start} ${t('个字符')}`)
            : null,
          tab ? h('button', {
            type: 'button',
            className: `ide-context-toggle${includeFile ? ' is-on' : ''}`,
            title: t('包含当前文件'),
            onClick: () => setIncludeFile((value) => !value),
          }, h(Icon, { name: includeFile ? 'eye' : 'eyeOff', size: 12 }), t('包含当前文件')) : null,
        ),
        h('div', { className: 'ide-chat-scroll', ref: scrollRef },
          messages.length === 0
            ? h('div', { className: 'ide-chat-empty' },
              h('div', { className: 'ide-chat-empty-icon' }, h(Icon, { name: 'sparkle', size: 22 })),
              h('div', { className: 'ide-chat-empty-title' }, t('开始对话')),
              h('div', { className: 'ide-chat-empty-sub' }, t('AI 可以读取当前文件与选中片段，建议需手动应用。')),
              h('div', { className: 'ide-chat-starters' },
                starters.map((starter) => h('button', {
                  key: starter.key,
                  type: 'button',
                  className: 'ide-starter',
                  onClick: () => send(t(starter.key)),
                }, h(Icon, { name: starter.icon, size: 13 }), t(starter.key))),
              ),
            )
            : messages.map((message) => h(ChatMessage, { key: message.id, message, t, onApply, onApplyPatch })),
          error && !messages.some((message) => message.error === error)
            ? h('div', { className: 'ide-chat-error' }, h(Icon, { name: 'alert', size: 13 }), error)
            : null,
        ),
        h('div', { className: 'ide-chat-composer' },
          h('div', { className: 'ide-chat-input-wrap' },
            h('textarea', {
              ref: inputRef,
              rows: 1,
              value: input,
              placeholder: t('输入问题，向 AI 提问…'),
              spellCheck: false,
              onChange: (event) => setInput(event.target.value),
              onKeyDown: (event) => {
                if (event.nativeEvent?.isComposing) return
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  send()
                }
              },
            }),
            busy
              ? h('button', { type: 'button', className: 'ide-send is-stop', onClick: stop, title: t('停止') }, h(Icon, { name: 'stop', size: 13 }))
              : h('button', { type: 'button', className: 'ide-send', onClick: () => send(), disabled: !input.trim(), title: t('发送') }, h(Icon, { name: 'send', size: 14 })),
          ),
          h('div', { className: 'ide-chat-hint' },
            h('span', null, t('Enter 发送 · Shift+Enter 换行')),
            model || selectedModel ? h('span', null, `${(selectedModel || model).provider} · ${(selectedModel || model).model}`) : h('span', { className: 'is-warn' }, t('未配置模型')),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Source control
    // -----------------------------------------------------------------------

    function GitPanel({ t, root, active, notify, showModal, onOpenFile }) {
      const [status, setStatus] = useState(null)
      const [loading, setLoading] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [sections, setSections] = useState({ staged: true, changes: true })
      const sequence = useRef(0)

      const load = useCallback(async () => {
        if (!root) return
        const id = ++sequence.current
        setLoading(true)
        try {
          const data = await api(`/git/status?root=${encodeURIComponent(root)}`)
          if (id !== sequence.current) return
          setStatus(data)
          setError('')
        } catch (cause) {
          if (id === sequence.current) setError(cause.message)
        } finally {
          if (id === sequence.current) setLoading(false)
        }
      }, [root])

      useEffect(() => {
        if (active) load()
      }, [active, load])

      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => { load() }, 6000)
        return () => clearInterval(timer)
      }, [active, load])

      const applyStatus = (next) => {
        if (next) setStatus(next)
      }

      const stage = async (path) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/stage', {
            method: 'POST',
            body: JSON.stringify({ root, paths: [path] }),
          })
          applyStatus(data.status)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const unstage = async (path) => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/unstage', {
            method: 'POST',
            body: JSON.stringify({ root, paths: [path] }),
          })
          applyStatus(data.status)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const stageAll = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/stage', {
            method: 'POST',
            body: JSON.stringify({ root, paths: (status?.changes || []).filter((c) => c.unstaged || c.untracked).map((c) => c.path) }),
          })
          applyStatus(data.status)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const unstageAll = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/unstage', {
            method: 'POST',
            body: JSON.stringify({ root, paths: (status?.changes || []).filter((c) => c.staged).map((c) => c.path) }),
          })
          applyStatus(data.status)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const commit = async () => {
        if (busy || !message.trim()) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/commit', {
            method: 'POST',
            body: JSON.stringify({ root, message }),
          })
          applyStatus(data.status)
          setMessage('')
          notify(t('提交成功'), 'success')
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const init = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await api('/git/init', {
            method: 'POST',
            body: JSON.stringify({ root }),
          })
          applyStatus(data.status)
          notify(t('Git 仓库已初始化'), 'success')
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const openDiff = (path, staged) => {
        showModal({
          kind: 'diff',
          title: path,
          load: async () => {
            const data = await api(`/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&staged=${staged ? '1' : '0'}`)
            return data.diff || ''
          },
          onOpen: () => onOpenFile(path),
        })
      }

      const staged = (status?.changes || []).filter((change) => change.staged)
      const unstaged = (status?.changes || []).filter((change) => change.unstaged || change.untracked)
      const letterOf = (change, isStaged) => {
        if (change.untracked) return 'U'
        const code = isStaged
          ? (change.indexStatus === ' ' ? change.worktreeStatus : change.indexStatus)
          : (change.worktreeStatus === ' ' ? change.indexStatus : change.worktreeStatus)
        return code === ' ' ? 'M' : code
      }

      const renderFile = (change, isStaged) => h('div', {
        key: `${isStaged ? 's' : 'w'}:${change.path}`,
        className: 'ide-git-file',
        onClick: () => openDiff(change.path, isStaged),
        title: change.path,
      },
      h('span', { className: `ide-git-badge status-${(letterOf(change, isStaged) || 'M').toLowerCase()}` }, letterOf(change, isStaged)),
      h('span', { className: 'ide-git-file-text' },
        h('span', { className: 'ide-git-file-name' }, basename(change.path)),
        h('span', { className: 'ide-git-file-dir' }, dirname(change.path))),
      h('button', {
        type: 'button',
        className: 'ide-git-row-action',
        title: isStaged ? t('取消暂存') : t('暂存'),
        onClick: (event) => {
          event.stopPropagation()
          if (isStaged) unstage(change.path)
          else stage(change.path)
        },
      }, isStaged ? '−' : '+'),
      )

      return h('div', { className: 'ide-git-panel' },
        h('div', { className: 'ide-side-head' },
          h('div', { className: 'ide-side-title' },
            h(Icon, { name: 'branch', size: 14 }),
            h('span', null, t('源代码管理')),
            status?.repo && status.branch ? h('span', { className: 'ide-git-branch' }, status.branch) : null,
          ),
          h('div', { className: 'ide-side-actions' },
            loading ? h(Spinner, { size: 11 }) : null,
            h(IconButton, { name: 'refresh', title: t('刷新'), size: 13, onClick: load, disabled: loading }),
          ),
        ),
        status?.repo
          ? h(Fragment, null,
            h('div', { className: 'ide-git-commit' },
              h('input', {
                value: message,
                placeholder: t('提交信息'),
                spellCheck: false,
                onChange: (event) => setMessage(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commit()
                  }
                },
              }),
              h('button', {
                type: 'button',
                className: 'ide-git-commit-btn',
                disabled: busy || !message.trim() || staged.length === 0,
                onClick: commit,
                title: staged.length === 0 ? t('请先暂存文件') : t('提交'),
              }, busy ? h(Spinner, { size: 11 }) : h(Icon, { name: 'check', size: 13 })),
            ),
            h('div', { className: 'ide-git-scroll' },
              h('div', { className: 'ide-git-section' },
                h('button', {
                  type: 'button',
                  className: 'ide-git-section-head',
                  onClick: () => setSections((previous) => ({ ...previous, staged: !previous.staged })),
                },
                h(Icon, { name: sections.staged ? 'chevronDown' : 'chevronRight', size: 11 }),
                h('span', null, t('已暂存')),
                h('span', { className: 'ide-git-count' }, staged.length),
                staged.length > 0 ? h('span', {
                  className: 'ide-git-section-action',
                  onClick: (event) => {
                    event.stopPropagation()
                    unstageAll()
                  },
                  title: t('取消全部暂存'),
                }, '−') : null,
                ),
                sections.staged ? (staged.length ? staged.map((change) => renderFile(change, true)) : h('div', { className: 'ide-git-empty-small' }, t('没有已暂存的文件'))) : null,
              ),
              h('div', { className: 'ide-git-section' },
                h('button', {
                  type: 'button',
                  className: 'ide-git-section-head',
                  onClick: () => setSections((previous) => ({ ...previous, changes: !previous.changes })),
                },
                h(Icon, { name: sections.changes ? 'chevronDown' : 'chevronRight', size: 11 }),
                h('span', null, t('更改')),
                h('span', { className: 'ide-git-count' }, unstaged.length),
                unstaged.length ? h('span', {
                  className: 'ide-git-section-action',
                  onClick: (event) => {
                    event.stopPropagation()
                    stageAll()
                  },
                  title: t('暂存全部'),
                }, '+') : null,
                ),
                sections.changes ? (unstaged.length ? unstaged.map((change) => renderFile(change, false)) : h('div', { className: 'ide-git-empty-small' }, t('工作区没有更改'))) : null,
              ),
            ),
          )
          : (status
            ? h('div', { className: 'ide-git-empty' },
              h(Icon, { name: 'branch', size: 28 }),
              h('div', { className: 'ide-git-empty-title' }, t('该文件夹不是 Git 仓库')),
              h('div', { className: 'ide-git-empty-sub' }, t('初始化后即可跟踪、暂存和提交更改。')),
              h('button', { type: 'button', className: 'ide-button is-primary', onClick: init, disabled: busy }, busy ? h(Spinner, { size: 12 }) : null, t('初始化 Git 仓库')),
            )
            : h('div', { className: 'ide-git-empty' }, loading ? h(Spinner, { size: 18 }) : null)),
        error ? h('div', { className: 'ide-git-error' }, h(Icon, { name: 'alert', size: 12 }), error) : null,
      )
    }

    // -----------------------------------------------------------------------
    // IDE terminal
    // -----------------------------------------------------------------------

    function TerminalPanel({ t, root, open, height, onClose, notify }) {
      const previousRef = useRef(ideMemory.terminal)
      const initialMemory = ideMemory.terminal && ideMemory.terminal.root === root ? ideMemory.terminal : null
      const [tabs, setTabs] = useState(() => {
        if (initialMemory?.tabs?.length) return initialMemory.tabs
        if (initialMemory?.id) {
          return [{
            id: initialMemory.id,
            title: `${t('终端')} 1`,
            exited: Boolean(initialMemory.exited),
            exitCode: initialMemory.exitCode ?? null,
          }]
        }
        return []
      })
      const [sessionId, setSessionId] = useState(() => (
        ideMemory.terminal && ideMemory.terminal.root === root ? ideMemory.terminal.id : null
      ))
      const [output, setOutput] = useState(() => (
        ideMemory.terminal && ideMemory.terminal.root === root ? ideMemory.terminal.output || '' : ''
      ))
      const [exited, setExited] = useState(() => (
        ideMemory.terminal && ideMemory.terminal.root === root ? Boolean(ideMemory.terminal.exited) : false
      ))
      const [exitCode, setExitCode] = useState(() => (
        ideMemory.terminal && ideMemory.terminal.root === root ? ideMemory.terminal.exitCode ?? null : null
      ))
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [connected, setConnected] = useState(false)
      const [error, setError] = useState('')
      const [history, setHistory] = useState([])
      const [historyIndex, setHistoryIndex] = useState(-1)

      const abortRef = useRef(null)
      const sessionRef = useRef(sessionId)
      const streamIdRef = useRef(null)
      const outputRef = useRef(null)
      const inputRef = useRef(null)
      const stickRef = useRef(true)
      const startingRef = useRef(false)
      const mountedRef = useRef(true)
      const exitedRef = useRef(exited)

      useEffect(() => { sessionRef.current = sessionId }, [sessionId])
      useEffect(() => { exitedRef.current = exited }, [exited])

      useEffect(() => {
        ideMemory.terminal = { root, id: sessionId, output, exited, exitCode, tabs }
      }, [root, sessionId, output, exited, exitCode, tabs])

      useEffect(() => {
        const old = previousRef.current
        if (!old || !old.root || old.root === root) return
        const ids = Array.isArray(old.tabs) && old.tabs.length > 0
          ? old.tabs.map((tab) => tab.id)
          : (old.id ? [old.id] : [])
        for (const id of ids) {
          api('/terminal/close', {
            method: 'POST',
            body: JSON.stringify({ id }),
          }).catch(() => {})
        }
        abortRef.current?.abort()
        streamIdRef.current = null
        setTabs([])
        setSessionId(null)
        setOutput('')
        setExited(false)
        setExitCode(null)
        setConnected(false)
        setError('')
        setBusy(false)
        previousRef.current = { root, id: null, output: '', exited: false, exitCode: null, tabs: [] }
      }, [root])

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          abortRef.current?.abort()
        }
      }, [])

      const attachStream = useCallback(async (id) => {
        if (!id) return
        if (streamIdRef.current === id && abortRef.current && !abortRef.current.signal.aborted) return
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        streamIdRef.current = id
        let reader = null
        let finished = false

        try {
          await ensureToken()
          const makeRequest = async (force) => {
            if (force) {
              TOKEN = ''
              await ensureToken(true)
            }
            return fetch(`${API}/terminal/stream?id=${encodeURIComponent(id)}`, {
              method: 'GET',
              headers: { 'x-dsh-ide-token': TOKEN },
              cache: 'no-store',
              signal: controller.signal,
            })
          }
          let response = await makeRequest(false)
          if (response.status === 403) response = await makeRequest(true)
          if (response.status === 404) {
            if (mountedRef.current) {
              streamIdRef.current = null
              setTabs((previous) => previous.filter((tab) => tab.id !== id))
              setSessionId(null)
              setConnected(false)
            }
            return
          }
          if (!response.ok) {
            let message = response.statusText || t('终端连接失败')
            try {
              const body = await response.json()
              message = body.error || message
            } catch {
              /* non-JSON error */
            }
            throw new Error(message)
          }
          reader = response.body?.getReader()
          if (!reader) throw new Error(t('终端连接失败'))
          const decoder = new TextDecoder()
          let buffer = ''
          setConnected(true)
          setError('')

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf('\n')
              if (!line) continue
              let event
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }
              if (event.type === 'reset') {
                finished = Boolean(event.exited)
                setOutput(cleanTerminalText(event.buffer || '', true, true).slice(-200000))
                setExited(Boolean(event.exited))
                setExitCode(event.exitCode ?? null)
                exitedRef.current = Boolean(event.exited)
                setTabs((previous) => previous.map((tab) => (tab.id === id
                  ? { ...tab, exited: Boolean(event.exited), exitCode: event.exitCode ?? null }
                  : tab)))
              } else if (event.type === 'data') {
                const chunk = cleanTerminalText(event.data || '', false, true)
                setOutput((previous) => {
                  const base = /\x1b\[[23]J/.test(event.data || '') ? '' : previous
                  const next = base + chunk
                  return next.length > 200000 ? next.slice(-200000) : next
                })
              } else if (event.type === 'exit') {
                finished = true
                setExited(true)
                setExitCode(event.exitCode ?? null)
                exitedRef.current = true
                setConnected(false)
                setTabs((previous) => previous.map((tab) => (tab.id === id
                  ? { ...tab, exited: true, exitCode: event.exitCode ?? null }
                  : tab)))
              } else if (event.type === 'error') {
                setError(event.message || t('终端错误'))
              }
            }
          }
          if (!finished && !controller.signal.aborted && mountedRef.current) {
            setError(t('终端连接已断开'))
          }
        } catch (cause) {
          if (cause.name !== 'AbortError' && mountedRef.current) {
            setError(cause.message)
            setConnected(false)
          }
        } finally {
          if (streamIdRef.current === id) streamIdRef.current = null
          try { reader?.releaseLock() } catch { /* already released */ }
        }
      }, [t])

      const startTerminal = useCallback(async () => {
        if (startingRef.current) return
        startingRef.current = true
        setBusy(true)
        setError('')
        setConnected(false)
        try {
          const data = await api('/terminal/create', {
            method: 'POST',
            body: JSON.stringify({ root, cols: 100, rows: 24 }),
          })
          if (!mountedRef.current) return
          streamIdRef.current = null
          setOutput('')
          setExited(false)
          setExitCode(null)
          exitedRef.current = false
          setTabs((previous) => [
            ...previous,
            { id: data.id, title: `${t('终端')} ${previous.length + 1}`, exited: false, exitCode: null },
          ])
          setSessionId(data.id)
          ideMemory.terminal = { root, id: data.id, output: '', exited: false, exitCode: null }
        } catch (cause) {
          if (mountedRef.current) setError(cause.message)
        } finally {
          startingRef.current = false
          if (mountedRef.current) setBusy(false)
        }
      }, [root, t])

      useEffect(() => {
        if (!open) return
        if (sessionId && tabs.some((tab) => tab.id === sessionId)) {
          attachStream(sessionId)
        } else if (tabs.length > 0) {
          const first = tabs[0]
          setSessionId(first.id)
          setExited(Boolean(first.exited))
          setExitCode(first.exitCode ?? null)
          exitedRef.current = Boolean(first.exited)
        } else {
          startTerminal()
        }
      }, [open, sessionId, tabs, attachStream, startTerminal])

      useEffect(() => {
        if (!open) return
        requestAnimationFrame(() => inputRef.current?.focus())
      }, [open])

      useEffect(() => {
        const node = outputRef.current
        if (!node) return
        if (open) stickRef.current = true
        node.scrollTop = node.scrollHeight
      }, [open])

      useEffect(() => {
        const node = outputRef.current
        if (!node || !stickRef.current) return
        node.scrollTop = node.scrollHeight
      }, [output])

      const switchTab = useCallback((id) => {
        if (!id || id === sessionId) return
        const target = tabs.find((tab) => tab.id === id)
        if (!target) return
        abortRef.current?.abort()
        streamIdRef.current = null
        setSessionId(id)
        setOutput('')
        setConnected(false)
        setError('')
        setExited(Boolean(target.exited))
        setExitCode(target.exitCode ?? null)
        exitedRef.current = Boolean(target.exited)
      }, [sessionId, tabs])

      const closeTab = useCallback(async (id) => {
        if (!id) return
        const active = id === sessionId
        if (active) {
          abortRef.current?.abort()
          streamIdRef.current = null
        }
        try {
          await api('/terminal/close', {
            method: 'POST',
            body: JSON.stringify({ id }),
          })
        } catch {
          /* the host may already have reaped it */
        }
        const remaining = tabs.filter((tab) => tab.id !== id)
        setTabs(remaining)
        if (!active) return
        const next = remaining[remaining.length - 1]
        if (next) {
          setSessionId(next.id)
          setOutput('')
          setConnected(false)
          setError('')
          setExited(Boolean(next.exited))
          setExitCode(next.exitCode ?? null)
          exitedRef.current = Boolean(next.exited)
        } else {
          setSessionId(null)
          setOutput('')
          setConnected(false)
          setError('')
          setExited(false)
          setExitCode(null)
        }
      }, [sessionId, tabs])

      const send = useCallback(async (value) => {
        const id = sessionRef.current
        if (!id || exitedRef.current) return
        const command = value ?? input
        setInput('')
        if (command.trim()) {
          setHistory((previous) => [...previous, command].slice(-60))
          setHistoryIndex(-1)
        }
        setBusy(true)
        try {
          await api('/terminal/input', {
            method: 'POST',
            body: JSON.stringify({ id, data: `${command}\r` }),
          })
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
          requestAnimationFrame(() => inputRef.current?.focus())
        }
      }, [input])

      const interrupt = useCallback(async () => {
        const id = sessionRef.current
        if (!id || exitedRef.current) return
        try {
          await api('/terminal/input', {
            method: 'POST',
            body: JSON.stringify({ id, data: '\u0003' }),
          })
        } catch (cause) {
          setError(cause.message)
        }
      }, [])

      const clear = useCallback(() => {
        setOutput('')
        ideMemory.terminal = { root, id: sessionRef.current, output: '', exited, exitCode }
      }, [root, exited, exitCode])

      const onInputKeyDown = (event) => {
        if (event.nativeEvent?.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          send()
          return
        }
        if (event.ctrlKey && event.key.toLowerCase() === 'c') {
          event.preventDefault()
          interrupt()
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          if (history.length === 0) return
          const next = Math.min(history.length - 1, historyIndex + 1)
          setHistoryIndex(next)
          setInput(history[history.length - 1 - next])
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          if (historyIndex < 0) return
          const next = historyIndex - 1
          setHistoryIndex(next)
          setInput(next < 0 ? '' : history[history.length - 1 - next])
        }
      }

      const status = exited ? t('已退出') : connected ? t('运行中') : busy ? t('启动中') : t('未连接')
      const statusClass = exited ? 'is-exited' : connected ? 'is-running' : 'is-idle'

      return h('div', {
        className: 'ide-terminal',
        style: { display: open ? 'flex' : 'none', height },
      },
      h('div', { className: 'ide-terminal-head' },
        h('div', { className: 'ide-terminal-title' },
          h(Icon, { name: 'terminal', size: 14 }),
          h('span', null, t('终端')),
          h('span', { className: 'ide-terminal-cwd', title: root }, basename(root) || root),
        ),
        h('div', { className: `ide-terminal-status ${statusClass}` },
          h('span', { className: 'ide-terminal-status-dot' }),
          status,
        ),
        h('div', { className: 'ide-terminal-actions' },
          h(IconButton, { name: 'plus', title: t('新建终端'), size: 13, onClick: startTerminal, disabled: busy }),
          h(IconButton, { name: 'trash', title: t('清空终端'), size: 13, onClick: clear }),
          h(IconButton, { name: 'close', title: t('隐藏终端'), size: 13, onClick: onClose }),
        ),
      ),
      h('div', { className: 'ide-terminal-tabs' },
        tabs.map((tab) => h('div', {
          key: tab.id,
          className: `ide-terminal-tab${tab.id === sessionId ? ' is-active' : ''}`,
        },
        h('button', {
          type: 'button',
          className: 'ide-terminal-tab-label',
          title: tab.title,
          onClick: () => switchTab(tab.id),
        }, tab.title),
        h('button', {
          type: 'button',
          className: 'ide-terminal-tab-close',
          title: t('关闭终端'),
          onClick: () => closeTab(tab.id),
        }, '×'),
        )),
        h('button', {
          type: 'button',
          className: 'ide-terminal-tab-new',
          title: t('新建终端'),
          onClick: startTerminal,
          disabled: busy,
        }, '+'),
      ),
      h('pre', {
        className: `ide-terminal-output${output ? '' : ' is-empty'}`,
        ref: outputRef,
        onScroll: (event) => {
          const node = event.currentTarget
          stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        },
        onClick: () => inputRef.current?.focus(),
      }, output
        ? h(TerminalAnsi, { text: output })
        : (error ? '' : t('终端已就绪，输入命令…'))),
      error ? h('div', { className: 'ide-terminal-error' }, h(Icon, { name: 'alert', size: 12 }), error) : null,
      h('div', { className: 'ide-terminal-input-row' },
        h('span', { className: 'ide-terminal-prompt' }, '❯'),
        h('input', {
          ref: inputRef,
          className: 'ide-terminal-input',
          value: input,
          disabled: exited,
          placeholder: exited ? t('进程已退出，点击 + 新建终端') : t('输入命令，回车执行'),
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => setInput(event.target.value),
          onKeyDown: onInputKeyDown,
        }),
        h('button', {
          type: 'button',
          className: 'ide-terminal-key',
          title: t('发送 Ctrl+C'),
          onClick: interrupt,
          disabled: exited,
        }, '^C'),
      ),
      )
    }

    // -----------------------------------------------------------------------
    // Quick open
    // -----------------------------------------------------------------------

    function QuickOpen({ open, root, t, onClose, onOpen }) {
      const [query, setQuery] = useState('')
      const [files, setFiles] = useState([])
      const [selected, setSelected] = useState(0)
      const inputRef = useRef(null)
      const seq = useRef(0)

      useEffect(() => {
        if (!open) return
        setQuery('')
        setSelected(0)
        requestAnimationFrame(() => inputRef.current?.focus())
      }, [open])

      useEffect(() => {
        if (!open || !root) return undefined
        const id = ++seq.current
        const timer = setTimeout(async () => {
          try {
            const data = await api(`/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query.trim())}`)
            if (id === seq.current) {
              setFiles(data.files || [])
              setSelected(0)
            }
          } catch {
            if (id === seq.current) setFiles([])
          }
        }, 130)
        return () => clearTimeout(timer)
      }, [open, root, query])

      if (!open) return null

      const choose = (path) => {
        onOpen(path)
        onClose()
      }

      return h('div', {
        className: 'ide-overlay ide-overlay-top',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', { className: 'ide-palette', role: 'dialog', 'aria-label': t('快速打开') },
        h('div', { className: 'ide-palette-head' },
          h(Icon, { name: 'search', size: 16 }),
          h('input', {
            ref: inputRef,
            value: query,
            placeholder: t('输入文件名'),
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((value) => Math.min(files.length - 1, value + 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((value) => Math.max(0, value - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (files[selected]) choose(files[selected])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              }
            },
          }),
          h('button', { type: 'button', className: 'ide-mini-clear', onClick: onClose }, h(Icon, { name: 'close', size: 12 })),
        ),
        h('div', { className: 'ide-palette-list' },
          files.length === 0
            ? h('div', { className: 'ide-empty-small' }, t('无匹配文件'))
            : files.map((path, index) => h('button', {
              key: path,
              type: 'button',
              className: `ide-palette-row${index === selected ? ' is-selected' : ''}`,
              onMouseEnter: () => setSelected(index),
              onClick: () => choose(path),
              title: path,
            },
            h(FileGlyph, { name: path, size: 13 }),
            h('span', { className: 'ide-palette-name' }, basename(path)),
            h('span', { className: 'ide-palette-dir' }, dirname(path)),
            )),
        ),
        h('div', { className: 'ide-palette-foot' }, t('按 Esc 关闭')),
      ))
    }

    // -----------------------------------------------------------------------
    // Modal host
    // -----------------------------------------------------------------------

    function ModalHost({ modal, t, onClose }) {
      useEffect(() => {
        if (!modal) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [modal, onClose])

      if (!modal) return null

      if (modal.kind === 'prompt') {
        return h(PromptModal, { modal, t, onClose })
      }
      if (modal.kind === 'diff') {
        return h(DiffModal, { modal, t, onClose })
      }
      if (modal.kind === 'hover') {
        return h(HoverModal, { modal, t, onClose })
      }
      if (modal.kind === 'lsp-results') {
        return h(LspResultsModal, { modal, t, onClose })
      }
      if (modal.kind === 'model-config') {
        return h(ModelConfigModal, { modal, t, onClose })
      }
      return h(ChoiceModal, { modal, t, onClose })
    }

    function ModalShell({ title, t, onClose, children, footer, wide }) {
      return h('div', {
        className: 'ide-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', { className: `ide-dialog${wide ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { className: 'ide-dialog-head' },
          h('span', null, title),
          h('button', { type: 'button', className: 'ide-dialog-close', onClick: onClose }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('div', { className: 'ide-dialog-body' }, children),
        footer ? h('div', { className: 'ide-dialog-foot' }, footer) : null,
      ))
    }

    function DiffModal({ modal, t, onClose }) {
      const [text, setText] = useState('')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      useEffect(() => {
        let live = true
        if (typeof modal.diff === 'string') {
          setText(modal.diff)
          setLoading(false)
          return () => { live = false }
        }
        Promise.resolve()
          .then(() => modal.load?.())
          .then((value) => {
            if (!live) return
            setText(typeof value === 'string' ? value : value?.diff || '')
            setLoading(false)
          })
          .catch((cause) => {
            if (!live) return
            setError(cause.message)
            setLoading(false)
          })
        return () => { live = false }
      }, [modal])

      const lines = useMemo(() => text.split('\n'), [text])
      const classNameOf = (line) => {
        if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) return 'is-meta'
        if (line.startsWith('@@')) return 'is-hunk'
        if (line.startsWith('+')) return 'is-add'
        if (line.startsWith('-')) return 'is-del'
        return ''
      }

      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        wide: true,
        footer: [
          modal.onOpen ? h('button', {
            key: 'open',
            type: 'button',
            className: 'ide-button',
            onClick: () => {
              onClose()
              modal.onOpen()
            },
          }, t('打开文件')) : null,
          modal.onApply ? h('button', {
            key: 'close',
            type: 'button',
            className: 'ide-button',
            onClick: onClose,
          }, t('关闭')) : null,
          modal.onApply ? h('button', {
            key: 'apply',
            type: 'button',
            className: 'ide-button is-primary',
            onClick: () => {
              onClose()
              modal.onApply()
            },
          }, modal.applyLabel || t('应用')) : h('button', {
            key: 'close',
            type: 'button',
            className: 'ide-button is-primary',
            onClick: onClose,
          }, t('关闭')),
        ],
      },
      loading
        ? h('div', { className: 'ide-diff-loading' }, h(Spinner, { size: 18 }), t('加载中'))
        : (error
          ? h('div', { className: 'ide-diff-error' }, h(Icon, { name: 'alert', size: 14 }), error)
          : (text.trim()
            ? h('pre', { className: 'ide-diff' }, lines.map((line, index) => h('span', {
              key: index,
              className: `ide-diff-line ${classNameOf(line)}`.trim(),
            }, line || ' ')))
            : h('div', { className: 'ide-diff-empty' }, t('没有差异')))),
      )
    }

    function HoverModal({ modal, t, onClose }) {
      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        wide: true,
        footer: [
          h('button', { key: 'close', type: 'button', className: 'ide-button is-primary', onClick: onClose }, t('关闭')),
        ],
      },
      h('div', { className: 'ide-hover-content' },
        h(Markdown, { text: modal.content || '', t })),
      )
    }

    function LspResultsModal({ modal, t, onClose }) {
      const items = Array.isArray(modal.items) ? modal.items : []
      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        footer: [
          h('button', { key: 'close', type: 'button', className: 'ide-button', onClick: onClose }, t('关闭')),
        ],
      },
      h('div', { className: 'ide-lsp-results' },
        items.map((item, index) => h('button', {
          key: `${item.path || item.absolutePath}:${item.line}:${item.character}:${index}`,
          type: 'button',
          className: 'ide-lsp-result',
          onClick: () => {
            onClose()
            modal.onPick?.(item)
          },
          title: `${item.path || item.absolutePath}:${item.line}:${item.character}`,
        },
        h(Icon, { name: 'file', size: 13 }),
        h('span', { className: 'ide-lsp-result-path' }, item.path || item.absolutePath),
        h('span', { className: 'ide-lsp-result-pos' }, `${item.line}:${item.character}`),
        )),
      ))
    }

    function PromptModal({ modal, t, onClose }) {
      const [value, setValue] = useState(modal.value || '')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const inputRef = useRef(null)
      useEffect(() => { requestAnimationFrame(() => inputRef.current?.focus()) }, [])

      const submit = async () => {
        const name = value.trim()
        if (!name) {
          setError(modal.requiredMessage || t('名称不能为空'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const result = await modal.run?.(name)
          if (result !== false) onClose()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'ide-button', onClick: onClose }, t('取消')),
          h('button', { key: 'ok', type: 'button', className: 'ide-button is-primary', onClick: submit, disabled: busy },
            busy ? h(Spinner, { size: 12 }) : null,
            modal.confirmLabel || t('确定')),
        ],
      },
      h('div', { className: 'ide-field' },
        h('label', null, modal.label || t('名称')),
        h('input', {
          ref: inputRef,
          value,
          placeholder: modal.placeholder || t('请输入名称'),
          spellCheck: false,
          onChange: (event) => setValue(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          },
        }),
      ),
      error ? h('div', { className: 'ide-form-error' }, error) : null,
      )
    }

    function ChoiceModal({ modal, t, onClose }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const actions = modal.actions || [
        { label: t('取消') },
        { label: modal.confirmLabel || t('确定'), primary: true, run: modal.run },
      ]

      const runAction = async (action) => {
        if (!action.run) {
          onClose()
          return
        }
        setBusy(true)
        setError('')
        try {
          const result = await action.run()
          if (result !== false) onClose()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      return h(ModalShell, {
        title: modal.title,
        t,
        onClose,
        footer: actions.map((action, index) => h('button', {
          key: index,
          type: 'button',
          className: `ide-button${action.primary ? ' is-primary' : ''}${action.danger ? ' is-danger' : ''}`,
          onClick: () => runAction(action),
          disabled: busy,
        }, busy && action.primary ? h(Spinner, { size: 12 }) : null, action.label)),
      },
      modal.message ? h('div', { className: 'ide-dialog-message' }, modal.message) : null,
      error ? h('div', { className: 'ide-form-error' }, error) : null,
      )
    }

    // -----------------------------------------------------------------------
    // API and main application
    // -----------------------------------------------------------------------

    async function ensureToken(force = false) {
      if (!force && TOKEN) return TOKEN
      const response = await fetch(`${API}/session`, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'x-dsh-ide-request': '1' },
      })
      const text = await response.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
      }
      if (!response.ok || !data || typeof data.token !== 'string' || !data.token) {
        const message = data && typeof data === 'object' && data.error
          ? data.error
          : '无法建立 IDE 会话，请刷新页面'
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      TOKEN = data.token
      return TOKEN
    }

    async function api(path, options = {}, retried = false) {
      await ensureToken()
      const headers = { 'x-dsh-ide-token': TOKEN, ...(options.headers || {}) }
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`${API}${path}`, { ...options, headers })
      if (response.status === 403 && !retried) {
        TOKEN = ''
        await ensureToken(true)
        return api(path, options, true)
      }
      const text = await response.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      if (!response.ok) {
        const message = data && typeof data === 'object' && data.error
          ? data.error
          : response.statusText || '请求失败'
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return data
    }

    function ContextMenu({ menu, t, onClose, onNewFile, onNewFolder, onRename, onDelete, onCopyPath }) {
      const ref = useRef(null)
      useEffect(() => {
        const close = () => onClose()
        window.addEventListener('pointerdown', close)
        window.addEventListener('blur', close)
        return () => {
          window.removeEventListener('pointerdown', close)
          window.removeEventListener('blur', close)
        }
      }, [onClose])

      if (!menu) return null
      const node = menu.node
      const directory = node.type === 'directory' ? node.rel : dirname(node.rel)
      return h('div', {
        ref,
        className: 'ide-menu',
        style: { left: menu.x, top: menu.y },
        onPointerDown: (event) => event.stopPropagation(),
      },
      h('div', { className: 'ide-menu-title' }, node.name),
      h('button', { type: 'button', className: 'ide-menu-item', onClick: () => { onNewFile(directory); onClose() } },
        h(Icon, { name: 'filePlus', size: 14 }), t('新建文件')),
      h('button', { type: 'button', className: 'ide-menu-item', onClick: () => { onNewFolder(directory); onClose() } },
        h(Icon, { name: 'folderPlus', size: 14 }), t('新建文件夹')),
      h('div', { className: 'ide-menu-sep' }),
      h('button', { type: 'button', className: 'ide-menu-item', onClick: () => { onRename(node); onClose() } },
        h(Icon, { name: 'edit', size: 14 }), t('重命名')),
      h('button', { type: 'button', className: 'ide-menu-item', onClick: () => { onCopyPath(node); onClose() } },
        h(Icon, { name: 'copy', size: 14 }), t('复制相对路径')),
      h('div', { className: 'ide-menu-sep' }),
      h('button', { type: 'button', className: 'ide-menu-item is-danger', onClick: () => { onDelete(node); onClose() } },
        h(Icon, { name: 'trash', size: 14 }), t('删除')),
      )
    }

    function IdeApp({ ctx }) {
      const t = useT(ctx)
      const [fatal, setFatal] = useState('')
      const [boot, setBoot] = useState(null)
      const [roots, setRoots] = useState([])
      const [root, setRoot] = useState('')
      const [model, setModel] = useState(null)
      const [tabs, setTabs] = useState(() => (ideMemory.root ? ideMemory.tabs : []))
      const [active, setActive] = useState(() => (ideMemory.root ? ideMemory.active : null))
      const [tree, setTree] = useState(() => (ideMemory.root ? ideMemory.tree : {}))
      const [expanded, setExpanded] = useState(() => (ideMemory.root ? ideMemory.expanded : { '': true }))
      const [view, setView] = useState(() => ideMemory.view || 'explorer')
      const [codeMirrorEnabled, setCodeMirrorEnabled] = useState(() => Boolean(ideMemory.codeMirror))
      const [filter, setFilter] = useState('')
      const [quick, setQuick] = useState([])
      const [cursor, setCursor] = useState({ path: null, start: 0, end: 0 })
      const [reveal, setReveal] = useState(null)
      const [sideW, setSideW] = useState(() => clamp(readNumber(LS.side, 248), 190, 520))
      const [chatW, setChatW] = useState(() => clamp(readNumber(LS.chat, 380), 300, 760))
      const [chatOpen, setChatOpen] = useState(() => readBool(LS.chatOpen, true))
      const [terminalOpen, setTerminalOpen] = useState(() => readBool(LS.terminalOpen, false))
      const [terminalHeight, setTerminalHeight] = useState(() => clamp(readNumber(LS.terminalHeight, 220), 120, 480))
      const [loadingRoot, setLoadingRoot] = useState(false)
      const [saving, setSaving] = useState(false)
      const [lspBusy, setLspBusy] = useState(false)
      const [diagnostics, setDiagnostics] = useState([])
      const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
      const [history, setHistory] = useState(() => (Array.isArray(ideMemory.history) ? ideMemory.history : []))
      const [pickingFolder, setPickingFolder] = useState(false)
      const [errorBanner, setErrorBanner] = useState('')
      const [toast, setToast] = useState(null)
      const [modal, setModal] = useState(null)
      const [quickOpen, setQuickOpen] = useState(false)
      const [contextMenu, setContextMenu] = useState(null)

      const rootElRef = useRef(null)
      const rootRef = useRef('')
      const tabsRef = useRef([])
      const diagnosticsSeq = useRef(0)
      const diagnosticsPath = useRef('')
      const historySeq = useRef(0)
      const activeRef = useRef(null)
      const treeRef = useRef({})
      const modalRef = useRef(null)
      const toastTimer = useRef(null)
      const revealSeq = useRef(0)
      const modalSeq = useRef(0)
      const quickSeq = useRef(0)

      useEffect(() => { tabsRef.current = tabs }, [tabs])
      useEffect(() => { activeRef.current = active }, [active])
      useEffect(() => { treeRef.current = tree }, [tree])
      useEffect(() => { modalRef.current = modal }, [modal])
      useEffect(() => () => clearTimeout(toastTimer.current), [])

      const notify = useCallback((message, tone = 'info') => {
        setToast({ id: Date.now(), message, tone })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])

      const showModal = useCallback((config) => {
        modalSeq.current += 1
        setModal({ id: modalSeq.current, ...config })
      }, [])
      const closeModal = useCallback(() => setModal(null), [])
      const confirm = useCallback((config) => showModal({ kind: 'choice', ...config }), [showModal])

      useEffect(() => { writeLS(LS.side, sideW) }, [sideW])
      useEffect(() => { writeLS(LS.chat, chatW) }, [chatW])
      useEffect(() => { writeLS(LS.chatOpen, chatOpen ? '1' : '0') }, [chatOpen])
      useEffect(() => { writeLS(LS.terminalOpen, terminalOpen ? '1' : '0') }, [terminalOpen])
      useEffect(() => { writeLS(LS.terminalHeight, terminalHeight) }, [terminalHeight])
      useEffect(() => {
        if (root && active) writeLS(LS.active + root, active)
      }, [root, active])

      const loadDir = useCallback(async (rel, rootOverride) => {
        const selectedRoot = rootOverride || rootRef.current
        if (!selectedRoot) return []
        const data = await api(`/tree?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(rel)}`)
        const entries = (data.entries || []).map((entry) => ({ ...entry, rel: joinRel(rel, entry.name) }))
        const previousEntries = treeRef.current[rel]
        if (
          previousEntries
          && previousEntries.length === entries.length
          && previousEntries.every((entry, index) => (
            entry.name === entries[index].name
            && entry.type === entries[index].type
            && entry.rel === entries[index].rel
          ))
        ) {
          return previousEntries
        }
        setTree((previous) => {
          const next = { ...previous, [rel]: entries }
          treeRef.current = next
          return next
        })
        return entries
      }, [])

      const doReveal = useCallback((path, info) => {
        revealSeq.current += 1
        setReveal({ path, index: info.index || 0, length: info.length || 0, nonce: revealSeq.current })
      }, [])

      const openFileAtRoot = useCallback(async (selectedRoot, rel, revealInfo) => {
        if (!selectedRoot || !rel) return
        const existing = tabsRef.current.find((tab) => tab.path === rel)
        if (existing) {
          activeRef.current = rel
          setActive(rel)
          if (revealInfo) {
            const reveal = resolveRevealInfo(existing.text, revealInfo)
            if (reveal) doReveal(rel, reveal)
          }
          return
        }

        const loadingTab = {
          path: rel,
          name: basename(rel),
          text: '',
          original: '',
          version: null,
          language: languageOf(rel),
          loading: true,
          error: null,
          size: null,
        }
        const nextTabs = [...tabsRef.current, loadingTab]
        tabsRef.current = nextTabs
        setTabs(nextTabs)
        activeRef.current = rel
        setActive(rel)

        try {
          const data = await api(`/file?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(rel)}`)
          setTabs((previous) => {
            const next = previous.map((tab) => (tab.path === rel
              ? {
                ...tab,
                text: data.text,
                original: data.text,
                version: data.version,
                language: data.language,
                size: data.size,
                loading: false,
                error: null,
              }
              : tab))
            tabsRef.current = next
            return next
          })
          if (revealInfo) {
            const reveal = resolveRevealInfo(data.text, revealInfo)
            if (reveal) doReveal(rel, reveal)
          }
        } catch (error) {
          setTabs((previous) => {
            const next = previous.map((tab) => (tab.path === rel ? { ...tab, loading: false, error: error.message } : tab))
            tabsRef.current = next
            return next
          })
          notify(error.message, 'error')
        }
      }, [doReveal, notify])

      const openFile = useCallback((rel, revealInfo) => {
        openFileAtRoot(rootRef.current, rel, revealInfo)
      }, [openFileAtRoot])

      const openHit = useCallback((rel, index, length) => {
        openFileAtRoot(rootRef.current, rel, { index, length })
      }, [openFileAtRoot])

      const openLspLocation = useCallback((location) => {
        if (!location || !location.path) {
          notify(t('位置在工作区外'), 'warn')
          return
        }
        openFileAtRoot(rootRef.current, location.path, {
          line: location.line,
          column: location.character,
        })
      }, [openFileAtRoot, notify, t])

      const runLsp = useCallback(async (operation, explicitPosition) => {
        const tab = tabsRef.current.find((entry) => entry.path === activeRef.current)
        if (!tab) {
          notify(t('请先打开文件'), 'warn')
          return
        }
        const position = Number.isFinite(explicitPosition)
          ? explicitPosition
          : (cursor.path === tab.path ? cursor.start : 0)
        const before = tab.text.slice(0, position)
        const line = before.split('\n').length
        const character = position - before.lastIndexOf('\n')
        setLspBusy(true)
        try {
          const result = await api('/lsp/query', {
            method: 'POST',
            body: JSON.stringify({
              root: rootRef.current,
              path: tab.path,
              operation,
              line: line - 1,
              character: character - 1,
            }),
          })
          if (result.kind === 'hover') {
            showModal({
              kind: 'hover',
              title: t('悬停信息'),
              content: result.hover?.contents || t('没有悬停信息'),
            })
            return
          }
          const locations = Array.isArray(result.locations) ? result.locations : []
          if (locations.length === 0) {
            notify(t('没有找到结果'), 'info')
            return
          }
          if (locations.length === 1) {
            openLspLocation(locations[0])
            return
          }
          showModal({
            kind: 'lsp-results',
            title: operation === 'findReferences' ? t('查找引用') : t('转到定义'),
            items: locations,
            onPick: openLspLocation,
          })
        } catch (cause) {
          notify(cause.message, 'error')
        } finally {
          setLspBusy(false)
        }
      }, [cursor, notify, openLspLocation, showModal, t])

      const updateText = useCallback((text) => {
        const path = activeRef.current
        if (!path) return
        setTabs((previous) => {
          const next = previous.map((tab) => (tab.path === path ? { ...tab, text } : tab))
          tabsRef.current = next
          return next
        })
      }, [])

      const updateSelection = useCallback((start, end) => {
        setCursor((previous) => {
          const path = activeRef.current
          if (previous.path === path && previous.start === start && previous.end === end) return previous
          return { path, start, end }
        })
      }, [])

      const closeTabNow = useCallback((path) => {
        const current = tabsRef.current
        const index = current.findIndex((tab) => tab.path === path)
        if (index < 0) return
        const next = current.filter((tab) => tab.path !== path)
        tabsRef.current = next
        setTabs(next)
        if (activeRef.current === path) {
          const nextActive = next[Math.min(index, next.length - 1)]?.path || null
          activeRef.current = nextActive
          setActive(nextActive)
        }
      }, [])

      const saveTabPath = useCallback(async (path) => {
        const tab = tabsRef.current.find((entry) => entry.path === path)
        if (!tab || tab.loading || tab.error) return false
        setSaving(true)
        try {
          const data = await api('/file', {
            method: 'POST',
            body: JSON.stringify({ root: rootRef.current, path, text: tab.text, version: tab.version }),
          })
          setTabs((previous) => {
            const next = previous.map((entry) => (entry.path === path
              ? {
                ...entry,
                version: data.version,
                size: data.size,
                original: entry.text === tab.text ? tab.text : entry.original,
              }
              : entry))
            tabsRef.current = next
            return next
          })
          notify(t('已保存'), 'success')
          return true
        } catch (error) {
          if (error.status === 409) {
            showModal({
              kind: 'choice',
              title: t('文件已变化'),
              message: error.message,
              actions: [
                { label: t('取消') },
                {
                  label: t('重新加载'),
                  primary: true,
                  run: async () => {
                    closeTabNow(path)
                    await openFileAtRoot(rootRef.current, path)
                  },
                },
              ],
            })
          } else {
            notify(error.message, 'error')
          }
          return false
        } finally {
          setSaving(false)
        }
      }, [closeTabNow, notify, openFileAtRoot, showModal, t])

      const requestClose = useCallback((path) => {
        const tab = tabsRef.current.find((entry) => entry.path === path)
        if (!tab) return
        if (tab.text !== tab.original) {
          showModal({
            kind: 'choice',
            title: t('有未保存的更改'),
            message: `“${tab.name}” ${t('关闭后将丢失')}`,
            actions: [
              {
                label: t('保存并关闭'),
                primary: true,
                run: async () => {
                  const saved = await saveTabPath(path)
                  if (!saved) return false
                  closeTabNow(path)
                },
              },
              { label: t('不保存'), danger: true, run: () => closeTabNow(path) },
              { label: t('取消') },
            ],
          })
        } else {
          closeTabNow(path)
        }
      }, [closeTabNow, saveTabPath, showModal, t])

      const closeAllNow = useCallback(() => {
        tabsRef.current = []
        setTabs([])
        activeRef.current = null
        setActive(null)
      }, [])

      const requestCloseAll = useCallback(() => {
        const dirty = tabsRef.current.filter((tab) => tab.text !== tab.original)
        if (dirty.length === 0) {
          closeAllNow()
          return
        }
        showModal({
          kind: 'choice',
          title: t('有未保存的更改'),
          message: `${dirty.length} ${t('个文件')} ${t('关闭后将丢失')}`,
          actions: [
            {
              label: t('全部保存'),
              primary: true,
              run: async () => {
                for (const tab of tabsRef.current) {
                  if (tab.text !== tab.original) {
                    const saved = await saveTabPath(tab.path)
                    if (!saved) return false
                  }
                }
                closeAllNow()
              },
            },
            { label: t('放弃更改'), danger: true, run: closeAllNow },
            { label: t('取消') },
          ],
        })
      }, [closeAllNow, saveTabPath, showModal, t])

      const refreshAll = useCallback(async (announce) => {
        if (!rootRef.current) return
        setLoadingRoot(true)
        try {
          setTree({})
          treeRef.current = {}
          setExpanded({ '': true })
          await loadDir('', rootRef.current)
          if (announce) notify(t('就绪'), 'success')
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setLoadingRoot(false)
        }
      }, [loadDir, notify, t])

      useEffect(() => {
        let cancelled = false
        api('/bootstrap')
          .then(async (data) => {
            if (cancelled) return
            setBoot(data)
            setModel(data.model || null)
            let available = data.roots || []
            const savedRoot = readLS(LS.root, '')
            let chosen = available.find((entry) => entry.path === savedRoot)
            if (!chosen && savedRoot) {
              try {
                const added = await api('/roots', {
                  method: 'POST',
                  body: JSON.stringify({ path: savedRoot }),
                })
                if (cancelled) return
                available = added.roots || available
                chosen = available.find((entry) => entry.path === savedRoot) || added.root
              } catch {
                /* the remembered folder may have been moved or deleted */
              }
            }
            if (cancelled) return
            setRoots(available)
            if (!chosen) chosen = available[0]
            if (!chosen) {
              setFatal('没有可显示的根目录')
              return
            }
            const restored = ideMemory.root === chosen.path && Array.isArray(ideMemory.tabs)
            if (!restored) {
              ideMemory.tabs = []
              ideMemory.active = null
              ideMemory.tree = {}
              ideMemory.expanded = { '': true }
              ideMemory.chatMessages = []
              setTabs([])
              setActive(null)
              setTree({})
              setExpanded({ '': true })
            }
            setRoot(chosen.path)
          })
          .catch((error) => {
            if (!cancelled) setFatal(error.message)
          })
        return () => { cancelled = true }
      }, [])

      useEffect(() => {
        if (!root) return undefined
        const restored = ideMemory.root === root && Array.isArray(ideMemory.tabs)
        rootRef.current = root
        ideMemory.root = root
        writeLS(LS.root, root)
        setFilter('')
        setQuick([])
        setErrorBanner('')
        setLoadingRoot(true)

        if (restored) {
          const restoredTabs = ideMemory.tabs.map((tab) => (tab.loading
            ? { ...tab, loading: false, error: '文件加载被中断，请点击重试' }
            : tab))
          ideMemory.tabs = restoredTabs
          tabsRef.current = restoredTabs
          activeRef.current = ideMemory.active
          setTabs(restoredTabs)
          setActive(ideMemory.active)
          treeRef.current = ideMemory.tree || {}
          setTree(ideMemory.tree || {})
          setExpanded(ideMemory.expanded || { '': true })
          setCursor({ path: null, start: 0, end: 0 })
        } else {
          tabsRef.current = []
          activeRef.current = null
          setTabs([])
          setActive(null)
          treeRef.current = {}
          setTree({})
          setExpanded({ '': true })
          setCursor({ path: null, start: 0, end: 0 })
        }

        let cancelled = false
        loadDir('', root)
          .then(() => {
            if (cancelled) return
            setLoadingRoot(false)
            if (restored) return
            const saved = readLS(LS.active + root, '')
            if (saved) openFileAtRoot(root, saved)
          })
          .catch((error) => {
            if (!cancelled) {
              setLoadingRoot(false)
              setErrorBanner(error.message)
            }
          })
        return () => { cancelled = true }
      }, [root, loadDir, openFileAtRoot])

      useEffect(() => {
        if (!root) return
        ideMemory.tabs = tabs
        ideMemory.active = active
      }, [tabs, active, root])

      useEffect(() => {
        if (!root) return
        ideMemory.tree = tree
        ideMemory.expanded = expanded
        ideMemory.view = view
        ideMemory.codeMirror = codeMirrorEnabled
      }, [tree, expanded, view, codeMirrorEnabled, root])

      useEffect(() => {
        const needle = filter.trim()
        if (!needle || !root) {
          setQuick([])
          return undefined
        }
        const id = ++quickSeq.current
        const timer = setTimeout(async () => {
          try {
            const data = await api(`/files?root=${encodeURIComponent(root)}&q=${encodeURIComponent(needle)}`)
            if (id === quickSeq.current) setQuick(data.files || [])
          } catch {
            if (id === quickSeq.current) setQuick([])
          }
        }, 160)
        return () => clearTimeout(timer)
      }, [filter, root])

      useEffect(() => {
        const onKey = (event) => {
          if (modalRef.current) return
          const mod = event.ctrlKey || event.metaKey
          if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
            event.preventDefault()
            if (activeRef.current) saveTabPath(activeRef.current)
          } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'p') {
            event.preventDefault()
            setQuickOpen(true)
          } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
            event.preventDefault()
            if (activeRef.current) requestClose(activeRef.current)
          } else if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            setView('search')
          } else if (mod && !event.shiftKey && event.code === 'Backquote') {
            event.preventDefault()
            setTerminalOpen((value) => !value)
          } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'j') {
            event.preventDefault()
            setChatOpen((value) => !value)
          } else if (event.key === 'Escape') {
            setContextMenu(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [requestClose, saveTabPath])

      const toggleDir = useCallback(async (rel) => {
        const isOpen = Boolean(expanded[rel])
        setExpanded((previous) => ({ ...previous, [rel]: !isOpen }))
        if (!isOpen && !treeRef.current[rel]) {
          try {
            await loadDir(rel)
          } catch (error) {
            notify(error.message, 'error')
          }
        }
      }, [expanded, loadDir, notify])

      const newEntry = useCallback((type, parentRel) => {
        const isDirectory = type === 'directory'
        showModal({
          kind: 'prompt',
          title: isDirectory ? t('新建文件夹') : t('新建文件'),
          label: t('名称'),
          placeholder: isDirectory ? 'components' : 'App.tsx',
          confirmLabel: t('创建'),
          run: async (name) => {
            const rel = joinRel(parentRel, name)
            await api('/create', {
              method: 'POST',
              body: JSON.stringify({ root: rootRef.current, path: rel, type }),
            })
            await loadDir(parentRel)
            if (isDirectory) {
              setExpanded((previous) => ({ ...previous, [rel]: true }))
              await loadDir(rel)
            } else {
              await openFileAtRoot(rootRef.current, rel)
            }
            notify(t('已创建'), 'success')
          },
        })
      }, [loadDir, notify, openFileAtRoot, showModal, t])

      const renameNode = useCallback((node) => {
        showModal({
          kind: 'prompt',
          title: t('重命名'),
          label: t('名称'),
          value: basename(node.rel),
          confirmLabel: t('重命名'),
          run: async (name) => {
            const parent = dirname(node.rel)
            const target = joinRel(parent, name)
            await api('/rename', {
              method: 'POST',
              body: JSON.stringify({ root: rootRef.current, path: node.rel, newPath: target }),
            })
            const remap = (value) => {
              if (value === node.rel) return target
              if (value.startsWith(`${node.rel}/`)) return target + value.slice(node.rel.length)
              return value
            }
            setTabs((previous) => {
              const next = previous.map((tab) => {
                const mapped = remap(tab.path)
                if (mapped === tab.path) return tab
                return { ...tab, path: mapped, name: basename(mapped), language: languageOf(mapped) }
              })
              tabsRef.current = next
              return next
            })
            if (activeRef.current) {
              const mapped = remap(activeRef.current)
              if (mapped !== activeRef.current) {
                activeRef.current = mapped
                setActive(mapped)
              }
            }
            if (node.type === 'directory') await refreshAll(false)
            else await loadDir(parent)
            notify(t('已重命名'), 'success')
          },
        })
      }, [loadDir, notify, refreshAll, showModal, t])

      const deleteNode = useCallback((node) => {
        confirm({
          title: t('删除确认'),
          message: `${node.rel}\n${t('此操作不可撤销')}`,
          confirmLabel: t('确定删除'),
          danger: true,
          run: async () => {
            await api('/delete', {
              method: 'POST',
              body: JSON.stringify({ root: rootRef.current, path: node.rel }),
            })
            const removed = tabsRef.current.filter((tab) => tab.path === node.rel || tab.path.startsWith(`${node.rel}/`))
            for (const tab of removed) closeTabNow(tab.path)
            await refreshAll(false)
            notify(t('已删除'), 'success')
          },
        })
      }, [closeTabNow, confirm, notify, refreshAll, t])

      const switchRoot = useCallback((next) => {
        if (!next || next === rootRef.current) return
        const dirty = tabsRef.current.filter((tab) => tab.text !== tab.original)
        const applySwitch = () => {
          ideMemory.root = ''
          ideMemory.tabs = []
          ideMemory.active = null
          ideMemory.tree = {}
          ideMemory.expanded = { '': true }
          ideMemory.chatMessages = []
          tabsRef.current = []
          activeRef.current = null
          treeRef.current = {}
          setTabs([])
          setActive(null)
          setTree({})
          setExpanded({ '': true })
          setCursor({ path: null, start: 0, end: 0 })
          setRoot(next)
        }
        if (dirty.length === 0) {
          applySwitch()
          return
        }
        showModal({
          kind: 'choice',
          title: t('有未保存的更改'),
          message: `${dirty.length} ${t('个文件')} ${t('关闭后将丢失')}`,
          actions: [
            {
              label: t('全部保存'),
              primary: true,
              run: async () => {
                for (const tab of tabsRef.current) {
                  if (tab.text !== tab.original) {
                    const saved = await saveTabPath(tab.path)
                    if (!saved) return false
                  }
                }
                applySwitch()
              },
            },
            { label: t('放弃更改'), danger: true, run: applySwitch },
            { label: t('取消') },
          ],
        })
      }, [saveTabPath, showModal, t])

      const addRootAndSwitch = useCallback(async (value) => {
        const path = String(value || '').trim().replace(/^["']|["']$/g, '')
        if (!path) throw new Error(t('请输入文件夹路径'))
        const data = await api('/roots', {
          method: 'POST',
          body: JSON.stringify({ path }),
        })
        setRoots(data.roots || [])
        if (data.root && data.root.path) {
          const next = data.root.path
          // Let the path dialog close before switchRoot may open its own dialog.
          setTimeout(() => switchRoot(next), 0)
        }
      }, [switchRoot, t])

      const openFolderManual = useCallback(() => {
        showModal({
          kind: 'prompt',
          title: t('打开文件夹'),
          label: t('文件夹路径'),
          placeholder: 'C:\\Users\\name\\project',
          confirmLabel: t('打开'),
          requiredMessage: t('请输入文件夹路径'),
          run: addRootAndSwitch,
        })
      }, [addRootAndSwitch, showModal, t])

      const openFolder = useCallback(async () => {
        if (pickingFolder) return
        setPickingFolder(true)
        try {
          let service
          try {
            service = (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null) || ctx.uiWorkspace
          } catch {
            service = undefined
          }
          if (service && typeof service.pickDirectory === 'function') {
            const picked = await service.pickDirectory()
            if (picked) await addRootAndSwitch(picked)
            return
          }
          openFolderManual()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setPickingFolder(false)
        }
      }, [addRootAndSwitch, ctx, notify, openFolderManual, pickingFolder])

      const pushHistory = useCallback((path, text, label) => {
        if (!path || typeof text !== 'string') return
        historySeq.current += 1
        const item = {
          id: `${Date.now()}-${historySeq.current}`,
          path,
          name: basename(path),
          text: text.slice(0, 2 * 1024 * 1024),
          label,
          at: Date.now(),
        }
        setHistory((previous) => {
          const next = [item, ...previous].slice(0, 16)
          ideMemory.history = next
          return next
        })
      }, [])

      const restoreHistory = useCallback(async (entry) => {
        if (!entry || !entry.path) return
        if (!tabsRef.current.some((tab) => tab.path === entry.path)) {
          await openFileAtRoot(rootRef.current, entry.path)
        }
        const tab = tabsRef.current.find((candidate) => candidate.path === entry.path)
        if (!tab || tab.loading) {
          notify(t('文件正在加载，请稍后重试'), 'warn')
          return
        }
        if (tab.error) {
          notify(t('文件当前不可用，无法恢复检查点'), 'warn')
          return
        }
        pushHistory(entry.path, tab.text, t('恢复前'))
        setTabs((previous) => {
          const next = previous.map((candidate) => (candidate.path === entry.path
            ? { ...candidate, text: entry.text }
            : candidate))
          tabsRef.current = next
          return next
        })
        activeRef.current = entry.path
        setActive(entry.path)
        doReveal(entry.path, { index: 0, length: 0 })
        notify(t('已恢复检查点'), 'success')
      }, [doReveal, notify, openFileAtRoot, pushHistory, t])

      const applyCodeAt = useCallback((code, start, end, expectedText) => {
        const path = activeRef.current
        if (!path) {
          notify(t('请先打开文件'), 'warn')
          return
        }
        const tab = tabsRef.current.find((entry) => entry.path === path)
        if (!tab) return
        if (expectedText !== undefined && tab.text !== expectedText) {
          notify(t('文件内容已变化，请重新预览'), 'warn')
          return
        }
        const from = clamp(start, 0, tab.text.length)
        const to = clamp(end, from, tab.text.length)
        const nextText = tab.text.slice(0, from) + code + tab.text.slice(to)
        pushHistory(path, tab.text, t('AI 修改前'))
        setTabs((previous) => {
          const next = previous.map((entry) => (entry.path === path ? { ...entry, text: nextText } : entry))
          tabsRef.current = next
          return next
        })
        doReveal(path, { index: from + code.length, length: 0 })
        notify(t('已应用到编辑器'), 'success')
      }, [doReveal, notify, pushHistory, t])

      const previewCode = useCallback((code) => {
        const path = activeRef.current
        if (!path) {
          notify(t('请先打开文件'), 'warn')
          return
        }
        const tab = tabsRef.current.find((entry) => entry.path === path)
        if (!tab) return
        const hasSelection = cursor.path === path && cursor.end > cursor.start
        const start = cursor.path === path ? cursor.start : tab.text.length
        const end = hasSelection ? cursor.end : start
        const snapshot = tab.text
        const diff = buildAiDiff(snapshot.slice(start, end), code)
        showModal({
          kind: 'diff',
          title: t('AI 修改预览'),
          diff,
          applyLabel: t('应用'),
          onApply: () => applyCodeAt(code, start, end, snapshot),
        })
      }, [applyCodeAt, cursor, notify, showModal, t])

      const applyMultiFilePatch = useCallback((text) => {
        const patches = parseMultiFilePatch(text)
        if (patches.length === 0) {
          notify(t('没有解析到多文件补丁'), 'warn')
          return
        }
        const invalid = patches.find((patch) => (
          !patch.path
          || patch.path.startsWith('/')
          || /^[A-Za-z]:/.test(patch.path)
          || patch.path.split('/').includes('..')
        ))
        if (invalid) {
          notify(t('补丁包含非法路径'), 'error')
          return
        }
        showModal({
          kind: 'choice',
          title: t('多文件补丁'),
          message: [
            `${t('将直接写入磁盘并覆盖同名文件')}：`,
            '',
            ...patches.map((patch) => `• ${patch.path}  (${patch.text.split('\n').length} ${t('行')})`),
            '',
            t('已打开文件的本地修改会先进入检查点。'),
          ].join('\n'),
          actions: [
            { label: t('取消') },
            {
              label: t('应用并保存'),
              primary: true,
              run: async () => {
                let applied = 0
                for (const patch of patches) {
                  const open = tabsRef.current.find((tab) => tab.path === patch.path)
                  if (open) pushHistory(open.path, open.text, t('多文件补丁前'))
                  const body = {
                    root: rootRef.current,
                    path: patch.path,
                    text: patch.text,
                  }
                  if (open?.version) body.version = open.version
                  const saved = await api('/file', {
                    method: 'POST',
                    body: JSON.stringify(body),
                  })
                  if (open) {
                    setTabs((previous) => {
                      const next = previous.map((tab) => (tab.path === patch.path
                        ? {
                          ...tab,
                          text: patch.text,
                          original: patch.text,
                          version: saved.version,
                          size: saved.size,
                          language: languageOf(patch.path),
                          loading: false,
                          error: null,
                          externalChange: false,
                          externalMissing: false,
                          ignoredVersion: null,
                          ignoredMissing: false,
                        }
                        : tab))
                      tabsRef.current = next
                      return next
                    })
                  }
                  applied += 1
                }
                notify(t('已应用 {count} 个文件').replace('{count}', String(applied)), 'success')
              },
            },
          ],
        })
      }, [notify, pushHistory, showModal, t])

      const copyPath = useCallback(async (node) => {
        try {
          await navigator.clipboard.writeText(node.rel)
          notify(t('已复制'), 'success')
        } catch {
          notify(t('复制失败'), 'error')
        }
      }, [notify, t])

      const reloadAfterReplace = useCallback(async (paths) => {
        for (const path of paths || []) {
          if (!tabsRef.current.some((tab) => tab.path === path)) continue
          try {
            const data = await api(`/file?root=${encodeURIComponent(rootRef.current)}&path=${encodeURIComponent(path)}`)
            setTabs((previous) => {
              const next = previous.map((tab) => (tab.path === path
                ? { ...tab, text: data.text, original: data.text, version: data.version, size: data.size, error: null }
                : tab))
              tabsRef.current = next
              return next
            })
          } catch {
            /* the next open retries */
          }
        }
      }, [])

      const reloadTabFromDisk = useCallback(async (path) => {
        const currentTab = tabsRef.current.find((tab) => tab.path === path)
        if (currentTab) pushHistory(path, currentTab.text, t('重新加载前'))
        try {
          const data = await api(`/file?root=${encodeURIComponent(rootRef.current)}&path=${encodeURIComponent(path)}`)
          setTabs((previous) => {
            const next = previous.map((tab) => (tab.path === path
              ? {
                ...tab,
                text: data.text,
                original: data.text,
                version: data.version,
                size: data.size,
                language: data.language,
                loading: false,
                error: null,
                externalChange: false,
                externalMissing: false,
                externalVersion: null,
                ignoredVersion: null,
                ignoredMissing: false,
              }
              : tab))
            tabsRef.current = next
            return next
          })
          notify(t('已从磁盘重新加载'), 'success')
        } catch (error) {
          notify(error.message, 'error')
        }
      }, [notify, pushHistory, t])

      const keepExternal = useCallback((path, missing = false) => {
        setTabs((previous) => {
          const next = previous.map((tab) => (tab.path === path
            ? {
              ...tab,
              version: missing ? tab.version : (tab.externalVersion || tab.version),
              externalChange: false,
              externalMissing: false,
              ignoredVersion: missing ? tab.ignoredVersion : (tab.externalVersion || tab.version),
              ignoredMissing: missing || tab.ignoredMissing,
            }
            : tab))
          tabsRef.current = next
          return next
        })
      }, [])

      useEffect(() => {
        let cancelled = false
        let running = false
        const poll = async () => {
          if (running || cancelled || document.visibilityState === 'hidden') return
          running = true
          try {
            const root = rootRef.current
            const snapshot = tabsRef.current.filter((tab) => !tab.loading && !tab.error && tab.path).slice(0, 12)
            for (const tab of snapshot) {
              if (cancelled || rootRef.current !== root) return
              try {
                const stat = await api(`/file/stat?root=${encodeURIComponent(root)}&path=${encodeURIComponent(tab.path)}`)
                if (cancelled) return
                const current = tabsRef.current.find((entry) => entry.path === tab.path)
                if (!current) continue
                if (!stat.exists) {
                  if (current.ignoredMissing) continue
                  if (!current.externalMissing) {
                    setTabs((previous) => {
                      const next = previous.map((entry) => (entry.path === tab.path
                        ? { ...entry, externalMissing: true, externalChange: false }
                        : entry))
                      tabsRef.current = next
                      return next
                    })
                  }
                  continue
                }
                if (current.externalMissing || current.ignoredMissing) {
                  setTabs((previous) => {
                    const next = previous.map((entry) => (entry.path === tab.path
                      ? { ...entry, externalMissing: false, ignoredMissing: false }
                      : entry))
                    tabsRef.current = next
                    return next
                  })
                }
                if (stat.version === current.version) continue
                if (current.ignoredVersion === stat.version) continue
                if (current.text !== current.original) {
                  if (current.externalVersion === stat.version) continue
                  setTabs((previous) => {
                    const next = previous.map((entry) => (entry.path === tab.path
                      ? { ...entry, externalChange: true, externalVersion: stat.version }
                      : entry))
                    tabsRef.current = next
                    return next
                  })
                  continue
                }
                const file = await api(`/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(tab.path)}`)
                if (cancelled) return
                setTabs((previous) => {
                  const next = previous.map((entry) => (
                    entry.path === tab.path && entry.text === entry.original && entry.version !== file.version
                      ? {
                        ...entry,
                        text: file.text,
                        original: file.text,
                        version: file.version,
                        size: file.size,
                        language: file.language,
                        externalChange: false,
                        externalMissing: false,
                        externalVersion: null,
                        ignoredVersion: null,
                        ignoredMissing: false,
                      }
                      : entry
                  ))
                  tabsRef.current = next
                  return next
                })
              } catch {
                /* a missing stat or transient failure leaves the buffer alone */
              }
            }
          } finally {
            running = false
          }
        }
        const timer = setInterval(poll, 3000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      useEffect(() => {
        if (view !== 'explorer' || !root) return undefined
        let cancelled = false
        let running = false
        const poll = async () => {
          if (running || cancelled || document.visibilityState === 'hidden') return
          running = true
          try {
            const dirs = [
              '',
              ...Object.keys(expanded)
                .filter((rel) => rel && expanded[rel] && treeRef.current[rel])
                .slice(0, 12),
            ]
            for (const rel of dirs) {
              if (cancelled) return
              await loadDir(rel)
            }
          } catch {
            /* a removed directory or a transient failure keeps the previous tree */
          } finally {
            running = false
          }
        }
        const timer = setInterval(poll, 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [view, root, expanded, loadDir])

      useEffect(() => {
        const tab = tabs.find((entry) => entry.path === active)
        if (!tab || tab.loading || tab.error || !['python', 'typescript', 'javascript'].includes(tab.language)) {
          diagnosticsSeq.current += 1
          diagnosticsPath.current = ''
          setDiagnostics([])
          setDiagnosticsBusy(false)
          return undefined
        }
        if (diagnosticsPath.current !== tab.path) {
          diagnosticsPath.current = tab.path
          setDiagnostics([])
        }
        const sequence = diagnosticsSeq.current + 1
        diagnosticsSeq.current = sequence
        setDiagnosticsBusy(true)
        const timer = setTimeout(async () => {
          try {
            const data = await api('/lsp/diagnostics', {
              method: 'POST',
              body: JSON.stringify({
                root,
                path: tab.path,
                text: tab.text,
              }),
            })
            if (diagnosticsSeq.current === sequence) setDiagnostics(Array.isArray(data.diagnostics) ? data.diagnostics : [])
          } catch {
            if (diagnosticsSeq.current === sequence) setDiagnostics([])
          } finally {
            if (diagnosticsSeq.current === sequence) setDiagnosticsBusy(false)
          }
        }, 1200)
        return () => clearTimeout(timer)
      }, [active, tabs, root])

      useEffect(() => {
        ideMemory.history = history
      }, [history])

      const openContextMenu = useCallback((event, node) => {
        const element = rootElRef.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        const x = clamp(event.clientX - rect.left, 8, Math.max(8, rect.width - 224))
        const y = clamp(event.clientY - rect.top, 8, Math.max(8, rect.height - 250))
        setContextMenu({ x, y, node })
      }, [])

      const startResize = (kind, event) => {
        event.preventDefault()
        const startX = event.clientX
        const startValue = kind === 'side' ? sideW : chatW
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX
          if (kind === 'side') setSideW(clamp(startValue + delta, 190, 520))
          else setChatW(clamp(startValue - delta, 300, 760))
        }
        const onUp = () => {
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const startTerminalResize = (event) => {
        event.preventDefault()
        const startY = event.clientY
        const startValue = terminalHeight
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
        const onMove = (moveEvent) => {
          setTerminalHeight(clamp(startValue - (moveEvent.clientY - startY), 120, 480))
        }
        const onUp = () => {
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const activeTab = tabs.find((tab) => tab.path === active) || null
      const dirty = useMemo(
        () => new Set(tabs.filter((tab) => !tab.loading && !tab.error && tab.text !== tab.original).map((tab) => tab.path)),
        [tabs],
      )
      const rootTitle = roots.find((entry) => entry.path === root)?.title || basename(root)
      const lineInfo = useMemo(() => {
        if (!activeTab || cursor.path !== activeTab.path) return { line: 1, column: 1, selected: 0 }
        const before = activeTab.text.slice(0, cursor.start)
        const line = before.split('\n').length
        const column = cursor.start - before.lastIndexOf('\n')
        return { line, column, selected: Math.max(0, cursor.end - cursor.start) }
      }, [activeTab, cursor])

      const wrap = (children) => h('div', { className: 'dsh-ide-root', ref: rootElRef },
        h('style', null, CSS),
        children,
      )

      if (fatal) {
        return wrap(h('div', { className: 'ide-fatal' },
          h('div', { className: 'ide-fatal-icon' }, h(Icon, { name: 'alert', size: 28 })),
          h('div', { className: 'ide-fatal-title' }, t('工作区加载失败')),
          h('div', { className: 'ide-fatal-message' }, fatal),
          h('button', { type: 'button', className: 'ide-button is-primary', onClick: () => window.location.reload() }, t('重新加载')),
        ))
      }

      if (!boot) {
        return wrap(h('div', { className: 'ide-fatal' },
          h(Spinner, { size: 26 }),
          h('div', { className: 'ide-fatal-message' }, t('加载中')),
        ))
      }

      return wrap(h(Fragment, null,
        h('div', { className: 'ide-titlebar' },
          h('div', { className: 'ide-brand' },
            h('span', { className: 'ide-brand-icon' }, h(Icon, { name: 'code', size: 17 })),
            h('span', { className: 'ide-brand-name' }, 'DSH IDE'),
          ),
          h('div', { className: 'ide-workspace', title: root || t('切换工作区') },
            h(Icon, { name: 'folderOpen', size: 14 }),
            h('select', {
              className: 'ide-workspace-select',
              value: root,
              onChange: (event) => switchRoot(event.target.value),
              'aria-label': t('工作区'),
            }, roots.map((entry) => h('option', { key: entry.path, value: entry.path, title: entry.path }, entry.title))),
            h(Icon, { name: 'chevronDown', size: 12, className: 'ide-workspace-chevron' }),
          ),
          h(IconButton, {
            name: 'folderPlus',
            title: t('打开文件夹'),
            size: 15,
            className: 'ide-open-folder',
            disabled: pickingFolder,
            onClick: openFolder,
          }, pickingFolder ? h(Spinner, { size: 12 }) : null),
          h(IconButton, {
            name: 'edit',
            title: t('输入文件夹路径'),
            size: 14,
            onClick: openFolderManual,
          }),
          h('div', { className: 'ide-titlebar-spacer' }),
          h('div', { className: 'ide-titlebar-actions' },
            saving ? h('span', { className: 'ide-saving' }, h(Spinner, { size: 12 })) : null,
            h(IconButton, {
              name: 'save',
              title: t('保存'),
              size: 15,
              disabled: !activeTab || activeTab.loading,
              onClick: () => activeTab && saveTabPath(activeTab.path),
            }),
            h(IconButton, {
              name: 'save',
              title: t('全部保存'),
              size: 15,
              className: 'ide-save-all',
              disabled: dirty.size === 0,
              onClick: async () => {
                for (const tab of tabsRef.current) {
                  if (tab.text !== tab.original) await saveTabPath(tab.path)
                }
              },
            }),
            h('span', { className: 'ide-titlebar-sep' }),
            h(IconButton, {
              name: 'terminal',
              title: `${t('终端')} (Ctrl+\`)`,
              size: 16,
              active: terminalOpen,
              onClick: () => setTerminalOpen((value) => !value),
            }),
            h(IconButton, {
              name: 'sparkle',
              title: t('显示/隐藏 AI 面板'),
              size: 16,
              active: chatOpen,
              onClick: () => setChatOpen((value) => !value),
            }),
          ),
        ),
        h('div', { className: 'ide-body' },
          h('div', { className: 'ide-activity' },
            h('div', { className: 'ide-activity-group' },
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'explorer' ? ' is-active' : ''}`,
                title: t('资源管理器'),
                onClick: () => setView('explorer'),
              }, h(Icon, { name: 'folder', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'search' ? ' is-active' : ''}`,
                title: t('搜索'),
                onClick: () => setView('search'),
              }, h(Icon, { name: 'search', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'git' ? ' is-active' : ''}`,
                title: t('源代码管理'),
                onClick: () => setView('git'),
              }, h(Icon, { name: 'branch', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'outline' ? ' is-active' : ''}`,
                title: t('大纲'),
                onClick: () => setView('outline'),
              }, h(Icon, { name: 'list', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'problems' ? ' is-active' : ''}`,
                title: diagnostics.length > 0 ? `${t('问题')} (${diagnostics.length})` : t('问题'),
                onClick: () => setView('problems'),
              }, h(Icon, { name: 'alert', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${view === 'history' ? ' is-active' : ''}`,
                title: t('检查点'),
                onClick: () => setView('history'),
              }, h(Icon, { name: 'clock', size: 19 })),
              h('button', {
                type: 'button',
                className: 'ide-activity-btn',
                title: t('快速打开'),
                onClick: () => setQuickOpen(true),
              }, h(Icon, { name: 'file', size: 19 })),
            ),
            h('div', { className: 'ide-activity-group' },
              h('button', {
                type: 'button',
                className: `ide-activity-btn${terminalOpen ? ' is-active' : ''}`,
                title: `${t('终端')} (Ctrl+\`)`,
                onClick: () => setTerminalOpen((value) => !value),
              }, h(Icon, { name: 'terminal', size: 19 })),
              h('button', {
                type: 'button',
                className: `ide-activity-btn${chatOpen ? ' is-active' : ''}`,
                title: t('显示/隐藏 AI 面板'),
                onClick: () => setChatOpen((value) => !value),
              }, h(Icon, { name: 'sparkle', size: 19 })),
            ),
          ),
          h('div', { className: 'ide-side', style: { width: sideW } },
            h('div', { className: 'ide-side-inner', style: { display: view === 'explorer' ? 'flex' : 'none' } },
              h(Explorer, {
                t,
                tree,
                expanded,
                active,
                dirty,
                loading: loadingRoot,
                filter,
                setFilter,
                quick,
                rootTitle,
                onToggleDir: toggleDir,
                onOpenFile: openFile,
                onContextMenu: openContextMenu,
                onNewFile: () => newEntry('file', activeTab ? dirname(activeTab.path) : ''),
                onNewFolder: () => newEntry('directory', activeTab ? dirname(activeTab.path) : ''),
                onRefresh: () => refreshAll(true),
                onCollapseAll: () => setExpanded({ '': true }),
              }),
            ),
            h('div', { className: 'ide-side-inner', style: { display: view === 'search' ? 'flex' : 'none' } },
              h(SearchPanel, {
                t,
                root,
                active: view === 'search',
                notify,
                confirm,
                onOpenHit: openHit,
                onReplaced: reloadAfterReplace,
              }),
            ),
            h('div', { className: 'ide-side-inner', style: { display: view === 'git' ? 'flex' : 'none' } },
              h(GitPanel, {
                t,
                root,
                active: view === 'git',
                notify,
                showModal,
                onOpenFile: openFile,
              }),
            ),
            h('div', { className: 'ide-side-inner', style: { display: view === 'outline' ? 'flex' : 'none' } },
              h(OutlinePanel, {
                t,
                tab: activeTab,
                onOpenLine: (line) => {
                  if (activeTab) openFileAtRoot(rootRef.current, activeTab.path, { line, column: 1 })
                },
              }),
            ),
            h('div', { className: 'ide-side-inner', style: { display: view === 'problems' ? 'flex' : 'none' } },
              h(ProblemsPanel, {
                t,
                tab: activeTab,
                diagnostics,
                busy: diagnosticsBusy,
                onOpen: (item) => {
                  if (activeTab) openFileAtRoot(rootRef.current, activeTab.path, { line: item.line, column: item.character })
                },
              }),
            ),
            h('div', { className: 'ide-side-inner', style: { display: view === 'history' ? 'flex' : 'none' } },
              h(HistoryPanel, {
                t,
                history,
                onRestore: restoreHistory,
                onClear: () => setHistory([]),
              }),
            ),
          ),
          h('div', {
            className: 'ide-splitter',
            onPointerDown: (event) => startResize('side', event),
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': t('显示/隐藏侧栏'),
          }),
          h('div', { className: 'ide-main' },
            h(TabBar, {
              tabs,
              active,
              dirty,
              t,
              onSelect: (path) => {
                activeRef.current = path
                setActive(path)
              },
              onClose: requestClose,
              onCloseAll: requestCloseAll,
            }),
            h(Breadcrumb, { tab: activeTab, t, onLsp: runLsp, lspBusy }),
            h('div', { className: 'ide-editor-wrap' },
              errorBanner
                ? h('div', { className: 'ide-banner is-error' },
                  h(Icon, { name: 'alert', size: 14 }),
                  h('span', null, errorBanner),
                  h('button', { type: 'button', className: 'ide-banner-action', onClick: () => refreshAll(true) }, t('重试')))
                : null,
              activeTab?.externalMissing
                ? h('div', { className: 'ide-banner is-error' },
                  h(Icon, { name: 'alert', size: 14 }),
                  h('span', null, t('文件已从磁盘上删除')),
                  h('button', {
                    type: 'button',
                    className: 'ide-banner-action',
                    onClick: () => requestClose(activeTab.path),
                  }, t('关闭标签')),
                  h('button', {
                    type: 'button',
                    className: 'ide-banner-action',
                    onClick: () => keepExternal(activeTab.path, true),
                  }, t('保留文本')))
                : activeTab?.externalChange
                  ? h('div', { className: 'ide-banner is-warn' },
                    h(Icon, { name: 'alert', size: 14 }),
                    h('span', null, t('文件已在磁盘上更改')),
                    h('button', {
                      type: 'button',
                      className: 'ide-banner-action',
                      onClick: () => reloadTabFromDisk(activeTab.path),
                    }, t('重新加载')),
                    h('button', {
                      type: 'button',
                      className: 'ide-banner-action',
                      onClick: () => keepExternal(activeTab.path),
                    }, t('保留我的更改')))
                  : null,
              activeTab
                ? (codeMirrorEnabled
                  ? h(CodeMirrorEditor, {
                    key: `cm:${activeTab.path}`,
                    tab: activeTab,
                    t,
                    root,
                    reveal,
                    onChange: updateText,
                    onSelection: updateSelection,
                    onLsp: runLsp,
                    onSave: (path) => saveTabPath(path),
                  })
                  : h(Editor, {
                    key: activeTab.path,
                    tab: activeTab,
                    t,
                    root,
                    reveal,
                    onChange: updateText,
                    onSelection: updateSelection,
                    onLsp: runLsp,
                    onSave: (path, retry) => {
                      if (retry) {
                        closeTabNow(path)
                        openFileAtRoot(rootRef.current, path)
                      } else {
                        saveTabPath(path)
                      }
                    },
                  }))
                : h('div', { className: 'ide-empty-editor' },
                  h('div', { className: 'ide-empty-logo' }, h(Icon, { name: 'code', size: 30 })),
                  h('div', { className: 'ide-empty-title' }, t('从左侧选择文件')),
                  h('div', { className: 'ide-empty-sub' }, t('或按 Ctrl+P 快速打开')),
                  h('div', { className: 'ide-empty-actions' },
                    h('button', { type: 'button', className: 'ide-button is-primary', onClick: openFolder },
                      h(Icon, { name: 'folderPlus', size: 14 }), t('打开文件夹')),
                    h('button', { type: 'button', className: 'ide-button', onClick: () => newEntry('file', '') },
                      h(Icon, { name: 'filePlus', size: 14 }), t('新建文件')),
                    h('button', { type: 'button', className: 'ide-button', onClick: () => setView('search') },
                      h(Icon, { name: 'search', size: 14 }), t('搜索')),
                  ),
                ),
            ),
            terminalOpen ? h('div', {
              className: 'ide-hsplitter',
              onPointerDown: startTerminalResize,
              role: 'separator',
              'aria-orientation': 'horizontal',
              'aria-label': t('调整终端高度'),
            }) : null,
            h(TerminalPanel, {
              key: root,
              t,
              root,
              open: terminalOpen,
              height: terminalHeight,
              onClose: () => setTerminalOpen(false),
              notify,
            }),
            h('div', { className: 'ide-statusbar' },
              h('div', { className: 'ide-status-left' },
                h('span', { className: 'ide-status-item' }, h(Icon, { name: 'folder', size: 12 }), rootTitle),
                dirty.size > 0 ? h('span', { className: 'ide-status-item is-warn' }, `${dirty.size} ${t('个文件')} ${t('未保存')}`) : null,
                activeTab ? h('span', { className: 'ide-status-item' }, formatBytes(activeTab.size)) : null,
              ),
              h('div', { className: 'ide-status-right' },
                activeTab ? h('span', { className: 'ide-status-item' }, `${t('行')} ${lineInfo.line}, ${t('列')} ${lineInfo.column}`) : null,
                lineInfo.selected > 0 ? h('span', { className: 'ide-status-item is-accent' }, `(${lineInfo.selected} ${t('选中')})`) : null,
                h('span', { className: 'ide-status-item' }, `${t('空格')}: 2`),
                h('span', { className: 'ide-status-item' }, 'UTF-8'),
                h('span', { className: 'ide-status-item' }, 'LF'),
                h('button', {
                  type: 'button',
                  className: `ide-status-item is-action${codeMirrorEnabled ? ' is-accent' : ''}`,
                  title: t('CodeMirror 6 编辑器'),
                  onClick: () => setCodeMirrorEnabled((value) => !value),
                }, codeMirrorEnabled ? 'CM 6' : 'CM 6 off'),
                activeTab ? h('span', { className: 'ide-status-item' }, activeTab.language) : null,
                h('span', { className: 'ide-status-item is-ai' },
                  h('span', { className: 'ide-status-dot' }),
                  model ? `${model.provider} · ${model.model}` : t('未配置模型')),
              ),
            ),
          ),
          h('div', {
            className: 'ide-splitter',
            style: { display: chatOpen ? 'block' : 'none' },
            onPointerDown: (event) => startResize('chat', event),
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': t('AI 助手'),
          }),
          h(ChatErrorBoundary, { key: root, width: chatW, open: chatOpen },
            h(ChatPanel, {
              t,
              root,
              tab: activeTab,
              cursor,
              model,
              width: chatW,
              open: chatOpen,
              onClose: () => setChatOpen(false),
              onApply: previewCode,
              onApplyPatch: applyMultiFilePatch,
              notify,
              showModal,
            }),
          ),
        ),
        contextMenu ? h(ContextMenu, {
          menu: contextMenu,
          t,
          onClose: () => setContextMenu(null),
          onNewFile: (parent) => newEntry('file', parent),
          onNewFolder: (parent) => newEntry('directory', parent),
          onRename: renameNode,
          onDelete: deleteNode,
          onCopyPath: copyPath,
        }) : null,
        h(QuickOpen, {
          open: quickOpen,
          root,
          t,
          onClose: () => setQuickOpen(false),
          onOpen: (path) => openFileAtRoot(rootRef.current, path),
        }),
        h(ModalHost, { modal, t, onClose: closeModal }),
        toast ? h('div', { className: `ide-toast tone-${toast.tone}` },
          h(Icon, { name: toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'sparkle', size: 14 }),
          h('span', null, toast.message)) : null,
      ))
    }

    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    const CSS = `
.dsh-ide-root {
  --ide-bg: var(--dsw-alias-bg-base);
  --ide-panel: var(--dsw-alias-bg-layer-1);
  --ide-elevated: var(--dsw-alias-bg-layer-2);
  --ide-overlay: var(--dsw-alias-bg-overlay);
  --ide-border: var(--dsw-alias-border-l1);
  --ide-border-strong: var(--dsw-alias-border-l2);
  --ide-text: var(--dsw-alias-label-primary);
  --ide-muted: var(--dsw-alias-label-secondary);
  --ide-accent: var(--dsw-alias-brand-primary);
  --ide-success: var(--dsw-alias-state-success-primary);
  --ide-error: var(--dsw-alias-state-error-primary);
  --ide-warn: var(--dsw-alias-state-warn-primary);
  --ide-idle: var(--dsw-alias-state-idle-primary);
  --ide-sidebar: var(--dsw-specific-sidebar-fill);
  --ide-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --ide-hover-strong: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  --ide-active: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  --ide-accent-soft: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
  --ide-mono: ${MONO};
  --ide-syn-keyword: var(--dsw-alias-brand-primary);
  --ide-syn-string: var(--dsw-alias-state-success-primary);
  --ide-syn-number: var(--dsw-alias-state-warn-primary);
  --ide-syn-comment: color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent);
  --ide-syn-function: color-mix(in oklab, var(--dsw-alias-brand-primary) 62%, var(--dsw-alias-state-error-primary));
  --ide-syn-type: color-mix(in oklab, var(--dsw-alias-brand-primary) 58%, var(--dsw-alias-state-success-primary));
  --ide-syn-punct: color-mix(in srgb, var(--dsw-alias-label-primary) 60%, transparent);
  --ide-syn-key: color-mix(in oklab, var(--dsw-alias-brand-primary) 48%, var(--dsw-alias-state-warn-primary));
  --ide-syn-tag: var(--dsw-alias-state-error-primary);
  --ide-syn-attr: color-mix(in oklab, var(--dsw-alias-brand-primary) 44%, var(--dsw-alias-state-warn-primary));
  --ide-syn-head: color-mix(in oklab, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-label-primary));
  --ide-syn-link: var(--dsw-alias-brand-primary);

  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--ide-bg);
  color: var(--ide-text);
  font-family: var(--dsh-font-family-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
}

.dsh-ide-root *, .dsh-ide-root *::before, .dsh-ide-root *::after { box-sizing: border-box; }
.dsh-ide-root button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.dsh-ide-root input, .dsh-ide-root textarea, .dsh-ide-root select { font: inherit; color: inherit; }
.dsh-ide-root a { color: var(--ide-accent); }
.dsh-ide-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.dsh-ide-root ::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.dsh-ide-root ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 46%, transparent); background-clip: padding-box; border: 2px solid transparent; }
.dsh-ide-root ::-webkit-scrollbar-track { background: transparent; }
.dsh-ide-root ::-webkit-scrollbar-corner { background: transparent; }

/* Title bar */
.ide-titlebar {
  flex: 0 0 44px;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-bottom: 1px solid var(--ide-border);
  background: var(--ide-panel);
}
.ide-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ide-brand-icon {
  width: 26px; height: 26px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--ide-accent), color-mix(in oklab, var(--ide-accent) 55%, var(--dsw-alias-state-error-primary)));
  box-shadow: 0 1px 4px color-mix(in srgb, var(--ide-accent) 30%, transparent);
}
.ide-brand-name { font-size: 13px; font-weight: 680; letter-spacing: .01em; white-space: nowrap; }
.ide-workspace {
  display: flex; align-items: center; gap: 5px;
  height: 28px; max-width: 330px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 7px;
  color: var(--ide-muted); background: transparent;
  transition: background .12s ease, border-color .12s ease;
}
.ide-workspace:hover { background: var(--ide-hover); border-color: var(--ide-border); }
.ide-workspace-select {
  appearance: none; -webkit-appearance: none;
  border: 0; outline: 0; background: transparent;
  color: var(--ide-text); font-size: 12.5px; font-weight: 560;
  max-width: 260px; padding: 0; cursor: pointer;
}
.ide-workspace-chevron { margin-left: -3px; opacity: .7; }
.ide-titlebar-spacer { flex: 1 1 auto; }
.ide-titlebar-actions { display: flex; align-items: center; gap: 2px; }
.ide-titlebar-sep { width: 1px; height: 18px; background: var(--ide-border); margin: 0 5px; }
.ide-saving { display: inline-flex; margin-right: 4px; }
.ide-save-all { opacity: .78; }

.ide-iconbtn {
  width: 28px; height: 28px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted);
  transition: background .12s ease, color .12s ease;
}
.ide-iconbtn:hover:not(:disabled) { background: var(--ide-hover); color: var(--ide-text); }
.ide-iconbtn:active:not(:disabled) { background: var(--ide-hover-strong); }
.ide-iconbtn.is-active { background: var(--ide-active); color: var(--ide-accent); }
.ide-iconbtn:disabled { opacity: .38; cursor: default; }

/* Main split */
.ide-body { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
.ide-activity {
  flex: 0 0 48px; width: 48px;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 6px 0 8px;
  background: var(--ide-sidebar);
  border-right: 1px solid var(--ide-border);
}
.ide-activity-group { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.ide-activity-btn {
  position: relative; width: 38px; height: 38px; border-radius: 9px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted);
  transition: background .12s ease, color .12s ease;
}
.ide-activity-btn:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-activity-btn.is-active { color: var(--ide-accent); background: var(--ide-active); }
.ide-activity-btn.is-active::before {
  content: ""; position: absolute; left: -5px; top: 9px; bottom: 9px; width: 2px;
  border-radius: 2px; background: var(--ide-accent);
}

.ide-side { flex: 0 0 auto; min-width: 0; display: flex; background: var(--ide-sidebar); }
.ide-side-inner { width: 100%; height: 100%; min-height: 0; flex-direction: column; }
.ide-splitter { flex: 0 0 5px; width: 5px; position: relative; z-index: 6; cursor: col-resize; background: transparent; }
.ide-splitter::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 1px;
  background: var(--ide-border); transition: background .12s ease;
}
.ide-splitter:hover::after { background: var(--ide-accent); width: 2px; left: 1.5px; }

/* Panels */
.ide-side-head {
  flex: 0 0 36px; height: 36px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 6px 0 12px;
}
.ide-side-title {
  display: flex; align-items: center; gap: 7px;
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; font-weight: 680; letter-spacing: .055em; text-transform: uppercase;
  color: var(--ide-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ide-side-title span { overflow: hidden; text-overflow: ellipsis; }
.ide-side-actions { display: flex; align-items: center; gap: 0; opacity: .78; }
.ide-side-actions:hover { opacity: 1; }
.ide-side-actions .ide-iconbtn { width: 24px; height: 24px; border-radius: 6px; }

/* Explorer */
.ide-explorer { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-explorer-filter {
  flex: 0 0 30px; height: 30px; margin: 2px 8px 6px;
  display: flex; align-items: center; gap: 6px; padding: 0 8px;
  border: 1px solid var(--ide-border); border-radius: 7px;
  background: color-mix(in srgb, var(--ide-bg) 72%, transparent);
  color: var(--ide-muted);
}
.ide-explorer-filter:focus-within { border-color: var(--ide-accent); box-shadow: 0 0 0 2px var(--ide-accent-soft); }
.ide-explorer-filter input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 12px; }
.ide-explorer-filter input::placeholder { color: var(--ide-muted); opacity: .8; }
.ide-mini-clear { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; color: var(--ide-muted); }
.ide-mini-clear:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-explorer-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 0 12px; }

.ide-tree { padding: 0 4px; }
.ide-tree-row {
  height: 24px; display: flex; align-items: center; gap: 4px;
  padding-right: 8px; border-radius: 5px;
  color: var(--ide-text); font-size: 12.5px;
  white-space: nowrap; overflow: hidden; cursor: pointer;
  user-select: none;
}
.ide-tree-row:hover { background: var(--ide-hover); }
.ide-tree-row.is-active { background: var(--ide-active); color: var(--ide-text); }
.ide-tree-row.is-active .ide-tree-name { font-weight: 560; }
.ide-tree-chevron { flex: 0 0 12px; width: 12px; color: var(--ide-muted); }
.ide-tree-chevron-spacer { flex: 0 0 12px; width: 12px; }
.ide-tree-folder { flex: 0 0 auto; color: var(--ide-accent); opacity: .9; }
.ide-tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ide-tree-children { position: relative; }
.ide-tree-loading { height: 22px; display: flex; align-items: center; gap: 6px; color: var(--ide-muted); font-size: 11px; }
.ide-dirty-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--ide-accent); margin-left: auto; }
.ide-tree-row .ide-dirty-dot { margin-left: auto; }

.ide-quick-list { padding: 2px 6px; }
.ide-quick-row {
  width: 100%; height: 28px; display: flex; align-items: center; gap: 6px;
  padding: 0 6px; border-radius: 5px; text-align: left; color: var(--ide-text);
}
.ide-quick-row:hover { background: var(--ide-hover); }
.ide-quick-name { flex: 0 0 auto; max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.ide-quick-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ide-muted); font-size: 11px; }
.ide-empty-small { padding: 22px 16px; color: var(--ide-muted); font-size: 12px; text-align: center; }
.ide-tree-skeleton { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; }
.ide-skeleton-row { height: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--ide-hover), var(--ide-hover-strong), var(--ide-hover)); background-size: 200% 100%; animation: ide-skeleton 1.2s ease-in-out infinite; }

/* File glyphs */
.ide-fileglyph { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; }
.ide-fileglyph.tone-blue { color: var(--dsw-alias-brand-primary); }
.ide-fileglyph.tone-yellow { color: var(--dsw-alias-state-warn-primary); }
.ide-fileglyph.tone-amber { color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 76%, var(--dsw-alias-state-error-primary)); }
.ide-fileglyph.tone-purple { color: color-mix(in oklab, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-error-primary)); }
.ide-fileglyph.tone-orange { color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary)); }
.ide-fileglyph.tone-cyan { color: color-mix(in oklab, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-state-success-primary)); }
.ide-fileglyph.tone-green { color: var(--dsw-alias-state-success-primary); }
.ide-fileglyph.tone-sky { color: color-mix(in oklab, var(--dsw-alias-brand-primary) 65%, var(--dsw-alias-state-success-primary)); }
.ide-fileglyph.tone-rust { color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 65%, var(--dsw-alias-state-error-primary)); }
.ide-fileglyph.tone-pink { color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 60%, var(--dsw-alias-brand-primary)); }
.ide-fileglyph.tone-lime { color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 70%, var(--dsw-alias-state-warn-primary)); }
.ide-fileglyph.tone-slate { color: var(--ide-muted); }

/* Search */
.ide-search-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-search-form { flex: 0 0 auto; padding: 2px 8px 0; }
.ide-search-field {
  border: 1px solid var(--ide-border); border-radius: 8px; overflow: hidden;
  background: color-mix(in srgb, var(--ide-bg) 72%, transparent);
}
.ide-search-field:focus-within { border-color: var(--ide-accent); box-shadow: 0 0 0 2px var(--ide-accent-soft); }
.ide-search-input-row { height: 32px; display: flex; align-items: center; gap: 6px; padding: 0 7px; color: var(--ide-muted); }
.ide-search-input-row.is-replace { border-top: 1px solid var(--ide-border); }
.ide-search-input-row input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; font-size: 12.5px; }
.ide-search-input-row input::placeholder { color: var(--ide-muted); opacity: .8; }
.ide-search-toggles { display: flex; align-items: center; gap: 1px; }
.ide-toggle {
  min-width: 24px; height: 22px; padding: 0 4px; border-radius: 4px;
  font-size: 10.5px; font-weight: 600; color: var(--ide-muted);
}
.ide-toggle:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-toggle.is-on { background: var(--ide-accent-soft); color: var(--ide-accent); }
.ide-search-all { width: 24px; height: 24px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; color: var(--ide-muted); }
.ide-search-all:hover:not(:disabled) { background: var(--ide-hover); color: var(--ide-accent); }
.ide-search-all:disabled { opacity: .35; }
.ide-include-toggle {
  width: 100%; height: 27px; display: flex; align-items: center; gap: 4px;
  padding: 0 9px; border-top: 1px solid var(--ide-border);
  color: var(--ide-muted); font-size: 11px;
}
.ide-include-toggle:hover { background: var(--ide-hover); }
.ide-search-include { padding: 0 7px 7px; }
.ide-search-include input {
  width: 100%; height: 26px; padding: 0 7px; border: 1px solid var(--ide-border);
  border-radius: 5px; outline: 0; background: transparent; font-size: 11.5px;
}
.ide-search-include input:focus { border-color: var(--ide-accent); }
.ide-search-summary {
  flex: 0 0 auto; height: 30px; display: flex; align-items: center; gap: 7px;
  padding: 0 12px; color: var(--ide-muted); font-size: 11px;
  border-bottom: 1px solid var(--ide-border);
}
.ide-search-truncated { color: var(--ide-warn); }
.ide-search-results { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 12px; }
.ide-result-group { border-bottom: 1px solid color-mix(in srgb, var(--ide-border) 55%, transparent); }
.ide-result-file {
  width: 100%; height: 28px; display: flex; align-items: center; gap: 5px;
  padding: 0 10px; text-align: left; color: var(--ide-text);
}
.ide-result-file:hover { background: var(--ide-hover); }
.ide-result-file-name { font-size: 12.5px; font-weight: 560; flex: 0 0 auto; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ide-result-file-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ide-muted); font-size: 10.5px; }
.ide-result-count {
  flex: 0 0 auto; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ide-hover-strong); color: var(--ide-muted); font-size: 10px;
}
.ide-result-matches { padding: 0 4px 4px; }
.ide-result-row {
  position: relative; display: flex; align-items: flex-start; gap: 7px;
  min-height: 26px; padding: 4px 26px 4px 9px; border-radius: 5px;
  cursor: pointer; font-family: var(--ide-mono); font-size: 11.5px; line-height: 17px;
}
.ide-result-row:hover { background: var(--ide-hover); }
.ide-result-loc { flex: 0 0 42px; color: var(--ide-muted); font-size: 10.5px; padding-top: 1px; }
.ide-result-preview { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-all; color: var(--ide-text); }
.ide-result-mark { background: var(--ide-accent-soft); color: var(--ide-text); border-radius: 2px; padding: 0 1px; }
.ide-result-replace {
  position: absolute; right: 4px; top: 4px; width: 20px; height: 20px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted); opacity: 0;
}
.ide-result-row:hover .ide-result-replace { opacity: 1; }
.ide-result-replace:hover { background: var(--ide-accent-soft); color: var(--ide-accent); }

/* Editor column */
.ide-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--ide-bg); }
.ide-tabs {
  flex: 0 0 36px; height: 36px; display: flex; align-items: stretch;
  overflow-x: auto; overflow-y: hidden;
  background: var(--ide-panel); border-bottom: 1px solid var(--ide-border);
  scrollbar-width: none;
}
.ide-tabs::-webkit-scrollbar { display: none; }
.ide-tab {
  position: relative; flex: 0 0 auto; min-width: 112px; max-width: 230px;
  display: flex; align-items: center; gap: 6px; padding: 0 5px 0 11px;
  border-right: 1px solid var(--ide-border);
  color: var(--ide-muted); cursor: pointer;
  transition: background .12s ease, color .12s ease;
}
.ide-tab:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-tab.is-active { background: var(--ide-bg); color: var(--ide-text); box-shadow: inset 0 2px 0 var(--ide-accent); }
.ide-tab-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.ide-tab .ide-dirty-dot { margin-left: 0; }
.ide-tab-close {
  flex: 0 0 18px; width: 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted); opacity: .6;
}
.ide-tab-close:hover { background: var(--ide-hover-strong); color: var(--ide-text); opacity: 1; }
.ide-tabs-spacer { flex: 1 1 auto; min-width: 8px; }
.ide-tab-action {
  flex: 0 0 28px; width: 28px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted);
}
.ide-tab-action:hover { background: var(--ide-hover); color: var(--ide-text); }

.ide-breadcrumb {
  flex: 0 0 28px; height: 28px; display: flex; align-items: center; gap: 2px;
  padding: 0 12px; border-bottom: 1px solid var(--ide-border);
  color: var(--ide-muted); font-size: 11.5px; overflow: hidden; white-space: nowrap;
}
.ide-breadcrumb-spacer { flex: 1 1 auto; }
.ide-crumb-icon { margin-right: 3px; opacity: .8; }
.ide-crumb-sep { opacity: .55; margin: 0 1px; }
.ide-crumb { overflow: hidden; text-overflow: ellipsis; }
.ide-crumb.is-file { color: var(--ide-text); }
.ide-breadcrumb-badge {
  flex: 0 0 auto; margin-left: 8px; padding: 1px 6px; border-radius: 8px;
  background: var(--ide-accent-soft); color: var(--ide-accent); font-size: 10px;
}
.ide-lsp-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; margin-right: 6px; }
.ide-lsp-action {
  height: 18px; padding: 0 5px; border-radius: 4px;
  border: 1px solid transparent; color: var(--ide-muted); font-size: 9.5px;
}
.ide-lsp-action:hover:not(:disabled) { background: var(--ide-hover); color: var(--ide-text); border-color: var(--ide-border); }
.ide-lsp-action:disabled { opacity: .4; cursor: default; }
.ide-hover-content { max-height: 60vh; overflow: auto; }
.ide-lsp-results { display: flex; flex-direction: column; gap: 2px; max-height: 55vh; overflow: auto; }
.ide-lsp-result {
  width: 100%; height: 28px; display: flex; align-items: center; gap: 7px;
  padding: 0 8px; border-radius: 5px; text-align: left; color: var(--ide-text);
}
.ide-lsp-result:hover { background: var(--ide-hover); }
.ide-lsp-result-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.ide-lsp-result-pos { flex: 0 0 auto; color: var(--ide-muted); font-family: var(--ide-mono); font-size: 10px; }

.ide-editor-wrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ide-banner {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; font-size: 12px; border-bottom: 1px solid var(--ide-border);
}
.ide-banner.is-error { background: color-mix(in srgb, var(--ide-error) 10%, transparent); color: var(--ide-error); }
.ide-banner.is-warn { background: color-mix(in srgb, var(--ide-warn) 10%, transparent); color: var(--ide-warn); }
.ide-banner-action { margin-left: auto; text-decoration: underline; font-size: 11.5px; }

.ide-editor { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; background: var(--ide-bg); }
.ide-gutter {
  flex: 0 0 auto; overflow: hidden; position: relative;
  background: color-mix(in srgb, var(--ide-bg) 88%, var(--ide-panel));
  border-right: 1px solid color-mix(in srgb, var(--ide-border) 62%, transparent);
  user-select: none;
}
.ide-gutter-inner { padding: 10px 0 40px; will-change: transform; }
.ide-gutter-line {
  height: 20px; line-height: 20px; padding-right: 12px;
  font-family: var(--ide-mono); font-size: 11.5px; text-align: right;
  color: color-mix(in srgb, var(--ide-muted) 65%, transparent);
}
.ide-code { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.ide-highlight {
  position: absolute; top: 0; left: 0; margin: 0; padding: 10px 18px 40px;
  min-width: 100%; width: max-content;
  font-family: var(--ide-mono); font-size: 13px; line-height: 20px;
  white-space: pre; tab-size: 2; pointer-events: none; will-change: transform;
  color: var(--ide-text);
  user-select: none; -webkit-user-select: none;
}
.ide-highlight, .ide-highlight * { user-select: none; -webkit-user-select: none; }
.ide-highlight::selection, .ide-highlight *::selection { background: transparent; color: inherit; }
.ide-highlight, .ide-textarea {
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0, "dlig" 0;
  font-kerning: none;
  letter-spacing: 0;
}
.ide-code-line { height: 20px; position: relative; }
.ide-active-line {
  position: absolute; top: 0; left: 0; width: 100%; height: 20px; z-index: 0;
  background: color-mix(in srgb, var(--ide-accent) 4%, transparent);
  pointer-events: none;
}
.ide-line-text { position: relative; z-index: 3; }
.ide-selection {
  position: absolute; top: 0; height: 20px; z-index: 1;
  border-radius: 2px;
  background: color-mix(in srgb, var(--ide-accent) 26%, transparent);
  pointer-events: none;
}
.ide-bracket-match {
  position: absolute; top: 0; height: 20px; z-index: 2;
  border-radius: 2px; background: var(--ide-accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ide-accent) 45%, transparent);
  pointer-events: none;
}
.ide-caret {
  position: absolute; top: 0; width: 2px; height: 20px; z-index: 4;
  border-radius: 1px; background: var(--ide-accent);
  pointer-events: none;
  animation: ide-caret-blink 1.05s step-end infinite;
}
.ide-textarea {
  position: absolute; inset: 0; width: 100%; height: 100%;
  margin: 0; padding: 10px 18px 40px; border: 0; outline: 0; resize: none;
  background: transparent; color: transparent; caret-color: var(--ide-accent);
  font-family: var(--ide-mono); font-size: 13px; line-height: 20px;
  white-space: pre; overflow: auto; tab-size: 2; z-index: 2;
  -webkit-text-fill-color: transparent;
  user-select: text; -webkit-user-select: text;
}
.ide-textarea.has-custom-caret { caret-color: transparent; }
.ide-textarea::selection { background: color-mix(in srgb, var(--ide-accent) 34%, transparent); -webkit-text-fill-color: transparent; }
.ide-textarea.has-custom-selection::selection { background: transparent; -webkit-text-fill-color: transparent; }
.ide-suggest {
  position: absolute; z-index: 6; width: 240px; max-height: 190px;
  overflow: auto; padding: 4px;
  background: var(--ide-elevated); border: 1px solid var(--ide-border-strong);
  border-radius: 7px; box-shadow: 0 12px 30px color-mix(in srgb, #000 22%, transparent);
}
.ide-suggest-head {
  padding: 3px 7px 4px; color: var(--ide-muted);
  font-size: 9.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
}
.ide-suggest-row {
  width: 100%; height: 23px; display: flex; align-items: center;
  padding: 0 7px; border-radius: 4px; text-align: left;
  color: var(--ide-text); font-family: var(--ide-mono); font-size: 11.5px;
}
.ide-suggest-row:hover, .ide-suggest-row.is-selected { background: var(--ide-active); color: var(--ide-text); }
.ide-suggest-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ide-suggest-detail {
  flex: 0 1 auto; max-width: 92px; margin-left: 8px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--ide-muted); font-family: var(--ide-sans); font-size: 9.5px;
}
@keyframes ide-caret-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
.ide-editor:focus-within .ide-gutter { background: var(--ide-bg); }
.ide-editor-state {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--ide-muted); font-size: 12.5px; padding: 30px;
}
.ide-editor-state.is-error { color: var(--ide-error); }
.ide-editor-state .ide-button { margin-top: 4px; }
.ide-codemirror-wrap {
  flex: 1 1 auto; min-height: 0; display: flex; position: relative;
  overflow: hidden; background: var(--ide-bg);
}
.ide-codemirror-wrap > .ide-editor-state {
  position: absolute; inset: 0; z-index: 2; background: var(--ide-bg);
}
.ide-codemirror { flex: 1 1 auto; min-width: 0; height: 100%; }
.ide-codemirror .cm-editor { height: 100%; }
.ide-codemirror .cm-editor.cm-focused { outline: none; }
.ide-codemirror .cm-scroller { overflow: auto; }
.ide-codemirror .cm-gutterElement { padding: 0 8px 0 12px; }

.tok-kw { color: var(--ide-syn-keyword); }
.tok-str { color: var(--ide-syn-string); }
.tok-num { color: var(--ide-syn-number); }
.tok-com { color: var(--ide-syn-comment); }
.tok-fn { color: var(--ide-syn-function); }
.tok-type { color: var(--ide-syn-type); }
.tok-punct { color: var(--ide-syn-punct); }
.tok-key { color: var(--ide-syn-key); }
.tok-tag { color: var(--ide-syn-tag); }
.tok-attr { color: var(--ide-syn-attr); }
.tok-head { color: var(--ide-syn-head); }
.tok-link { color: var(--ide-syn-link); text-decoration: underline; text-underline-offset: 2px; }
.tok-lit { color: var(--ide-syn-number); }

.ide-empty-editor {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 7px; padding: 40px; color: var(--ide-muted);
}
.ide-empty-logo {
  width: 64px; height: 64px; border-radius: 18px; margin-bottom: 8px;
  display: flex; align-items: center; justify-content: center;
  color: var(--ide-accent);
  background: radial-gradient(circle at 30% 20%, var(--ide-accent-soft), transparent 70%);
  border: 1px solid var(--ide-border);
  box-shadow: 0 12px 30px color-mix(in srgb, var(--ide-accent) 10%, transparent);
}
.ide-empty-title { font-size: 15px; font-weight: 620; color: var(--ide-text); }
.ide-empty-sub { font-size: 12px; }
.ide-empty-actions { display: flex; gap: 8px; margin-top: 10px; }

/* Outline */
.ide-outline-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-outline-file {
  max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ide-muted); font-size: 9.5px; letter-spacing: 0; text-transform: none;
}
.ide-outline-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 4px 12px; }
.ide-outline-row {
  width: 100%; height: 25px; display: flex; align-items: center; gap: 6px;
  padding-right: 7px; border-radius: 4px; text-align: left; color: var(--ide-text);
}
.ide-outline-row:hover { background: var(--ide-hover); }
.ide-outline-kind {
  flex: 0 0 14px; width: 14px; text-align: center;
  font-family: var(--ide-mono); font-size: 9.5px; color: var(--ide-accent);
}
.ide-outline-kind.is-class { color: var(--ide-warn); }
.ide-outline-kind.is-variable { color: var(--ide-success); }
.ide-outline-kind.is-heading { color: color-mix(in oklab, var(--ide-accent) 60%, var(--ide-warn)); }
.ide-outline-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ide-outline-line { flex: 0 0 auto; color: var(--ide-muted); font-family: var(--ide-mono); font-size: 9.5px; }
.ide-outline-empty {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 9px; padding: 24px 16px; color: var(--ide-muted); font-size: 11.5px; text-align: center;
}

/* Problems */
.ide-problems-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-problems-counts { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; font-family: var(--ide-mono); font-size: 9.5px; }
.ide-problems-counts .is-error { color: var(--ide-error); }
.ide-problems-counts .is-warn { color: var(--ide-warn); }
.ide-problems-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 5px 12px; }
.ide-problem-row {
  width: 100%; display: flex; align-items: flex-start; gap: 7px;
  padding: 6px 7px; border-radius: 5px; text-align: left; color: var(--ide-text);
}
.ide-problem-row:hover { background: var(--ide-hover); }
.ide-problem-dot { flex: 0 0 6px; width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: var(--ide-muted); }
.ide-problem-row.severity-1 .ide-problem-dot { background: var(--ide-error); }
.ide-problem-row.severity-2 .ide-problem-dot { background: var(--ide-warn); }
.ide-problem-row.severity-3 .ide-problem-dot, .ide-problem-row.severity-4 .ide-problem-dot { background: var(--ide-accent); }
.ide-problem-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ide-problem-message { font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
.ide-problem-meta {
  color: var(--ide-muted); font-family: var(--ide-mono); font-size: 9px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Checkpoints */
.ide-history-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-history-clear {
  flex: 0 0 auto; height: 20px; padding: 0 6px; border-radius: 4px;
  color: var(--ide-muted); font-size: 9.5px;
}
.ide-history-clear:hover { color: var(--ide-error); background: var(--ide-hover); }
.ide-history-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 5px 12px; }
.ide-history-row {
  width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px;
  padding: 6px 7px; border-radius: 5px; text-align: left; color: var(--ide-text);
}
.ide-history-row:hover { background: var(--ide-hover); }
.ide-history-label { font-size: 11px; }
.ide-history-name {
  grid-row: 1 / span 2; grid-column: 2; align-self: center;
  max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ide-muted); font-family: var(--ide-mono); font-size: 9.5px;
}
.ide-history-time { color: var(--ide-muted); font-family: var(--ide-mono); font-size: 9px; }

/* Source control */
.ide-git-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.ide-git-branch {
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 1px 6px; border-radius: 8px; background: var(--ide-hover);
  color: var(--ide-muted); font-size: 9.5px; letter-spacing: 0; text-transform: none;
}
.ide-git-commit { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; padding: 2px 8px 8px; }
.ide-git-commit input {
  flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 8px;
  border: 1px solid var(--ide-border); border-radius: 6px; outline: 0;
  background: var(--ide-bg); color: var(--ide-text); font-size: 11.5px;
}
.ide-git-commit input:focus { border-color: var(--ide-accent); box-shadow: 0 0 0 2px var(--ide-accent-soft); }
.ide-git-commit-btn {
  flex: 0 0 28px; width: 28px; height: 28px; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ide-accent); color: #fff;
}
.ide-git-commit-btn:disabled { opacity: .35; cursor: default; }
.ide-git-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 4px 12px; }
.ide-git-section { margin-bottom: 4px; }
.ide-git-section-head {
  width: 100%; height: 25px; display: flex; align-items: center; gap: 5px;
  padding: 0 6px; border-radius: 4px; color: var(--ide-muted);
  font-size: 10.5px; font-weight: 600; text-align: left;
}
.ide-git-section-head:hover { background: var(--ide-hover); }
.ide-git-count {
  min-width: 16px; height: 15px; padding: 0 5px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ide-hover-strong); font-size: 9px; font-weight: 400;
}
.ide-git-section-action {
  margin-left: auto; width: 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--ide-muted);
}
.ide-git-section-action:hover { background: var(--ide-hover-strong); color: var(--ide-text); }
.ide-git-file {
  height: 27px; display: flex; align-items: center; gap: 5px;
  padding: 0 5px 0 9px; border-radius: 4px; cursor: pointer;
}
.ide-git-file:hover { background: var(--ide-hover); }
.ide-git-badge {
  flex: 0 0 14px; width: 14px; text-align: center;
  font-family: var(--ide-mono); font-size: 10px; font-weight: 600;
}
.ide-git-badge.status-m { color: var(--ide-warn); }
.ide-git-badge.status-a, .ide-git-badge.status-u { color: var(--ide-success); }
.ide-git-badge.status-d { color: var(--ide-error); }
.ide-git-badge.status-r, .ide-git-badge.status-c { color: var(--ide-accent); }
.ide-git-file-text { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; gap: 5px; }
.ide-git-file-name { flex: 0 0 auto; max-width: 68%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ide-git-file-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ide-muted); font-size: 9.5px; }
.ide-git-row-action {
  flex: 0 0 19px; width: 19px; height: 19px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ide-muted); font-size: 13px; opacity: 0;
}
.ide-git-file:hover .ide-git-row-action { opacity: 1; }
.ide-git-row-action:hover { background: var(--ide-hover-strong); color: var(--ide-text); }
.ide-git-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 32px 18px; text-align: center; color: var(--ide-muted); }
.ide-git-empty > svg { color: var(--ide-muted); opacity: .8; }
.ide-git-empty-title { color: var(--ide-text); font-size: 12.5px; font-weight: 600; }
.ide-git-empty-sub { font-size: 11px; line-height: 1.55; max-width: 220px; }
.ide-git-empty-small { padding: 8px 18px; color: var(--ide-muted); font-size: 10.5px; }
.ide-git-error {
  flex: 0 0 auto; display: flex; align-items: flex-start; gap: 5px;
  padding: 6px 10px; color: var(--ide-error); font-size: 10.5px;
  border-top: 1px solid color-mix(in srgb, var(--ide-error) 22%, transparent);
}
.ide-dialog.is-wide { width: min(980px, 94%); }
.ide-diff {
  margin: 0; padding: 0; max-height: 62vh; overflow: auto;
  background: var(--ide-bg); border: 1px solid var(--ide-border); border-radius: 6px;
  font-family: var(--ide-mono); font-size: 11.5px; line-height: 1.55;
  color: var(--ide-text);
}
.ide-diff-line { display: block; min-height: 18px; padding: 0 9px; white-space: pre; }
.ide-diff-line.is-add { background: color-mix(in srgb, var(--ide-success) 12%, transparent); color: color-mix(in oklab, var(--ide-success) 75%, var(--ide-text)); }
.ide-diff-line.is-del { background: color-mix(in srgb, var(--ide-error) 11%, transparent); color: color-mix(in oklab, var(--ide-error) 72%, var(--ide-text)); }
.ide-diff-line.is-hunk { color: var(--ide-accent); background: var(--ide-accent-soft); }
.ide-diff-line.is-meta { color: var(--ide-muted); }
.ide-diff-loading, .ide-diff-error, .ide-diff-empty {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 34px 20px; color: var(--ide-muted); font-size: 12px;
}
.ide-diff-error { color: var(--ide-error); }

/* Terminal */
.ide-hsplitter {
  flex: 0 0 5px; height: 5px; position: relative; z-index: 6;
  cursor: row-resize; background: transparent;
}
.ide-hsplitter::after {
  content: ""; position: absolute; left: 0; right: 0; top: 2px; height: 1px;
  background: var(--ide-border); transition: background .12s ease;
}
.ide-hsplitter:hover::after { background: var(--ide-accent); height: 2px; top: 1.5px; }
.ide-terminal {
  flex: 0 0 auto; min-height: 0; flex-direction: column;
  background: var(--ide-panel); border-top: 1px solid var(--ide-border);
}
.ide-terminal-head {
  flex: 0 0 32px; height: 32px; display: flex; align-items: center; gap: 8px;
  padding: 0 6px 0 10px; border-bottom: 1px solid var(--ide-border);
}
.ide-terminal-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--ide-text); font-size: 11.5px; font-weight: 600; }
.ide-terminal-title > svg { color: var(--ide-accent); flex: 0 0 auto; }
.ide-terminal-cwd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ide-muted); font-size: 10.5px; font-weight: 400; }
.ide-terminal-status { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; color: var(--ide-muted); font-size: 9.5px; }
.ide-terminal-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ide-idle); }
.ide-terminal-status.is-running { color: var(--ide-success); }
.ide-terminal-status.is-running .ide-terminal-status-dot { background: var(--ide-success); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ide-success) 16%, transparent); }
.ide-terminal-status.is-exited { color: var(--ide-warn); }
.ide-terminal-status.is-exited .ide-terminal-status-dot { background: var(--ide-warn); }
.ide-terminal-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 0; }
.ide-terminal-actions .ide-iconbtn { width: 24px; height: 24px; border-radius: 5px; }
.ide-terminal-tabs {
  flex: 0 0 28px; height: 28px; display: flex; align-items: center; gap: 2px;
  padding: 0 7px; overflow-x: auto; overflow-y: hidden;
  border-bottom: 1px solid var(--ide-border);
  background: color-mix(in srgb, var(--ide-panel) 90%, var(--ide-bg));
}
.ide-terminal-tab {
  flex: 0 0 auto; height: 21px; display: flex; align-items: center;
  border-radius: 5px; color: var(--ide-muted); border: 1px solid transparent;
}
.ide-terminal-tab.is-active { color: var(--ide-text); background: var(--ide-hover); border-color: var(--ide-border); }
.ide-terminal-tab-label {
  height: 100%; padding: 0 4px 0 7px; color: inherit;
  font-size: 10.5px; white-space: nowrap;
}
.ide-terminal-tab-close {
  width: 17px; height: 17px; margin-right: 2px; border-radius: 4px;
  color: var(--ide-muted); font-size: 13px; line-height: 1;
}
.ide-terminal-tab-close:hover { color: var(--ide-error); background: var(--ide-hover); }
.ide-terminal-tab-new {
  flex: 0 0 20px; width: 20px; height: 20px; margin-left: 3px; border-radius: 4px;
  color: var(--ide-muted); font-size: 15px; line-height: 1;
}
.ide-terminal-tab-new:hover:not(:disabled) { color: var(--ide-text); background: var(--ide-hover); }
.ide-terminal-tab-new:disabled { opacity: .4; }
.ide-terminal-output {
  flex: 1 1 auto; min-height: 0; margin: 0; padding: 8px 12px 10px;
  overflow: auto; color: var(--ide-text);
  font-family: var(--ide-mono); font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, var(--ide-bg) 58%, var(--ide-panel));
}
.ide-terminal-output.is-empty { color: var(--ide-muted); }
.ide-terminal-ansi-line { min-height: 1.55em; white-space: pre-wrap; word-break: break-word; }
.ide-terminal-error {
  flex: 0 0 auto; display: flex; align-items: center; gap: 5px;
  padding: 5px 12px; color: var(--ide-error); font-size: 10.5px;
  border-top: 1px solid color-mix(in srgb, var(--ide-error) 22%, transparent);
  background: color-mix(in srgb, var(--ide-error) 8%, transparent);
}
.ide-terminal-input-row {
  flex: 0 0 36px; height: 36px; display: flex; align-items: center; gap: 6px;
  padding: 0 8px 0 12px; border-top: 1px solid var(--ide-border);
}
.ide-terminal-prompt { color: var(--ide-accent); font-family: var(--ide-mono); font-size: 13px; }
.ide-terminal-input {
  flex: 1 1 auto; min-width: 0; height: 26px; border: 0; outline: 0;
  background: transparent; color: var(--ide-text);
  font-family: var(--ide-mono); font-size: 12px;
}
.ide-terminal-input::placeholder { color: var(--ide-muted); opacity: .85; }
.ide-terminal-key {
  flex: 0 0 auto; height: 22px; padding: 0 6px; border-radius: 4px;
  border: 1px solid var(--ide-border); color: var(--ide-muted);
  font-family: var(--ide-mono); font-size: 9.5px;
}
.ide-terminal-key:hover:not(:disabled) { background: var(--ide-hover); color: var(--ide-text); }
.ide-terminal-key:disabled { opacity: .35; cursor: default; }

/* Status bar */
.ide-statusbar {
  flex: 0 0 24px; height: 24px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 10px; gap: 12px;
  background: color-mix(in srgb, var(--ide-accent) 8%, var(--ide-panel));
  border-top: 1px solid var(--ide-border);
  color: var(--ide-muted); font-size: 10.5px;
  white-space: nowrap; overflow: hidden;
}
.ide-status-left, .ide-status-right { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ide-status-item { display: inline-flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; }
.ide-status-item.is-action {
  height: 18px; padding: 0 5px; border-radius: 3px;
  color: inherit; font: inherit; white-space: nowrap;
}
.ide-status-item.is-action:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-status-item.is-warn { color: var(--ide-warn); }
.ide-status-item.is-accent { color: var(--ide-accent); }
.ide-status-item.is-ai { color: var(--ide-accent); }
.ide-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ide-success); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ide-success) 18%, transparent); }

/* AI chat */
.ide-chat {
  flex: 0 0 auto; min-width: 0; height: 100%;
  flex-direction: column;
  background: var(--ide-panel);
  border-left: 1px solid var(--ide-border);
}
.ide-chat.is-crashed {
  align-items: center; justify-content: center; gap: 10px;
  padding: 24px 18px; color: var(--ide-muted); text-align: center;
}
.ide-chat.is-crashed > svg { color: var(--ide-error); }
.ide-chat-crash-title { color: var(--ide-text); font-size: 12px; font-weight: 600; }
.ide-chat-crash-message {
  max-width: 100%; max-height: 40vh; overflow: auto; margin: 0;
  color: var(--ide-error); font-family: var(--ide-mono); font-size: 9.5px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.ide-chat-head {
  flex: 0 0 48px; height: 48px; display: flex; align-items: center; gap: 8px;
  padding: 0 8px 0 12px; border-bottom: 1px solid var(--ide-border);
}
.ide-chat-brand { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
.ide-chat-logo {
  flex: 0 0 26px; width: 26px; height: 26px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, var(--ide-accent), color-mix(in oklab, var(--ide-accent) 52%, var(--dsw-alias-state-error-primary)));
}
.ide-chat-brand-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ide-chat-brand-text > span:first-child { font-size: 12.5px; font-weight: 650; }
.ide-chat-model { font-size: 10px; color: var(--ide-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px; }
.ide-chat-model-row { display: flex; align-items: center; gap: 5px; min-width: 0; max-width: 230px; }
.ide-chat-model-select {
  min-width: 0; max-width: 175px; height: 20px; padding: 0 3px;
  border: 1px solid var(--ide-border); border-radius: 4px;
  background: var(--ide-panel); color: var(--ide-muted); font-size: 9.5px;
}
.ide-chat-api {
  flex: 0 0 auto; height: 18px; padding: 0 5px; border-radius: 4px;
  border: 1px solid var(--ide-border); color: var(--ide-muted); font-size: 8.5px;
}
.ide-chat-api:hover { color: var(--ide-text); background: var(--ide-hover); }
.ide-config-form { display: flex; flex-direction: column; gap: 12px; }
.ide-config-form label { display: flex; flex-direction: column; gap: 5px; color: var(--ide-muted); font-size: 10.5px; }
.ide-config-form input, .ide-config-form select {
  height: 30px; padding: 0 8px; border-radius: 5px;
  border: 1px solid var(--ide-border); background: var(--ide-bg);
  color: var(--ide-text); font-size: 11.5px;
}
.ide-config-form input:focus, .ide-config-form select:focus { outline: none; border-color: var(--ide-accent); }
.ide-config-hint { color: var(--ide-muted); font-size: 10px; line-height: 1.5; }

.ide-chat-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 0; }
.ide-chat-context {
  flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  padding: 7px 10px; border-bottom: 1px solid var(--ide-border);
  background: color-mix(in srgb, var(--ide-bg) 30%, transparent);
}
.ide-context-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 175px;
  height: 22px; padding: 0 7px; border-radius: 6px;
  border: 1px solid var(--ide-border); background: var(--ide-bg);
  color: var(--ide-text); font-size: 10.5px;
}
.ide-context-chip.is-empty { color: var(--ide-muted); }
.ide-context-chip.is-selection { color: var(--ide-accent); border-color: var(--ide-accent-soft); background: var(--ide-accent-soft); }
.ide-context-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ide-context-toggle {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px;
  border-radius: 6px; color: var(--ide-muted); font-size: 10.5px;
}
.ide-context-toggle:hover { background: var(--ide-hover); }
.ide-context-toggle.is-on { color: var(--ide-accent); }
.ide-chat-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 18px; }
.ide-chat-empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 26px 8px 12px; gap: 7px; }
.ide-chat-empty-icon {
  width: 46px; height: 46px; border-radius: 14px; margin-bottom: 4px;
  display: flex; align-items: center; justify-content: center;
  color: var(--ide-accent); background: var(--ide-accent-soft);
}
.ide-chat-empty-title { font-size: 14px; font-weight: 640; color: var(--ide-text); }
.ide-chat-empty-sub { font-size: 11.5px; color: var(--ide-muted); line-height: 1.6; max-width: 270px; }
.ide-chat-starters { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-top: 12px; }
.ide-starter {
  width: 100%; display: flex; align-items: center; gap: 7px; text-align: left;
  padding: 8px 10px; border: 1px solid var(--ide-border); border-radius: 8px;
  background: var(--ide-bg); color: var(--ide-text); font-size: 11.5px;
  transition: border-color .12s ease, background .12s ease;
}
.ide-starter:hover { border-color: var(--ide-accent); background: var(--ide-hover); }
.ide-starter svg { color: var(--ide-accent); flex: 0 0 auto; }
.ide-chat-error {
  display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ide-error) 35%, transparent);
  border-radius: 8px; background: color-mix(in srgb, var(--ide-error) 9%, transparent);
  color: var(--ide-error); font-size: 11.5px; line-height: 1.5;
}
.ide-chat-composer { flex: 0 0 auto; padding: 8px 10px 10px; border-top: 1px solid var(--ide-border); }
.ide-chat-input-wrap {
  display: flex; align-items: flex-end; gap: 6px; padding: 7px 7px 7px 10px;
  border: 1px solid var(--ide-border-strong); border-radius: 11px;
  background: var(--ide-bg);
  transition: border-color .12s ease, box-shadow .12s ease;
}
.ide-chat-input-wrap:focus-within { border-color: var(--ide-accent); box-shadow: 0 0 0 2px var(--ide-accent-soft); }
.ide-chat-input-wrap textarea {
  flex: 1 1 auto; min-width: 0; max-height: 148px; resize: none;
  border: 0; outline: 0; background: transparent; color: var(--ide-text);
  font-size: 12.5px; line-height: 1.55; padding: 3px 0;
}
.ide-chat-input-wrap textarea::placeholder { color: var(--ide-muted); opacity: .85; }
.ide-send {
  flex: 0 0 28px; width: 28px; height: 28px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: var(--ide-accent);
  transition: opacity .12s ease, transform .12s ease;
}
.ide-send:hover:not(:disabled) { transform: translateY(-1px); }
.ide-send:disabled { opacity: .35; cursor: default; }
.ide-send.is-stop { background: color-mix(in oklab, var(--ide-error) 80%, var(--ide-bg)); }
.ide-chat-hint {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 6px; padding: 0 2px; color: var(--ide-muted); font-size: 9.5px;
  white-space: nowrap; overflow: hidden;
}
.ide-chat-hint span { overflow: hidden; text-overflow: ellipsis; }
.ide-chat-hint .is-warn { color: var(--ide-warn); }

/* Messages */
.ide-msg { display: flex; margin: 10px 0; }
.ide-msg.is-user { justify-content: flex-end; }
.ide-msg-bubble {
  max-width: 88%; padding: 8px 11px; border-radius: 12px 12px 4px 12px;
  background: var(--ide-active); border: 1px solid color-mix(in srgb, var(--ide-accent) 16%, transparent);
  color: var(--ide-text); font-size: 12.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.ide-msg.is-assistant { align-items: flex-start; gap: 8px; }
.ide-msg-avatar {
  flex: 0 0 22px; width: 22px; height: 22px; border-radius: 7px; margin-top: 2px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, var(--ide-accent), color-mix(in oklab, var(--ide-accent) 45%, var(--dsw-alias-state-error-primary)));
}
.ide-msg-main { flex: 1 1 auto; min-width: 0; }
.ide-msg-role { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-size: 10.5px; color: var(--ide-muted); font-weight: 600; }
.ide-msg-live { display: inline-flex; align-items: center; gap: 4px; color: var(--ide-accent); font-weight: 500; }
.ide-msg-live::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--ide-accent);
  animation: ide-pulse 1.2s ease-in-out infinite;
}
.ide-msg-error {
  display: flex; align-items: flex-start; gap: 5px; margin-top: 7px; padding: 6px 8px;
  border-radius: 6px; background: color-mix(in srgb, var(--ide-error) 10%, transparent);
  color: var(--ide-error); font-size: 11px; line-height: 1.5;
}
.ide-msg-usage { margin-top: 6px; color: var(--ide-muted); font-size: 9.5px; font-family: var(--ide-mono); }
.ide-typing { display: flex; gap: 4px; padding: 4px 0; }
.ide-typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--ide-muted); animation: ide-typing 1.1s ease-in-out infinite; }
.ide-typing span:nth-child(2) { animation-delay: .15s; }
.ide-typing span:nth-child(3) { animation-delay: .3s; }
.ide-reasoning { margin: 2px 0 7px; }
.ide-reasoning summary {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  color: var(--ide-muted); font-size: 10.5px; user-select: none;
}
.ide-reasoning pre {
  margin: 5px 0 0; padding: 7px 9px; border-left: 2px solid var(--ide-border-strong);
  color: var(--ide-muted); font-family: var(--ide-mono); font-size: 10.5px; line-height: 1.55;
  white-space: pre-wrap; max-height: 180px; overflow: auto;
}
.ide-markdown { font-size: 12.5px; line-height: 1.65; color: var(--ide-text); overflow-wrap: anywhere; }
.ide-md-p { margin: 0 0 8px; white-space: pre-wrap; }
.ide-md-heading { margin: 12px 0 6px; font-weight: 650; line-height: 1.35; }
.ide-md-heading:first-child { margin-top: 0; }
h3.ide-md-heading { font-size: 14px; }
h4.ide-md-heading { font-size: 13px; }
h5.ide-md-heading, h6.ide-md-heading { font-size: 12.5px; }
.ide-md-list { margin: 0 0 8px; padding-left: 19px; }
.ide-md-list li { margin: 2px 0; }
.ide-md-quote { margin: 0 0 8px; padding: 4px 10px; border-left: 2px solid var(--ide-accent); color: var(--ide-muted); }
.ide-inline-code {
  padding: 1px 4px; border-radius: 4px; background: var(--ide-hover-strong);
  font-family: var(--ide-mono); font-size: .92em; color: var(--ide-text);
}
.ide-md-link { color: var(--ide-accent); text-decoration: underline; text-underline-offset: 2px; }
.ide-codeblock {
  margin: 8px 0 10px; border: 1px solid var(--ide-border); border-radius: 8px;
  overflow: hidden; background: var(--ide-bg);
}
.ide-codeblock-head {
  height: 27px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 6px 0 10px; border-bottom: 1px solid var(--ide-border);
  background: color-mix(in srgb, var(--ide-panel) 75%, var(--ide-bg));
}
.ide-codeblock-lang { font-family: var(--ide-mono); font-size: 9.5px; color: var(--ide-muted); text-transform: lowercase; }
.ide-codeblock-actions { display: flex; align-items: center; gap: 2px; }
.ide-codeblock-actions button {
  height: 21px; display: inline-flex; align-items: center; gap: 4px;
  padding: 0 6px; border-radius: 4px; color: var(--ide-muted); font-size: 10px;
}
.ide-codeblock-actions button:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-codeblock-actions button.is-primary { color: var(--ide-accent); }
.ide-codeblock-actions button.is-primary:hover { background: var(--ide-accent-soft); }
.ide-codeblock-body {
  margin: 0; padding: 9px 10px; max-height: 390px; overflow: auto;
  font-family: var(--ide-mono); font-size: 11.5px; line-height: 1.6;
  white-space: pre; color: var(--ide-text);
}
.ide-muted { color: var(--ide-muted); }

/* Buttons and fields */
.ide-button {
  height: 29px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 0 11px; border: 1px solid var(--ide-border); border-radius: 6px;
  background: var(--ide-bg); color: var(--ide-text); font-size: 12px;
  transition: background .12s ease, border-color .12s ease;
}
.ide-button:hover:not(:disabled) { background: var(--ide-hover); border-color: var(--ide-border-strong); }
.ide-button.is-primary { background: var(--ide-accent); border-color: var(--ide-accent); color: #fff; }
.ide-button.is-primary:hover:not(:disabled) { background: color-mix(in oklab, var(--ide-accent) 84%, #000); }
.ide-button.is-danger { background: var(--ide-error); border-color: var(--ide-error); color: #fff; }
.ide-button.is-danger:hover:not(:disabled) { background: color-mix(in oklab, var(--ide-error) 84%, #000); }
.ide-button:disabled { opacity: .5; cursor: default; }
.ide-field { display: flex; flex-direction: column; gap: 5px; }
.ide-field label { font-size: 11px; color: var(--ide-muted); }
.ide-field input {
  height: 32px; padding: 0 9px; border: 1px solid var(--ide-border-strong); border-radius: 6px;
  outline: 0; background: var(--ide-bg); font-size: 12.5px;
}
.ide-field input:focus { border-color: var(--ide-accent); box-shadow: 0 0 0 2px var(--ide-accent-soft); }
.ide-form-error { margin-top: 9px; color: var(--ide-error); font-size: 11.5px; }

/* Overlay, palette, dialog, menu */
.ide-overlay {
  position: absolute; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--ide-bg) 48%, transparent);
  backdrop-filter: blur(2.5px);
  animation: ide-fade .12s ease-out;
}
.ide-overlay-top { align-items: flex-start; padding-top: 9vh; }
.ide-palette {
  width: 620px; max-width: 92%; max-height: 66%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--ide-elevated); border: 1px solid var(--ide-border-strong);
  border-radius: 11px; box-shadow: 0 20px 55px rgba(0, 0, 0, .28);
}
.ide-palette-head { flex: 0 0 44px; height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 13px; border-bottom: 1px solid var(--ide-border); color: var(--ide-muted); }
.ide-palette-head input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ide-text); font-size: 13.5px; }
.ide-palette-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 5px; }
.ide-palette-row {
  width: 100%; height: 30px; display: flex; align-items: center; gap: 7px;
  padding: 0 8px; border-radius: 5px; text-align: left; color: var(--ide-text);
}
.ide-palette-row:hover, .ide-palette-row.is-selected { background: var(--ide-active); }
.ide-palette-name { flex: 0 0 auto; max-width: 52%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.ide-palette-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ide-muted); font-size: 10.5px; }
.ide-palette-foot { flex: 0 0 25px; height: 25px; display: flex; align-items: center; padding: 0 11px; border-top: 1px solid var(--ide-border); color: var(--ide-muted); font-size: 9.5px; }
.ide-dialog {
  width: 430px; max-width: 92%; max-height: 84%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--ide-elevated); border: 1px solid var(--ide-border-strong);
  border-radius: 11px; box-shadow: 0 22px 60px rgba(0, 0, 0, .3);
  animation: ide-pop .14s ease-out;
}
.ide-dialog-head { flex: 0 0 42px; height: 42px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 14px; border-bottom: 1px solid var(--ide-border); font-size: 13px; font-weight: 620; }
.ide-dialog-close { width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--ide-muted); }
.ide-dialog-close:hover { background: var(--ide-hover); color: var(--ide-text); }
.ide-dialog-body { padding: 14px; overflow: auto; }
.ide-dialog-message { color: var(--ide-muted); font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; }
.ide-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 7px; padding: 10px 14px; border-top: 1px solid var(--ide-border); }

.ide-menu {
  position: absolute; z-index: 90; min-width: 196px; padding: 5px;
  background: var(--ide-elevated); border: 1px solid var(--ide-border-strong);
  border-radius: 9px; box-shadow: 0 16px 40px rgba(0, 0, 0, .28);
  animation: ide-pop .1s ease-out;
}
.ide-menu-title { padding: 4px 8px 6px; color: var(--ide-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ide-menu-item { width: 100%; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border-radius: 5px; text-align: left; font-size: 12px; color: var(--ide-text); }
.ide-menu-item:hover { background: var(--ide-hover); }
.ide-menu-item.is-danger { color: var(--ide-error); }
.ide-menu-item.is-danger:hover { background: color-mix(in srgb, var(--ide-error) 10%, transparent); }
.ide-menu-sep { height: 1px; margin: 4px 6px; background: var(--ide-border); }

.ide-toast {
  position: absolute; right: 16px; bottom: 34px; z-index: 100;
  display: flex; align-items: center; gap: 7px; max-width: 380px;
  padding: 8px 11px; border-radius: 8px;
  background: var(--ide-elevated); border: 1px solid var(--ide-border-strong);
  color: var(--ide-text); font-size: 11.5px; box-shadow: 0 10px 30px rgba(0, 0, 0, .22);
  animation: ide-toast-in .18s ease-out;
}
.ide-toast.tone-success svg { color: var(--ide-success); }
.ide-toast.tone-error svg { color: var(--ide-error); }
.ide-toast.tone-warn svg { color: var(--ide-warn); }
.ide-toast.tone-info svg { color: var(--ide-accent); }

.ide-fatal {
  flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 40px; text-align: center; color: var(--ide-muted);
}
.ide-fatal-icon { width: 54px; height: 54px; border-radius: 16px; display: flex; align-items: center; justify-content: center; color: var(--ide-error); background: color-mix(in srgb, var(--ide-error) 10%, transparent); }
.ide-fatal-title { font-size: 15px; font-weight: 650; color: var(--ide-text); }
.ide-fatal-message { font-size: 12.5px; line-height: 1.6; max-width: 520px; }

.ide-spinner {
  display: inline-block; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--ide-muted) 28%, transparent);
  border-top-color: var(--ide-accent);
  animation: ide-spin .7s linear infinite;
}

@keyframes ide-spin { to { transform: rotate(360deg); } }
@keyframes ide-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes ide-typing { 0%, 100% { transform: translateY(0); opacity: .45; } 50% { transform: translateY(-3px); opacity: 1; } }
@keyframes ide-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ide-pop { from { opacity: 0; transform: translateY(4px) scale(.99); } to { opacity: 1; transform: none; } }
@keyframes ide-toast-in { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@keyframes ide-skeleton { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

@media (max-width: 1100px) {
  .ide-brand-name { display: none; }
  .ide-chat-model { max-width: 140px; }
  .ide-statusbar { gap: 6px; }
  .ide-status-left, .ide-status-right { gap: 8px; }
}
@media (max-width: 860px) {
  .ide-workspace { max-width: 210px; }
  .ide-status-right .ide-status-item:nth-child(3),
  .ide-status-right .ide-status-item:nth-child(4) { display: none; }
}
`
    function SidebarIcon(props) {
      const size = props.size || 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: props.active ? 1 : 0.86 },
        'aria-hidden': true,
      },
      h('path', { d: 'm8 7-4 5 4 5' }),
      h('path', { d: 'm16 7 4 5-4 5' }),
      h('path', { d: 'm13 4-2 16' }),
      h('path', { d: 'm18.4 3 .6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z', fill: 'currentColor', stroke: 'none' }),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------

    function apply(ctx) {
      const localeDisposers = []
      try { localeDisposers.push(ctx.locale.register('dsh-ide', 'en', EN)) } catch { /* already registered */ }
      try { localeDisposers.push(ctx.locale.register('dsh-ide', 'zh', ZH)) } catch { /* already registered */ }
      try { localeDisposers.push(ctx.locale.register('dsh-ide', 'zh-CN', ZH)) } catch { /* already registered */ }

      const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'dsh-ide',
        order: 6,
        label: () => {
          try {
            return ctx.locale.bind('dsh-ide')('IDE')
          } catch {
            return 'IDE'
          }
        },
      }, SidebarIcon))

      const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'dsh-ide',
      }, (props) => h(IdeApp, { ...props, ctx })))

      ctx.effect(() => () => {
        disposeSidebar()
        disposeMain()
        for (const dispose of localeDisposers) {
          try { dispose() } catch { /* already disposed */ }
        }
      }, 'dsh-ide: locale and slots')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})


