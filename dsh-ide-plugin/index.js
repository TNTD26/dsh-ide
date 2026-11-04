import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promises as nodeFs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** Host half of the DSH IDE: workspace files, search/replace and a streaming AI assistant. */
export const inject = ['webServer', 'fs', 'workingDirectory']

const API_PREFIX = '/dsh-ide/api'
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 600 * 1024
const MAX_SEARCH_RESULTS = 400
const MAX_SEARCH_FILES = 5000
const MAX_QUICK_FILES = 8000

/** Folders explicitly opened from the IDE, in addition to the DSH workspace registry. */
const extraRoots = new Map()

/** Live IDE shell terminals, keyed by the identity returned to the browser. */
const terminalSessions = new Map()
let terminalSequence = 0
const MAX_TERMINAL_BUFFER = 400000
const execFileAsync = promisify(execFile)

/**
 * The DSH LSP seam exposes navigation only. The IDE also needs completion and
 * diagnostics, so it runs the same language-server binaries over a small,
 * purpose-built JSON-RPC bridge. This stays inside the token-guarded IDE API.
 */
const HOST_PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LSP_MODULE_CANDIDATES = [
  process.env.DSH_IDE_LSP_MODULES || '',
  path.resolve(HOST_PLUGIN_DIR, '..', 'dsh-ide-lsp', 'node_modules'),
  path.resolve(process.cwd(), 'dsh-ide-lsp', 'node_modules'),
].filter(Boolean)
const IDE_LSP_CLIENTS = new Map()

function findLspModule(relativePath) {
  for (const root of LSP_MODULE_CANDIDATES) {
    const candidate = path.join(root, relativePath)
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function lspServerFor(language) {
  if (language === 'python') {
    const script = findLspModule(path.join('pyright', 'langserver.index.js'))
    return script ? { script, languageId: 'python' } : null
  }
  if (language === 'typescript' || language === 'javascript') {
    const script = findLspModule(path.join('typescript-language-server', 'lib', 'cli.mjs'))
    return script ? { script, languageId: language } : null
  }
  return null
}

class IdeLspBridge {
  constructor(root, server) {
    this.root = root
    this.server = server
    this.nextId = 1
    this.pending = new Map()
    this.waiters = new Set()
    this.diagnostics = new Map()
    this.opened = new Map()
    this.buffer = Buffer.alloc(0)
    this.stderr = ''
    this.exited = false
    this.proc = spawn('node', [server.script, '--stdio'], {
      cwd: root.path,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout.on('data', (chunk) => this.consume(chunk))
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-6000)
    })
    this.proc.on('error', (error) => this.fail(error))
    this.proc.on('exit', () => {
      this.exited = true
      this.fail(new Error(`language server exited${this.stderr ? `: ${this.stderr}` : ''}`))
    })
    this.ready = this.initialize()
  }

  send(message) {
    if (this.exited || !this.proc.stdin.writable) return
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.proc.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]))
  }

  request(method, params, timeout = 15000) {
    if (this.exited) return Promise.reject(new Error(this.stderr || 'language server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`language server timed out on ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.slice(0, headerEnd).toString('ascii')
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.slice(bodyStart + length)
      try {
        this.handle(JSON.parse(body))
      } catch {
        /* malformed server frame: keep the bridge alive */
      }
    }
  }

  handle(message) {
    if (message.id !== undefined && message.method) {
      let result = null
      if (message.method === 'workspace/configuration') result = []
      else if (message.method === 'workspace/workspaceFolders') {
        result = [{ uri: pathToFileURL(this.root.path).toString(), name: path.basename(this.root.path) }]
      } else if (message.method === 'workspace/applyEdit') result = { applied: false }
      this.send({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'language server error'))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const uri = message.params?.uri
      if (!uri) return
      this.diagnostics.set(uri, message.params.diagnostics || [])
      for (const waiter of [...this.waiters]) {
        if (waiter.uri === uri) waiter.done(message.params.diagnostics || [])
      }
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(this.diagnostics.get(waiter.uri) || [])
    }
  }

  async initialize() {
    const rootUri = pathToFileURL(this.root.path).toString()
    await this.request('initialize', {
      processId: null,
      rootUri,
      rootPath: this.root.path,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root.path) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
          completion: {
            dynamicRegistration: false,
            completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: { relatedInformation: true },
        },
      },
    })
    this.notify('initialized', {})
  }

  async ensureDocument(abs, text) {
    await this.ready
    const uri = pathToFileURL(abs).toString()
    const previous = this.opened.get(uri)
    if (previous) {
      const version = previous + 1
      this.opened.set(uri, version)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
    } else {
      this.opened.set(uri, 1)
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.server.languageId,
          version: 1,
          text,
        },
      })
    }
    return uri
  }

  async completion(abs, text, line, character) {
    const uri = await this.ensureDocument(abs, text)
    const result = await this.request('textDocument/completion', {
      textDocument: { uri },
      position: { line, character },
    })
    const items = Array.isArray(result) ? result : (result?.items || [])
    return items.slice(0, 60).map((item) => ({
      label: String(item.label || '').slice(0, 160),
      insertText: String(item.textEdit?.newText || item.insertText || item.label || '').slice(0, 2000),
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 300) : '',
      kind: Number(item.kind) || 0,
    })).filter((item) => item.label)
  }

  waitForDiagnostics(uri) {
    return new Promise((resolve) => {
      const waiter = { uri, resolve: null, timer: null, done: null }
      const finish = (value) => {
        clearTimeout(waiter.timer)
        this.waiters.delete(waiter)
        resolve(value)
      }
      waiter.done = finish
      waiter.timer = setTimeout(() => finish(this.diagnostics.get(uri) || []), 3500)
      this.waiters.add(waiter)
    })
  }

  async diagnosticsFor(abs, text) {
    const uri = pathToFileURL(abs).toString()
    const waiting = this.waitForDiagnostics(uri)
    await this.ensureDocument(abs, text)
    const diagnostics = await waiting
    return (diagnostics || []).slice(0, 100).map((item) => ({
      severity: Number(item.severity) || 1,
      message: String(item.message || '').slice(0, 2000),
      line: (item.range?.start?.line || 0) + 1,
      character: (item.range?.start?.character || 0) + 1,
      endLine: (item.range?.end?.line || 0) + 1,
      endCharacter: (item.range?.end?.character || 0) + 1,
      source: typeof item.source === 'string' ? item.source : '',
      code: typeof item.code === 'string' ? item.code : '',
    }))
  }

  dispose() {
    this.exited = true
    this.fail(new Error('language server disposed'))
    try {
      this.notify('shutdown')
      this.proc.stdin.end()
    } catch {
      /* already gone */
    }
    try { this.proc.kill() } catch { /* already gone */ }
  }
}

function bridgeClientFor(root, language) {
  const server = lspServerFor(language)
  if (!server) throw new Error(`没有为 ${language} 配置语言服务`)
  const key = `${root.path}|${language}`
  const existing = IDE_LSP_CLIENTS.get(key)
  if (existing && !existing.exited) return existing
  if (existing) existing.dispose()
  const client = new IdeLspBridge(root, server)
  IDE_LSP_CLIENTS.set(key, client)
  return client
}

async function pythonDiagnostics(root, abs) {
  const script = findLspModule(path.join('pyright', 'index.js'))
  if (!script) return []
  let output = ''
  try {
    const result = await execFileAsync('node', [script, '--outputjson', '--level', 'warning', abs], {
      cwd: root.abs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    output = result.stdout || ''
  } catch (error) {
    output = error?.stdout || ''
  }
  if (!output.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const target = path.resolve(abs).toLowerCase()
  const severityOf = (value) => (value === 'error' ? 1 : value === 'warning' ? 2 : value === 'information' ? 3 : value === 'hint' ? 4 : 1)
  return (parsed.generalDiagnostics || [])
    .filter((item) => path.resolve(String(item.file || '')).toLowerCase() === target)
    .slice(0, 100)
    .map((item) => ({
      severity: severityOf(item.severity),
      message: String(item.message || '').slice(0, 2000),
      line: (item.range?.start?.line || 0) + 1,
      character: (item.range?.start?.character || 0) + 1,
      endLine: (item.range?.end?.line || 0) + 1,
      endCharacter: (item.range?.end?.character || 0) + 1,
      source: 'pyright',
      code: typeof item.rule === 'string' ? item.rule : '',
    }))
}

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components',
  'dist', 'build', 'out', '.next', '.nuxt', '.output', '.cache',
  'coverage', '.turbo', '.parcel-cache', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
])

const LANGUAGE_BY_EXT = {
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
  txt: 'plaintext', log: 'plaintext', env: 'ini',
}

const SEARCHABLE_EXT = new Set([
  ...Object.keys(LANGUAGE_BY_EXT),
  'lock', 'gitignore', 'dockerignore', 'editorconfig', 'npmrc', 'nvmrc',
  'properties', 'gradle', 'make', 'mk', 'cmake', 'tex', 'rst', 'csv', 'tsv',
])

const SPECIAL_TEXT_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile',
  '.gitignore', '.dockerignore', '.editorconfig', '.npmrc', '.nvmrc', '.env',
])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Register the IDE host route and the per-boot page token the browser module reads.
 * @param ctx - Host context carrying webServer, fs, llm and the default model.
 */
export function apply(ctx) {
  const token = randomBytes(24).toString('hex')
  const quickCache = new Map()

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => handleRequest(ctx, token, quickCache, req, res),
  })

  const disposeTap = ctx.webServer.tapIndex((html) => {
    const script = `<script>window.__DSH_IDE_TOKEN__=${JSON.stringify(token)};</script>`
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${script}`)
    if (html.includes('</head>')) return html.replace('</head>', `${script}</head>`)
    return `${script}${html}`
  })

  ctx.effect(() => () => {
    disposeRoute()
    disposeTap()
    quickCache.clear()
    for (const session of [...terminalSessions.values()]) {
      session.closed = true
      clearTimeout(session.reapTimer)
      try {
        const closing = session.handle.terminate()
        if (closing && typeof closing.catch === 'function') closing.catch(() => {})
      } catch {
        /* already gone */
      }
    }
    terminalSessions.clear()
    for (const client of [...IDE_LSP_CLIENTS.values()]) client.dispose()
    IDE_LSP_CLIENTS.clear()
  }, 'dsh-ide: web routes')
}

async function handleRequest(ctx, token, quickCache, req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('allow', 'GET,POST,OPTIONS')
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method || 'GET'

    // A same-origin browser session may mint the per-boot token even when the
    // page was cached before the index tap was installed. Cross-site pages get
    // no CORS headers, so they cannot read this response.
    if (method === 'GET' && route === '/session') {
      const origin = ctx.webServer.getOrigin()
      const requestHost = String(req.headers.host || '')
      const source = req.headers.origin || req.headers.referer
      const site = req.headers['sec-fetch-site']
      let sameOrigin = true
      if (source) {
        try {
          sameOrigin = new URL(source).host === requestHost
        } catch {
          sameOrigin = false
        }
      }
      const localHost = requestHost === new URL(origin).host
        || /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(requestHost)
      const allowedSite = !site || site === 'same-origin' || site === 'same-site' || site === 'none'
      if (!sameOrigin || !localHost || !allowedSite) throw new HttpError(403, '请求来源不受信任')
      return sendJson(res, 200, { token })
    }

    // Static editor engine bundle. It contains no workspace data, so it can be
    // loaded by a plain <script> tag before the token-authenticated calls.
    if (method === 'GET' && route === '/assets/codemirror.js') {
      const asset = path.join(HOST_PLUGIN_DIR, 'assets', 'codemirror.js')
      const body = await nodeFs.readFile(asset)
      res.statusCode = 200
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'public, max-age=86400')
      res.end(body)
      return
    }

    if (req.headers['x-dsh-ide-token'] !== token) {
      throw new HttpError(403, 'IDE 会话令牌无效，请刷新页面后重试')
    }

    if (method === 'GET' && route === '/models') {
      const llm = ctx.get('llm')
      if (!llm) throw new HttpError(503, '当前部署没有可用的模型服务')
      const modelService = ctx.get('agentDefaultModel')
      const current = modelService && typeof modelService.currentSelection === 'function'
        ? modelService.currentSelection()
        : null
      let providers = []
      try {
        providers = llm.listProviders()
      } catch {
        providers = []
      }
      const catalog = []
      for (const provider of providers) {
        let models = []
        try {
          models = await llm.listModels(provider.id)
        } catch {
          models = []
        }
        catalog.push({
          id: provider.id,
          name: provider.name || provider.id,
          models: (models || []).slice(0, 200).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            description: model.description || '',
          })),
        })
      }
      let configurable = []
      try {
        configurable = (llm.listConfigurableProviders?.() || []).map((entry) => ({
          provider: entry.provider,
          displayName: entry.displayName,
          settingsNs: entry.settingsNs,
          defaultBaseURL: entry.defaultBaseURL || '',
          nativeAuth: entry.nativeAuth || null,
          baseURLEnv: entry.baseURLEnv || [],
          error: entry.error || '',
        }))
      } catch {
        configurable = []
      }
      return sendJson(res, 200, { current, providers: catalog, configurable })
    }

    if (method === 'POST' && route === '/model-config/provider') {
      const body = await readJsonBody(req)
      const provider = String(body.provider || '').slice(0, 120)
      const apiKey = String(body.apiKey || '').trim()
      const baseURL = String(body.baseURL || '').trim()
      if (!provider || !apiKey) throw new HttpError(400, '请填写 Provider 和 API Key')
      const llm = ctx.get('llm')
      const entry = (llm?.listConfigurableProviders?.() || []).find((item) => item.provider === provider)
      if (!entry) throw new HttpError(400, '未知的模型 Provider')
      if (entry.settingsNs === 'llm-deepseek-account') {
        throw new HttpError(400, 'DeepSeek Account 使用登录授权，不需要 API Key')
      }
      const env = entry.nativeAuth?.env?.[0]
      if (!env) throw new HttpError(400, '该 Provider 没有可用的 API Key 环境变量')
      const credentials = ctx.get('credentials')
      if (!credentials) throw new HttpError(503, '当前部署没有可用的凭证服务')
      const settings = ctx.get('settings')
      if (!settings) throw new HttpError(503, '当前部署没有可用的设置服务')
      const descriptor = settings.describe({ redactSecrets: true }).find((item) => item.ns === entry.settingsNs)
      if (!descriptor) throw new HttpError(400, '找不到该 Provider 的设置项')
      await credentials.set(env, apiKey)
      const patch = {}
      if (entry.settingsNs === 'llm-pi-ai') {
        const current = descriptor.value && typeof descriptor.value === 'object'
          && descriptor.value.providers && typeof descriptor.value.providers === 'object'
          ? descriptor.value.providers
          : {}
        const profile = current[provider] && typeof current[provider] === 'object' ? current[provider] : {}
        patch.providers = {
          ...current,
          [provider]: {
            ...profile,
            apiKeyEnv: env,
            ...(baseURL ? { baseURL } : {}),
          },
        }
      } else if (entry.settingsNs === 'llm-deepseek') {
        patch.apiKeyEnv = env
      } else {
        throw new HttpError(400, `暂不支持配置 ${entry.settingsNs} 的 API Key`)
      }
      try {
        await settings.update(entry.settingsNs, patch, descriptor.revision)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      return sendJson(res, 200, { ok: true, provider, env })
    }

    if (method === 'GET' && route === '/model-config') {
      const settings = ctx.get('settings')
      if (!settings) throw new HttpError(503, '当前部署没有可用的设置服务')
      const llm = ctx.get('llm')
      const configurable = llm?.listConfigurableProviders?.() || []
      const namespaces = new Set(configurable.map((entry) => entry.settingsNs))
      const descriptors = settings.describe({ redactSecrets: true })
        .filter((descriptor) => namespaces.has(descriptor.ns))
        .map((descriptor) => ({
          ns: descriptor.ns,
          revision: descriptor.revision,
          value: descriptor.value,
          secrets: descriptor.secrets || [],
        }))
      return sendJson(res, 200, { descriptors })
    }

    if (method === 'POST' && route === '/model-config') {
      const settings = ctx.get('settings')
      if (!settings) throw new HttpError(503, '当前部署没有可用的设置服务')
      const llm = ctx.get('llm')
      const configurable = llm?.listConfigurableProviders?.() || []
      const allowed = new Set(configurable.map((entry) => entry.settingsNs))
      const body = await readJsonBody(req)
      const ns = String(body.ns || '')
      if (!allowed.has(ns)) throw new HttpError(403, '不允许修改该设置')
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
        throw new HttpError(400, '设置内容无效')
      }
      try {
        await settings.update(ns, body.patch, Number.isFinite(body.revision) ? body.revision : undefined)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'GET' && route === '/bootstrap') {
      const roots = await listRoots(ctx)
      const modelService = ctx.get('agentDefaultModel')
      const selection = modelService && typeof modelService.currentSelection === 'function'
        ? modelService.currentSelection()
        : undefined
      return sendJson(res, 200, {
        roots,
        root: roots[0]?.path || null,
        model: selection
          ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ?? null }
          : null,
      })
    }

    if (method === 'POST' && route === '/roots') {
      const body = await readJsonBody(req)
      const requested = String(body.path ?? '').trim()
      if (!requested) throw new HttpError(400, '缺少文件夹路径')
      let target
      let info
      try {
        target = await ctx.fs.resolve(requested, { cwd: ctx.workingDirectory.defaultDirectory })
        info = await ctx.fs.stat(target)
      } catch {
        throw new HttpError(400, '无法访问该文件夹')
      }
      if (!info || info.type !== 'directory') throw new HttpError(400, '该路径不是文件夹')
      const abs = ctx.fs.processPath(target)
      const title = path.basename(abs) || abs
      const entry = { path: abs, title }
      extraRoots.set(rootKey(abs), entry)
      return sendJson(res, 200, { root: entry, roots: await listRoots(ctx) })
    }

    if (method === 'POST' && route === '/roots/remove') {
      const body = await readJsonBody(req)
      const requested = String(body.path ?? '').trim()
      if (!requested) throw new HttpError(400, '缺少文件夹路径')
      extraRoots.delete(rootKey(requested))
      return sendJson(res, 200, { roots: await listRoots(ctx) })
    }

    if (method === 'GET' && route === '/tree') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      const rel = normalizeRel(url.searchParams.get('path'))
      const listing = await listDirectory(ctx, root, rel)
      return sendJson(res, 200, listing)
    }

    if (method === 'GET' && route === '/file/stat') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      const rel = normalizeRel(url.searchParams.get('path'))
      if (!rel) throw new HttpError(400, '缺少文件路径')
      const entry = await resolveWithin(ctx, root, rel)
      const info = await ctx.fs.stat(entry.target)
      if (!info) return sendJson(res, 200, { path: rel, exists: false })
      return sendJson(res, 200, {
        path: rel,
        exists: true,
        type: info.type,
        version: info.version,
        size: typeof info.size === 'number' ? info.size : null,
      })
    }

    if (method === 'GET' && route === '/file') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      const rel = normalizeRel(url.searchParams.get('path'))
      const file = await readWorkspaceFile(ctx, root, rel)
      return sendJson(res, 200, file)
    }

    if (method === 'GET' && route === '/files') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      const query = (url.searchParams.get('q') || '').slice(0, 200)
      const files = await quickFiles(ctx, root, quickCache, query)
      return sendJson(res, 200, { files })
    }

    if (method === 'POST' && route === '/file') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const rel = normalizeRel(body.path)
      const saved = await saveWorkspaceFile(ctx, root, rel, body)
      return sendJson(res, 200, saved)
    }

    if (method === 'POST' && route === '/create') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const created = await createEntry(ctx, root, body)
      return sendJson(res, 200, created)
    }

    if (method === 'POST' && route === '/rename') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const renamed = await renameEntry(ctx, root, body)
      return sendJson(res, 200, renamed)
    }

    if (method === 'POST' && route === '/delete') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const deleted = await deleteEntry(ctx, root, body)
      return sendJson(res, 200, deleted)
    }

    if (method === 'POST' && route === '/search') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const result = await searchWorkspace(ctx, root, body)
      return sendJson(res, 200, result)
    }

    if (method === 'POST' && route === '/replace') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const result = await replaceInWorkspace(ctx, root, body)
      return sendJson(res, 200, result)
    }

    if (method === 'GET' && route === '/git/status') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      return sendJson(res, 200, await gitStatus(root))
    }

    if (method === 'GET' && route === '/git/diff') {
      const root = await resolveRoot(ctx, url.searchParams.get('root'))
      const rel = normalizeRel(url.searchParams.get('path'))
      const staged = url.searchParams.get('staged') === '1'
      return sendJson(res, 200, await gitDiff(ctx, root, rel, staged))
    }

    if (method === 'POST' && route === '/git/stage') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      return sendJson(res, 200, await gitStage(root, body, true))
    }

    if (method === 'POST' && route === '/git/unstage') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      return sendJson(res, 200, await gitStage(root, body, false))
    }

    if (method === 'POST' && route === '/git/commit') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      return sendJson(res, 200, await gitCommit(root, body))
    }

    if (method === 'POST' && route === '/git/init') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      return sendJson(res, 200, await gitInit(root))
    }

    if (method === 'POST' && route === '/lsp/query') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const rel = normalizeRel(body.path)
      if (!rel) throw new HttpError(400, '缺少文件路径')
      const lsp = ctx.get('lsp')
      if (!lsp) throw new HttpError(503, '当前环境没有可用的语言服务')
      const operation = String(body.operation || '')
      if (!['goToDefinition', 'findReferences', 'goToImplementation', 'hover'].includes(operation)) {
        throw new HttpError(400, '不支持的语言服务操作')
      }
      const entry = await resolveWithin(ctx, root, rel)
      let result
      try {
        result = await lsp.query({
          operation,
          filePath: entry.abs,
          workspaceRoot: root.abs,
          position: {
            line: Math.max(0, Number(body.line) || 0),
            character: Math.max(0, Number(body.character) || 0),
          },
        })
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : String(error))
      }
      if (result.kind === 'hover') {
        return sendJson(res, 200, { kind: 'hover', hover: result.hover })
      }
      const locations = (result.locations || []).map((location) => {
        let absolute = ''
        try {
          let pathname = decodeURIComponent(new URL(location.uri).pathname)
          if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
          absolute = pathname
        } catch {
          absolute = ''
        }
        let relPath = ''
        if (absolute) {
          const relative = path.relative(root.abs, absolute)
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) relPath = relative.split(path.sep).join('/')
        }
        return {
          path: relPath,
          absolutePath: absolute,
          line: (location.range?.start?.line ?? 0) + 1,
          character: (location.range?.start?.character ?? 0) + 1,
        }
      })
      return sendJson(res, 200, { kind: 'locations', locations })
    }

    if (method === 'POST' && (route === '/lsp/completion' || route === '/lsp/diagnostics')) {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const rel = normalizeRel(body.path)
      if (!rel) throw new HttpError(400, '缺少文件路径')
      const language = languageOf(rel)
      if (!['python', 'typescript', 'javascript'].includes(language)) {
        return sendJson(res, 200, route === '/lsp/completion' ? { items: [] } : { diagnostics: [] })
      }
      const entry = await resolveWithin(ctx, root, rel)
      const text = String(body.text ?? '').slice(0, 4 * 1024 * 1024)
      try {
        if (route === '/lsp/completion') {
          const client = bridgeClientFor(root, language)
          const items = await client.completion(
            entry.abs,
            text,
            Math.max(0, Number(body.line) || 0),
            Math.max(0, Number(body.character) || 0),
          )
          return sendJson(res, 200, { items })
        }
        if (language === 'python') {
          const diagnostics = await pythonDiagnostics(root, entry.abs)
          return sendJson(res, 200, { diagnostics })
        }
        const client = bridgeClientFor(root, language)
        const diagnostics = await client.diagnosticsFor(entry.abs, text)
        return sendJson(res, 200, { diagnostics })
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : String(error))
      }
    }

    if (method === 'POST' && route === '/terminal/create') {
      const body = await readJsonBody(req)
      const root = await resolveRoot(ctx, body.root)
      const terminal = await createIdeTerminal(ctx, root, body)
      return sendJson(res, 200, terminal)
    }

    if (method === 'GET' && route === '/terminal/stream') {
      const terminal = terminalSessions.get(String(url.searchParams.get('id') || ''))
      if (!terminal) throw new HttpError(404, '终端会话不存在或已结束')
      await streamIdeTerminal(req, res, terminal)
      return
    }

    if (method === 'POST' && route === '/terminal/input') {
      const body = await readJsonBody(req, 64 * 1024)
      const terminal = terminalSessions.get(String(body.id || ''))
      if (!terminal) throw new HttpError(404, '终端会话不存在或已结束')
      if (terminal.exited) throw new HttpError(409, '终端进程已退出')
      const data = String(body.data ?? '')
      if (data.length > 16384) throw new HttpError(413, '输入内容过长')
      await terminal.handle.write(data)
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'POST' && route === '/terminal/resize') {
      const body = await readJsonBody(req)
      const terminal = terminalSessions.get(String(body.id || ''))
      if (!terminal) throw new HttpError(404, '终端会话不存在或已结束')
      const cols = clamp(Number(body.cols) || 100, 20, 240)
      const rows = clamp(Number(body.rows) || 24, 5, 80)
      await terminal.handle.resize(cols, rows)
      terminal.cols = cols
      terminal.rows = rows
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'POST' && route === '/terminal/close') {
      const body = await readJsonBody(req)
      const terminal = terminalSessions.get(String(body.id || ''))
      if (terminal) await closeIdeTerminal(terminal)
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'POST' && route === '/chat') {
      const body = await readJsonBody(req, 2 * 1024 * 1024)
      const root = await resolveRoot(ctx, body.root)
      await streamChat(ctx, root, body, req, res)
      return
    }

    throw new HttpError(404, `未知的 IDE 接口：${route}`)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    if (res.headersSent) {
      try {
        if (!res.writableEnded) {
          res.write(`${JSON.stringify({ type: 'error', message })}\n`)
          res.end()
        }
      } catch {
        /* the peer already closed */
      }
      return
    }
    sendJson(res, status, { error: message })
  }
}

// ---------------------------------------------------------------------------
// Workspace roots and paths
// ---------------------------------------------------------------------------

async function listRoots(ctx) {
  const seen = new Map()
  const add = (value, title) => {
    if (!value || typeof value !== 'string') return
    const abs = path.resolve(value)
    const key = rootKey(abs)
    if (seen.has(key)) return
    seen.set(key, {
      path: abs,
      title: title && title.trim() ? title.trim() : path.basename(abs) || abs,
    })
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry) {
    try {
      for (const workspace of registry.list()) add(workspace.path, workspace.title)
    } catch {
      /* a registry that is still starting must not break the IDE */
    }
  }

  for (const extra of extraRoots.values()) add(extra.path, extra.title)

  if (seen.size === 0) add(ctx.workingDirectory.defaultDirectory)

  return [...seen.values()]
}

function rootKey(value) {
  const abs = path.resolve(value)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

async function resolveRoot(ctx, value) {
  if (!value || typeof value !== 'string') throw new HttpError(400, '缺少工作区路径')
  const target = await ctx.fs.resolve(value)
  const abs = ctx.fs.processPath(target)
  for (const candidate of await listRoots(ctx)) {
    try {
      const candidateTarget = await ctx.fs.resolve(candidate.path)
      if (candidateTarget.targetKey === target.targetKey) {
        return { ...candidate, abs, target }
      }
    } catch {
      /* an unavailable workspace is simply not selectable */
    }
  }
  throw new HttpError(403, '该目录不在当前工作区列表中')
}

function normalizeRel(value) {
  let rel = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === '.' || rel === './') rel = ''
  if (rel.includes('\0')) throw new HttpError(400, '路径包含非法字符')
  if (rel.split('/').some((part) => part === '..')) throw new HttpError(403, '路径不能离开工作区')
  return rel.replace(/\/+/g, '/').replace(/\/$/, '')
}

async function resolveWithin(ctx, root, rel, signal) {
  const clean = normalizeRel(rel)
  const target = await ctx.fs.resolve(clean || '.', { cwd: root.path, signal })
  if (!ctx.fs.contains(root.target, target)) throw new HttpError(403, '路径不能离开工作区')
  const abs = ctx.fs.processPath(target)
  assertInside(root.abs, abs)
  return { rel: clean, target, abs }
}

function assertInside(rootAbs, abs) {
  const rel = path.relative(rootAbs, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    if (rel === '') return
    throw new HttpError(403, '路径不能离开工作区')
  }
}

function joinRel(parent, name) {
  return parent ? `${parent}/${name}` : name
}

function writePolicy(root) {
  return { mode: 'workspace-write', workspaceRoot: root.path }
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

async function listDirectory(ctx, root, rel, signal) {
  const entry = await resolveWithin(ctx, root, rel, signal)
  const info = await ctx.fs.stat(entry.target, signal)
  if (!info) throw new HttpError(404, '目录不存在')
  if (info.type !== 'directory') throw new HttpError(400, '目标不是目录')

  const children = await ctx.fs.listDir(entry.target, signal)
  const entries = children
    .filter((child) => child.name !== '.git')
    .map((child) => ({
      name: child.name,
      type: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
      size: typeof child.size === 'number' ? child.size : null,
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  return {
    path: rel,
    absolutePath: entry.abs,
    entries: entries.slice(0, 2000),
    truncated: entries.length > 2000,
  }
}

async function readWorkspaceFile(ctx, root, rel, signal) {
  if (!rel) throw new HttpError(400, '请选择一个文件')
  const entry = await resolveWithin(ctx, root, rel, signal)
  const info = await ctx.fs.stat(entry.target, signal)
  if (!info) throw new HttpError(404, '文件不存在')
  if (info.type !== 'file') throw new HttpError(400, '目标不是文件')
  if (typeof info.size === 'number' && info.size > MAX_TEXT_BYTES) {
    throw new HttpError(413, '文件超过 4 MiB，IDE 暂不打开')
  }

  let text
  try {
    text = await ctx.fs.readText(entry.target, signal)
  } catch (error) {
    if (isErrorCode(error, 'FS_NOT_TEXT')) throw new HttpError(415, '这是一个二进制文件，IDE 只编辑文本')
    throw error
  }
  if (text.includes('\0')) throw new HttpError(415, '这是一个二进制文件，IDE 只编辑文本')

  return {
    path: rel,
    absolutePath: entry.abs,
    text,
    version: info.version,
    size: typeof info.size === 'number' ? info.size : null,
    language: languageOf(rel),
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function saveWorkspaceFile(ctx, root, rel, body, signal) {
  if (!rel) throw new HttpError(400, '请选择一个文件')
  if (typeof body.text !== 'string') throw new HttpError(400, '文件内容无效')
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) throw new HttpError(413, '文件超过 4 MiB')

  const entry = await resolveWithin(ctx, root, rel, signal)
  const info = await ctx.fs.stat(entry.target, signal)
  let expected
  if (info) {
    if (info.type !== 'file') throw new HttpError(400, '目标不是文件')
    if (body.version && body.version !== info.version) {
      throw new HttpError(409, '文件已在磁盘上发生变化，请重新加载后再保存')
    }
    expected = { kind: 'replaceIfVersion', version: info.version }
  } else {
    expected = { kind: 'createIfAbsent' }
  }

  try {
    const outcome = await ctx.fs.writeText(entry.target, body.text, expected, signal, writePolicy(root))
    return {
      path: rel,
      absolutePath: entry.abs,
      version: outcome.version,
      operation: outcome.operation,
      size: Buffer.byteLength(body.text, 'utf8'),
    }
  } catch (error) {
    if (isErrorCode(error, 'FS_STALE_VERSION')) {
      throw new HttpError(409, '文件已在磁盘上发生变化，请重新加载后再保存')
    }
    if (isErrorCode(error, 'FS_TOO_LARGE')) throw new HttpError(413, '文件超过大小限制')
    throw error
  }
}

async function createEntry(ctx, root, body) {
  const rel = normalizeRel(body.path)
  if (!rel) throw new HttpError(400, '请输入名称')
  const parts = rel.split('/')
  const name = parts.pop()
  if (!name || name === '.' || name === '..') throw new HttpError(400, '名称无效')
  const parentRel = parts.join('/')
  const parent = await resolveWithin(ctx, root, parentRel)
  const parentInfo = await ctx.fs.stat(parent.target)
  if (!parentInfo || parentInfo.type !== 'directory') throw new HttpError(400, '父目录不存在')

  const abs = path.join(parent.abs, name)
  assertInside(root.abs, abs)

  if (body.type === 'directory') {
    try {
      await nodeFs.mkdir(abs)
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) throw new HttpError(409, '同名文件或目录已存在')
      throw error
    }
    return { path: rel, type: 'directory' }
  }

  const entry = await resolveWithin(ctx, root, rel)
  const info = await ctx.fs.stat(entry.target)
  if (info) throw new HttpError(409, '同名文件或目录已存在')
  try {
    const outcome = await ctx.fs.writeText(entry.target, '', { kind: 'createIfAbsent' }, undefined, writePolicy(root))
    return { path: rel, type: 'file', version: outcome.version }
  } catch (error) {
    if (isErrorCode(error, 'FS_EXISTS') || isErrorCode(error, 'EEXIST')) throw new HttpError(409, '同名文件或目录已存在')
    throw error
  }
}

async function renameEntry(ctx, root, body) {
  const fromRel = normalizeRel(body.path)
  const toRel = normalizeRel(body.newPath)
  if (!fromRel || !toRel) throw new HttpError(400, '源路径和目标路径都需要填写')
  if (fromRel === toRel) return { path: fromRel }

  const from = await resolveWithin(ctx, root, fromRel)
  const to = await resolveWithin(ctx, root, toRel)
  const fromInfo = await ctx.fs.stat(from.target)
  if (!fromInfo) throw new HttpError(404, '源文件或目录不存在')
  if (await ctx.fs.stat(to.target)) throw new HttpError(409, '目标路径已存在')

  const parentAbs = path.dirname(to.abs)
  const parentInfo = await nodeFs.stat(parentAbs).catch(() => undefined)
  if (!parentInfo || !parentInfo.isDirectory()) throw new HttpError(400, '目标父目录不存在')

  try {
    await nodeFs.rename(from.abs, to.abs)
  } catch (error) {
    if (isErrorCode(error, 'EEXIST') || isErrorCode(error, 'EPERM')) throw new HttpError(409, '目标路径已存在或不可写')
    throw error
  }
  return { path: toRel, from: fromRel }
}

async function deleteEntry(ctx, root, body) {
  const rel = normalizeRel(body.path)
  if (!rel) throw new HttpError(400, '不能删除工作区根目录')
  const entry = await resolveWithin(ctx, root, rel)
  if (entry.abs === root.abs) throw new HttpError(400, '不能删除工作区根目录')
  const info = await ctx.fs.stat(entry.target)
  if (!info) throw new HttpError(404, '文件或目录不存在')
  try {
    await nodeFs.rm(entry.abs, { recursive: true, force: false })
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) throw new HttpError(404, '文件或目录不存在')
    throw error
  }
  return { path: rel }
}

// ---------------------------------------------------------------------------
// Search, replace and quick open
// ---------------------------------------------------------------------------

function buildRegex(body) {
  const query = String(body.query ?? '')
  if (!query) throw new HttpError(400, '请输入搜索内容')
  if (query.length > 500) throw new HttpError(400, '搜索内容过长')
  let source = body.regex ? query : escapeRegExp(query)
  if (body.wholeWord) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, body.caseSensitive ? 'g' : 'gi')
  } catch (error) {
    throw new HttpError(400, `正则表达式无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

function includeFilter(body) {
  const raw = String(body.include ?? '').trim()
  if (!raw) return null
  const patterns = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (patterns.length === 0) return null
  const regexes = patterns.map((pattern) => globToRegex(pattern))
  return (rel) => regexes.some((regex) => regex.test(rel) || regex.test(path.posix.basename(rel)))
}

function globToRegex(glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*'
        index += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$+.|()[]{}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  try {
    return new RegExp(`^${out}$`, 'i')
  } catch {
    return /$^/
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function searchWorkspace(ctx, root, body, signal) {
  const regex = buildRegex(body)
  const include = includeFilter(body)
  const limit = clamp(Number(body.maxResults) || MAX_SEARCH_RESULTS, 1, 1000)
  const groups = []
  let total = 0
  let scanned = 0
  let skipped = 0
  let truncated = false

  await walkFiles(ctx, root, signal, async (rel, target, info) => {
    if (include && !include(rel)) return true
    if (typeof info.size === 'number' && info.size > MAX_SEARCH_FILE_BYTES) {
      skipped += 1
      return true
    }
    if (!isLikelyText(rel)) {
      skipped += 1
      return true
    }

    let text
    try {
      text = await ctx.fs.readText(target, signal)
    } catch {
      skipped += 1
      return true
    }
    if (text.includes('\0')) {
      skipped += 1
      return true
    }

    scanned += 1
    const starts = lineStarts(text)
    const matches = []
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(text))) {
      if (match[0].length === 0) {
        regex.lastIndex += 1
        continue
      }
      const lineIndex = lineOf(starts, match.index)
      const lineStart = starts[lineIndex]
      const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1] - 1 : text.length
      matches.push({
        index: match.index,
        length: match[0].length,
        line: lineIndex + 1,
        column: match.index - lineStart + 1,
        before: clip(text.slice(Math.max(lineStart, match.index - 80), match.index)),
        match: clip(match[0]),
        after: clip(text.slice(match.index + match[0].length, Math.min(lineEnd, match.index + match[0].length + 100))),
      })
      total += 1
      if (matches.length >= limit || total >= limit) {
        truncated = true
        break
      }
    }

    if (matches.length > 0) groups.push({ path: rel, matches })
    if (total >= limit) return false
    return true
  })

  return { groups, total, scanned, skipped, truncated }
}

async function replaceInWorkspace(ctx, root, body, signal) {
  const replacement = String(body.replacement ?? '')
  if (replacement.length > 10000) throw new HttpError(400, '替换内容过长')

  if (body.path) {
    const rel = normalizeRel(body.path)
    const entry = await resolveWithin(ctx, root, rel)
    const info = await ctx.fs.stat(entry.target, signal)
    if (!info) throw new HttpError(404, '文件不存在')
    if (info.type !== 'file') throw new HttpError(400, '目标不是文件')
    const text = await ctx.fs.readText(entry.target, signal)
    const index = Number(body.index)
    const length = Number(body.length)
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0 || index + length > text.length) {
      throw new HttpError(400, '替换位置无效，请重新搜索')
    }
    if (typeof body.match === 'string' && body.match.length === length && text.slice(index, index + length) !== body.match) {
      throw new HttpError(409, '文件内容已变化，请重新搜索')
    }
    const next = text.slice(0, index) + replacement + text.slice(index + length)
    const outcome = await ctx.fs.writeText(entry.target, next, { kind: 'replaceIfVersion', version: info.version }, signal, writePolicy(root))
    return { changed: [{ path: rel, count: 1 }], count: 1, version: outcome.version }
  }

  const regex = buildRegex(body)
  const include = includeFilter(body)
  const changed = []
  const failed = []
  let count = 0

  await walkFiles(ctx, root, signal, async (rel, target, info) => {
    if (include && !include(rel)) return true
    if (typeof info.size === 'number' && info.size > MAX_SEARCH_FILE_BYTES) return true
    if (!isLikelyText(rel)) return true
    let text
    try {
      text = await ctx.fs.readText(target, signal)
    } catch {
      return true
    }
    if (text.includes('\0')) return true

    regex.lastIndex = 0
    const matches = [...text.matchAll(regex)].filter((match) => match[0].length > 0)
    if (matches.length === 0) return true
    const next = body.regex
      ? text.replace(regex, replacement)
      : text.replace(regex, () => replacement)
    if (next === text) return true

    try {
      await ctx.fs.writeText(target, next, { kind: 'replaceIfVersion', version: info.version }, signal, writePolicy(root))
      changed.push({ path: rel, count: matches.length })
      count += matches.length
    } catch (error) {
      failed.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
    }
    return changed.length < 400
  })

  return { changed, failed, count, truncated: changed.length >= 400 }
}

async function quickFiles(ctx, root, cache, query) {
  const key = process.platform === 'win32' ? root.abs.toLowerCase() : root.abs
  let record = cache.get(key)
  if (!record || Date.now() - record.time > 5000) {
    const files = []
    await walkFiles(ctx, root, undefined, async (rel) => {
      if (files.length < MAX_QUICK_FILES) files.push(rel)
      return files.length < MAX_QUICK_FILES
    }, { filesOnly: true })
    record = { time: Date.now(), files }
    cache.set(key, record)
    if (cache.size > 8) cache.delete(cache.keys().next().value)
  }

  const needle = query.trim().toLowerCase()
  let files = record.files
  if (needle) {
    const scored = []
    for (const rel of files) {
      const base = path.posix.basename(rel).toLowerCase()
      let score = 0
      if (base === needle) score = 5
      else if (base.startsWith(needle)) score = 4
      else if (base.includes(needle)) score = 3
      else if (rel.toLowerCase().includes(needle)) score = 2
      if (score > 0) scored.push([score, rel])
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
    files = scored.map((entry) => entry[1])
  }
  return files.slice(0, 80)
}

async function walkFiles(ctx, root, signal, visit, options = {}) {
  const queue = ['']
  let visited = 0
  while (queue.length > 0) {
    signal?.throwIfAborted()
    const rel = queue.shift()
    let children
    try {
      const dirTarget = await ctx.fs.resolve(rel || '.', { cwd: root.path, signal })
      if (!ctx.fs.contains(root.target, dirTarget)) continue
      children = await ctx.fs.listDir(dirTarget, signal)
    } catch {
      continue
    }
    for (const child of children) {
      if (child.type === 'directory') {
        if (!SKIP_DIRS.has(child.name)) queue.push(joinRel(rel, child.name))
        continue
      }
      if (child.type !== 'file') continue
      const childRel = joinRel(rel, child.name)
      if (options.filesOnly && !isLikelyText(childRel)) continue
      visited += 1
      if (visited > MAX_SEARCH_FILES) return
      let target
      let info
      try {
        target = await ctx.fs.resolve(childRel, { cwd: root.path, signal })
        if (!ctx.fs.contains(root.target, target)) continue
        info = await ctx.fs.stat(target, signal)
      } catch {
        continue
      }
      if (!info || info.type !== 'file') continue
      const keepGoing = await visit(childRel, target, info)
      if (keepGoing === false) return
    }
  }
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

async function runGit(root, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', root.abs, ...args], {
      cwd: root.abs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' && error.stderr.trim()
        ? error.stderr
        : (error instanceof Error ? error.message : String(error)),
      code: error?.code,
    }
  }
}

async function gitStatus(root) {
  const probe = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok || probe.stdout.trim() !== 'true') {
    return {
      repo: false,
      error: probe.stderr.trim() || '该文件夹不是 Git 仓库',
    }
  }

  const result = await runGit(root, ['status', '--porcelain=v1', '-b'])
  if (!result.ok) throw new HttpError(500, result.stderr.trim() || 'git status 失败')
  const lines = result.stdout.split(/\r?\n/).filter(Boolean)
  let branch = ''
  let ahead = 0
  let behind = 0
  const changes = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3)
      const bracket = header.match(/\[(.+)\]/)
      if (bracket) {
        const aheadMatch = bracket[1].match(/ahead (\d+)/)
        const behindMatch = bracket[1].match(/behind (\d+)/)
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0
        behind = behindMatch ? Number(behindMatch[1]) : 0
      }
      branch = header.split('...')[0].trim() || header.trim()
      continue
    }
    if (line.length < 4) continue
    const indexStatus = line[0]
    const worktreeStatus = line[1]
    let file = line.slice(3)
    if (indexStatus === 'R' || indexStatus === 'C') {
      const arrow = file.lastIndexOf(' -> ')
      if (arrow >= 0) file = file.slice(arrow + 4)
    }
    changes.push({
      path: file,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ' && worktreeStatus !== '?',
      untracked: indexStatus === '?' && worktreeStatus === '?',
    })
  }

  return {
    repo: true,
    branch,
    ahead,
    behind,
    changes,
    clean: changes.length === 0,
  }
}

async function gitDiff(ctx, root, rel, staged) {
  if (!rel) throw new HttpError(400, '请选择一个文件')
  const args = ['diff', '--no-color', '--unified=3']
  if (staged) args.push('--cached')
  args.push('--', rel)
  let result = await runGit(root, args)
  if (!result.ok) throw new HttpError(400, result.stderr.trim() || 'git diff 失败')

  if (!result.stdout.trim() && !staged) {
    const status = await runGit(root, ['status', '--porcelain=v1', '--', rel])
    if (status.ok && status.stdout.startsWith('??')) {
      try {
        const file = await readWorkspaceFile(ctx, root, rel)
        const lines = file.text.replace(/\r\n/g, '\n').split('\n')
        const body = lines.map((line) => `+${line}`).join('\n')
        result = {
          ok: true,
          stdout: [
            `diff --git a/${rel} b/${rel}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${rel}`,
            `@@ -0,0 +1,${lines.length} @@`,
            body,
          ].join('\n'),
        }
      } catch {
        /* binary or unreadable */
      }
    }
  }

  return { diff: result.stdout, path: rel, staged }
}

function gitPaths(body) {
  const values = Array.isArray(body.paths) ? body.paths : []
  return values.slice(0, 200).map((value) => normalizeRel(value)).filter(Boolean)
}

async function gitStage(root, body, stage) {
  const paths = gitPaths(body)
  const args = stage
    ? (paths.length > 0 ? ['add', '--', ...paths] : ['add', '-A'])
    : (paths.length > 0 ? ['reset', 'HEAD', '--', ...paths] : ['reset', 'HEAD'])
  const result = await runGit(root, args)
  if (!result.ok) throw new HttpError(400, result.stderr.trim() || 'Git 操作失败')
  return { ok: true, status: await gitStatus(root) }
}

async function gitCommit(root, body) {
  const message = String(body.message ?? '').trim()
  if (!message) throw new HttpError(400, '请输入提交信息')
  if (message.length > 4000) throw new HttpError(400, '提交信息过长')
  const result = await runGit(root, ['commit', '-m', message])
  if (!result.ok) throw new HttpError(400, result.stderr.trim() || '提交失败')
  return { ok: true, stdout: result.stdout, status: await gitStatus(root) }
}

async function gitInit(root) {
  const result = await runGit(root, ['init'])
  if (!result.ok) throw new HttpError(400, result.stderr.trim() || '初始化失败')
  return { ok: true, stdout: result.stdout, status: await gitStatus(root) }
}

// ---------------------------------------------------------------------------
// IDE terminal
// ---------------------------------------------------------------------------

function terminalEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

function terminalShellArgs(shellPath) {
  const base = path.basename(String(shellPath)).toLowerCase()
  if (base === 'pwsh' || base === 'pwsh.exe' || base.includes('powershell')) return ['-NoLogo']
  if (base === 'cmd' || base === 'cmd.exe') return ['/Q']
  if (base === 'bash' || base === 'zsh' || base === 'fish') return ['-i']
  return []
}

async function createIdeTerminal(ctx, root, body) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess || typeof subprocess.spawnTerminal !== 'function') {
    throw new HttpError(503, '当前部署没有可用的终端服务')
  }

  let environment
  try {
    environment = await subprocess.terminalEnvironment?.()
  } catch {
    environment = undefined
  }

  let shellPath = environment?.defaultShell
  if (!shellPath) {
    shellPath = process.platform === 'win32'
      ? (process.env.ComSpec || 'powershell.exe')
      : (process.env.SHELL || '/bin/bash')
  }
  let executable = shellPath
  try {
    executable = await subprocess.resolveExecutable(shellPath)
  } catch {
    /* let spawnTerminal report the exact failure */
  }

  const cols = clamp(Number(body.cols) || 100, 20, 240)
  const rows = clamp(Number(body.rows) || 24, 5, 80)
  let handle
  try {
    handle = await subprocess.spawnTerminal({
      argv: [executable, ...terminalShellArgs(executable)],
      cwd: root.abs,
      env: terminalEnv(),
      rows,
      cols,
      terminalType: 'xterm-256color',
      shellActivity: true,
      graceMs: 2000,
    })
  } catch (error) {
    throw new HttpError(502, `终端启动失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const id = `term-${Date.now().toString(36)}-${(terminalSequence += 1).toString(36)}`
  const session = {
    id,
    root: root.path,
    handle,
    buffer: '',
    subscribers: new Set(),
    decoder: new StringDecoder('utf8'),
    exited: false,
    exitCode: null,
    closed: false,
    cols,
    rows,
    reapTimer: undefined,
  }
  terminalSessions.set(id, session)

  const append = (text) => {
    if (!text) return
    session.buffer = `${session.buffer}${text}`.slice(-MAX_TERMINAL_BUFFER)
    writeTerminalEvent(session, { type: 'data', data: text })
  }

  handle.output.on('data', (chunk) => {
    if (session.closed) return
    try {
      append(session.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')))
    } catch (error) {
      writeTerminalEvent(session, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  handle.output.on('error', (error) => {
    if (session.closed) return
    writeTerminalEvent(session, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  })

  handle.done
    .then((outcome) => finishIdeTerminal(session, outcome?.exitCode ?? null))
    .catch((error) => finishIdeTerminal(session, null, error))

  return {
    id,
    root: root.path,
    cwd: root.abs,
    shell: path.basename(executable),
    cols,
    rows,
  }
}

function finishIdeTerminal(session, exitCode, error) {
  if (session.exited) return
  session.exited = true
  session.exitCode = exitCode
  try {
    const tail = session.decoder.end()
    if (tail) session.buffer = `${session.buffer}${tail}`.slice(-MAX_TERMINAL_BUFFER)
    if (tail) writeTerminalEvent(session, { type: 'data', data: tail })
  } catch {
    /* decoder teardown is best-effort */
  }
  if (error) {
    writeTerminalEvent(session, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  writeTerminalEvent(session, { type: 'exit', exitCode, exited: true })
  endTerminalSubscribers(session)
  scheduleTerminalReap(session)
}

function writeTerminalEvent(session, event) {
  const line = `${JSON.stringify(event)}\n`
  for (const subscriber of [...session.subscribers]) {
    if (subscriber.writableEnded || subscriber.destroyed) {
      session.subscribers.delete(subscriber)
      continue
    }
    try {
      subscriber.write(line)
    } catch {
      session.subscribers.delete(subscriber)
    }
  }
}

function endTerminalSubscribers(session) {
  for (const subscriber of [...session.subscribers]) {
    try {
      subscriber.end()
    } catch {
      /* already closed */
    }
  }
  session.subscribers.clear()
}

function scheduleTerminalReap(session) {
  if (session.closed || session.subscribers.size > 0) return
  clearTimeout(session.reapTimer)
  session.reapTimer = setTimeout(() => {
    if (!session.closed && session.subscribers.size === 0) {
      void closeIdeTerminal(session).catch(() => {})
    }
  }, session.exited ? 30000 : 120000)
}

async function closeIdeTerminal(session) {
  if (session.closed) return
  session.closed = true
  clearTimeout(session.reapTimer)
  terminalSessions.delete(session.id)
  try {
    await session.handle.terminate()
  } catch {
    /* the process may already be gone */
  }
  writeTerminalEvent(session, { type: 'exit', exitCode: null, closed: true })
  endTerminalSubscribers(session)
}

async function streamIdeTerminal(req, res, session) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()

  const send = (event) => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.write(`${JSON.stringify(event)}\n`)
    } catch {
      /* peer closed */
    }
  }

  send({
    type: 'reset',
    buffer: session.buffer,
    exited: session.exited,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
  })

  if (session.exited || session.closed) {
    send({ type: 'exit', exitCode: session.exitCode, exited: true })
    res.end()
    return
  }

  clearTimeout(session.reapTimer)
  session.subscribers.add(res)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    session.subscribers.delete(res)
    clearInterval(heartbeat)
    scheduleTerminalReap(session)
  }
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanup()
      return
    }
    try {
      res.write('{"type":"ping"}\n')
    } catch {
      cleanup()
    }
  }, 20000)
  res.on('close', cleanup)
}

// ---------------------------------------------------------------------------
// AI chat
// ---------------------------------------------------------------------------

async function streamChat(ctx, root, body, req, res) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const history = messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-14)
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? '').slice(0, 12000),
    }))
    .filter((message) => message.content.trim().length > 0)

  let totalChars = history.reduce((sum, message) => sum + message.content.length, 0)
  while (history.length > 1 && totalChars > 32000) {
    totalChars -= history.shift().content.length
  }

  if (history.length === 0) throw new HttpError(400, '请输入问题')
  const last = [...history].reverse().find((message) => message.role === 'user')
  if (!last) throw new HttpError(400, '请输入问题')

  const modelService = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  if (!llm) throw new HttpError(503, '当前部署没有可用的模型服务')
  let selection = modelService && typeof modelService.currentSelection === 'function'
    ? modelService.currentSelection()
    : undefined
  const requestedModel = body.model && typeof body.model === 'object' ? body.model : null
  if (requestedModel?.provider && requestedModel?.model) {
    selection = {
      provider: String(requestedModel.provider).slice(0, 120),
      model: String(requestedModel.model).slice(0, 200),
    }
    if (requestedModel.reasoningEffort) {
      selection.reasoningEffort = String(requestedModel.reasoningEffort).slice(0, 80)
    }
  }
  if (!selection?.provider || !selection?.model) {
    throw new HttpError(400, '尚未配置默认模型，请先在设置中选择模型')
  }

  const context = body.context && typeof body.context === 'object' ? body.context : {}
  const contextText = await buildFileContext(ctx, root, context)

  const system = [
    'You are DSH Code Assistant, the built-in AI pair programmer inside the DSH IDE.',
    'You help with code questions, refactors, reviews, debugging, tests and generation.',
    '',
    'Rules:',
    '- Answer in the same language as the user (default to Chinese when the user writes Chinese).',
    '- Be direct and technically precise. Prefer short explanations followed by concrete code.',
    '- Use Markdown. Always tag fenced code blocks with their language.',
    '- When suggesting an edit, show a complete replacement block that can be applied as-is.',
    '- For an edit spanning multiple files, emit exactly one fenced block tagged dsh-patch and use this format:',
    '  ```dsh-patch',
    '  *** Replace File: relative/path.ext',
    '  <entire replacement file content>',
    '  *** Replace File: other/relative.ext',
    '  <entire replacement file content>',
    '  *** End Patch',
    '  ```',
    '  Paths must be workspace-relative. Use complete file contents, not diff hunks.',
    '- Never claim that you changed, saved or ran anything; the user applies suggestions manually.',
    '- If the provided context is insufficient, say what file or detail you need instead of inventing APIs.',
    '',
    `Workspace root: ${root.path}`,
  ].join('\n')

  const transcript = history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')

  const prompt = [
    contextText,
    '',
    'Conversation so far:',
    transcript,
    '',
    `Now answer the final User message.`,
  ].join('\n').trim()

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  const config = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort) config.reasoningEffort = selection.reasoningEffort

  let prepared
  try {
    prepared = await llm.prepareCall(config, controller.signal)
  } catch (error) {
    throw new HttpError(502, `模型准备失败：${error instanceof Error ? error.message : String(error)}`)
  }

  res.statusCode = 200
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()

  const write = (event) => {
    if (res.writableEnded || res.destroyed) return false
    try {
      res.write(`${JSON.stringify(event)}\n`)
      return true
    } catch {
      return false
    }
  }

  write({
    type: 'start',
    model: { provider: selection.provider, model: selection.model },
  })

  try {
    const chunks = prepared.stream({
      ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      system,
      signal: controller.signal,
    })

    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') {
        if (chunk.text) write({ type: 'delta', text: chunk.text })
      } else if (chunk.type === 'reasoning-delta') {
        if (chunk.text) write({ type: 'reasoning', text: chunk.text })
      } else if (chunk.type === 'usage') {
        write({ type: 'usage', usage: chunk.usage })
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          const failure = reason.failure
          write({
            type: 'error',
            message: failure?.message || (reason.kind === 'aborted' ? '生成已中断' : '模型返回错误'),
            code: failure?.code,
          })
        } else {
          write({ type: 'done', reason: reason?.kind || 'stop' })
        }
      }
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (controller.signal.aborted) {
      write({ type: 'error', message: '生成已停止' })
    } else {
      write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    if (!res.writableEnded) res.end()
  }
}

async function buildFileContext(ctx, root, context) {
  const lines = []
  const rel = typeof context.path === 'string' ? normalizeRel(context.path) : ''

  if (rel && context.includeFile !== false) {
    try {
      const file = await readWorkspaceFile(ctx, root, rel)
      const text = file.text.length > 16000 ? `${file.text.slice(0, 16000)}\n… (truncated)` : file.text
      lines.push(`Active file: ${rel} (${file.language})`, '```' + file.language, text, '```')
    } catch {
      lines.push(`Active file: ${rel} (not readable)`)
    }
  } else if (rel) {
    lines.push(`Active file: ${rel} (content not attached)`)
  }

  if (typeof context.selection === 'string' && context.selection.trim()) {
    const selected = context.selection.slice(0, 8000)
    lines.push('Selected text:', '```', selected, '```')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function languageOf(rel) {
  const base = path.posix.basename(rel).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  if (base.startsWith('.env')) return 'ini'
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  return LANGUAGE_BY_EXT[ext] || 'plaintext'
}

function isLikelyText(rel) {
  const base = path.posix.basename(rel).toLowerCase()
  if (SPECIAL_TEXT_FILES.has(base) || base.startsWith('.env')) return true
  const dot = base.lastIndexOf('.')
  if (dot < 0) return true
  return SEARCHABLE_EXT.has(base.slice(dot + 1))
}

function lineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

function lineOf(starts, index) {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (starts[middle] <= index) low = middle + 1
    else high = middle - 1
  }
  return Math.max(0, high)
}

function clip(value) {
  const text = String(value).replace(/\r?\n/g, ' ')
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function readJsonBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
        resolve(parsed)
      } catch {
        reject(new HttpError(400, '请求体不是有效的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  if (res.headersSent) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}
