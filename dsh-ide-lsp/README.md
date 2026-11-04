# DSH IDE Language Services

This bundle mounts the DSH `ctx.lsp` seam and registers Pyright (Python) and
`typescript-language-server` (TypeScript/JavaScript).

## Path portability

The bundle patch contains **no machine-specific absolute paths**. `index.js`
resolves the language-server packages relative to itself with
`createRequire(import.meta.url)`:

```js
const require = createRequire(import.meta.url)
const pyrightDir = path.dirname(require.resolve('pyright/package.json'))
```

So moving the folder (with its `node_modules`) to another location keeps
working. Only the `dsh-ide-plugin` sibling is expected to find the same
`node_modules` for the IDE completion/diagnostics bridge; it checks these in
order:

1. `DSH_IDE_LSP_MODULES` (optional absolute path)
2. `../dsh-ide-lsp/node_modules` relative to the IDE plugin
3. `<cwd>/dsh-ide-lsp/node_modules`

## Why `node_modules` is local

`@local/dsh-ide-lsp` is installed into the profile with a `link:` dependency.
pnpm does **not** install dependencies of a linked local package into the
profile, so this folder needs its own install:

```powershell
cd dsh-ide-lsp
npm install --ignore-scripts
```

Keep the whole folder together, including `node_modules`, when moving the
workspace. If it is removed or reinstalled, run `npm install` again.

## Non-standard locations

Environment overrides are read when the host starts:

| Variable | Meaning |
| --- | --- |
| `DSH_NODE_BIN` | Node executable used to launch language servers (default `node`) |
| `DSH_PYRIGHT_DIR` | Pyright package root containing `langserver.index.js` |
| `DSH_TYPESCRIPT_LSP_DIR` | `typescript-language-server` package root containing `lib/cli.mjs` |
| `DSH_IDE_LSP_MODULES` | `node_modules` root for the IDE completion/diagnostics bridge |

Restart DSH after changing these variables.

## Distribution option

For a release that is not a local link, pack this folder and install the
tarball through the DSH plugin manager rather than linking it. That lets the
profile's package manager own the dependencies. The IDE bridge should then
point `DSH_IDE_LSP_MODULES` at the installed dependencies, or be co-located
with them.
