import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editorShortcut, editorShortcutLabel, isApplePlatform, type EditorKeyEvent } from '../src/client/editor-shortcuts.js'

const chord = (key: string, patch: Partial<EditorKeyEvent> = {}): EditorKeyEvent => ({
  key, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, ...patch,
})

test('editor formatting and history use the OS primary modifier rather than accepting either one', () => {
  for (const [key, action] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['f', 'find'], ['z', 'undo']] as const) {
    assert.equal(editorShortcut(chord(key), false), action)
    assert.equal(editorShortcut(chord(key), true), null)
    assert.equal(editorShortcut(chord(key, { ctrlKey: false, metaKey: true }), true), action)
    assert.equal(editorShortcut(chord(key, { ctrlKey: false, metaKey: true }), false), null)
  }
  assert.equal(editorShortcut(chord('z', { shiftKey: true }), false), 'redo')
  assert.equal(editorShortcut(chord('z', { ctrlKey: false, metaKey: true, shiftKey: true }), true), 'redo')
  assert.equal(editorShortcut(chord('y'), false), 'redo')
  assert.equal(editorShortcut(chord('y', { ctrlKey: false, metaKey: true }), true), null)
})

test('IME composition, AltGr, and browser clipboard/select-all chords are never intercepted', () => {
  assert.equal(editorShortcut(chord('b', { isComposing: true }), false), null)
  assert.equal(editorShortcut(chord('z', { keyCode: 229 }), false), null)
  assert.equal(editorShortcut(chord('i', { altKey: true }), false), null)
  assert.equal(editorShortcut(chord('u', { metaKey: true }), false), null)
  for (const key of ['c', 'x', 'v', 'a']) assert.equal(editorShortcut(chord(key), false), null)
  assert.equal(editorShortcut(chord('b', { shiftKey: true }), false), null)
})

test('visible shortcut hints follow Apple and non-Apple conventions', () => {
  assert.equal(isApplePlatform('MacIntel'), true)
  assert.equal(isApplePlatform('iPad'), true)
  assert.equal(isApplePlatform('Win32'), false)
  assert.equal(isApplePlatform('Linux x86_64'), false)
  assert.equal(editorShortcutLabel('underline', true), '⌘U')
  assert.equal(editorShortcutLabel('underline', false), 'Ctrl+U')
  assert.equal(editorShortcutLabel('redo', true), '⇧⌘Z')
})
