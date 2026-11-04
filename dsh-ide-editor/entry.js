import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, historyKeymap, indentWithTab, addCursorAbove, addCursorBelow } from '@codemirror/commands'
import { searchKeymap, selectNextOccurrence } from '@codemirror/search'
import { foldGutter, foldKeymap, indentUnit } from '@codemirror/language'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { linter, lintGutter } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'

export {
  basicSetup,
  EditorView,
  EditorState,
  EditorSelection,
  Compartment,
  keymap,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  addCursorAbove,
  addCursorBelow,
  searchKeymap,
  selectNextOccurrence,
  foldGutter,
  foldKeymap,
  indentUnit,
  autocompletion,
  completionKeymap,
  linter,
  lintGutter,
  oneDark,
  python,
  javascript,
}
