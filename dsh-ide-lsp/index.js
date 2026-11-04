import { createRequire } from 'node:module'
import path from 'node:path'
import {
  apply as applyStdio,
  Config as StdioConfig,
  inject as stdioInject,
  name as stdioName,
} from '@deepseek-ai/dsh-lsp-stdio'

const require = createRequire(import.meta.url)

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`))
}

/**
 * Compose the stdio provider with paths resolved relative to this package,
 * never with absolute paths baked into the bundle patch.
 */
export function apply(ctx) {
  const pyrightDir = process.env.DSH_PYRIGHT_DIR || packageDir('pyright')
  const typescriptDir = process.env.DSH_TYPESCRIPT_LSP_DIR || packageDir('typescript-language-server')
  const nodeBin = process.env.DSH_NODE_BIN || 'node'
  ctx.plugin({
    name: stdioName,
    inject: stdioInject,
    Config: StdioConfig,
    apply: applyStdio,
  }, {
    servers: {
      python: {
        command: nodeBin,
        args: [path.join(pyrightDir, 'langserver.index.js'), '--stdio'],
        extensionToLanguage: {
          '.py': 'python',
          '.pyi': 'python',
        },
      },
      typescript: {
        command: nodeBin,
        args: [path.join(typescriptDir, 'lib', 'cli.mjs'), '--stdio'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.tsx': 'typescriptreact',
          '.js': 'javascript',
          '.jsx': 'javascriptreact',
        },
      },
    },
  })
}
