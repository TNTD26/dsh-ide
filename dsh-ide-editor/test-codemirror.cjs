const fs = require('node:fs')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
  runScripts: 'outside-only',
})
const context = dom.getInternalVMContext()
vm.runInContext(fs.readFileSync('../dsh-ide-plugin/assets/codemirror.js', 'utf8'), context)
const CM = dom.window.DSHCodeMirror
if (!CM) throw new Error('DSHCodeMirror was not exposed by the bundle')

const rect = { left: 0, right: 10, top: 0, bottom: 16, width: 10, height: 16 }
dom.window.Range.prototype.getClientRects = () => [rect]
dom.window.Range.prototype.getBoundingClientRect = () => rect
dom.window.HTMLElement.prototype.getClientRects = () => [rect]
global.window = dom.window
global.document = dom.window.document
global.navigator = dom.window.navigator
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
dom.window.ResizeObserver = global.ResizeObserver

let lintRuns = 0
const lint = CM.linter(async () => {
  lintRuns += 1
  return [{ from: 0, to: 3, severity: 'error', message: 'mock diagnostic' }]
}, { delay: 20 })

const view = new CM.EditorView({
  doc: 'def foo():\n  return 1\n\ndef bar():\n  return 2\n',
  extensions: [
    CM.basicSetup,
    CM.python(),
    CM.oneDark,
    CM.foldGutter(),
    CM.lintGutter(),
    lint,
    CM.autocompletion({ override: [async () => ({ from: 0, options: [{ label: 'foo' }] })] }),
    CM.keymap.of([
      ...CM.foldKeymap,
      ...CM.defaultKeymap,
      ...CM.historyKeymap,
      ...CM.searchKeymap,
      CM.indentWithTab,
      { key: 'Mod-Alt-ArrowUp', run: CM.addCursorAbove, preventDefault: true },
      { key: 'Mod-Alt-ArrowDown', run: CM.addCursorBelow, preventDefault: true },
      { key: 'Mod-d', run: CM.selectNextOccurrence, preventDefault: true },
    ]),
  ],
  parent: document.getElementById('host'),
})

const checks = []
checks.push(['editor mounted', Boolean(document.querySelector('.cm-editor'))])
checks.push(['line numbers', Boolean(document.querySelector('.cm-lineNumbers'))])
checks.push(['fold gutter', Boolean(document.querySelector('.cm-foldGutter'))])
checks.push(['lint gutter', Boolean(document.querySelector('.cm-gutter-lint'))])
checks.push(['syntax + oneDark extensions', Boolean(CM.oneDark) && Boolean(CM.python) && Boolean(CM.javascript)])
checks.push(['doc intact', view.state.doc.toString().includes('def bar')])

view.dispatch({ selection: CM.EditorSelection.create([CM.EditorSelection.cursor(0), CM.EditorSelection.cursor(4)]) })
checks.push(['multi selection', view.state.selection.ranges.length === 2])
view.dispatch(view.state.replaceSelection('X'))
checks.push(['multi edit', view.state.doc.toString().startsWith('Xdef Xfoo')])

view.dispatch({
  changes: { from: 0, to: view.state.doc.length, insert: 'foo foo foo\nbar bar\nbaz baz' },
  selection: { anchor: 0, head: 3 },
})
const selected = CM.selectNextOccurrence(view)
checks.push(['Ctrl+D select next', selected === true && view.state.selection.ranges.length >= 2])

const line2 = view.state.doc.line(2).from + 2
view.dispatch({ selection: { anchor: line2, head: line2 } })
const above = CM.addCursorAbove(view)
checks.push(['add cursor above', above === true && view.state.selection.ranges.length >= 2])

setTimeout(() => {
  checks.push(['linter ran', lintRuns > 0])
  checks.push(['lint marker painted', Boolean(document.querySelector('.cm-lint-marker'))])
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  const failed = checks.filter(([, ok]) => !ok)
  console.log(`RESULT ${checks.length - failed.length}/${checks.length}`)
  view.destroy()
  process.exit(failed.length ? 1 : 0)
}, 250)
