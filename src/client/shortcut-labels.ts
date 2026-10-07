import { isApplePlatform } from './editor-shortcuts.js'
import { translator } from './i18n.js'
import type { JotLocale } from './types.js'

interface Chord { mod?: boolean; alt?: boolean; shift?: boolean; key: string }

/** Keys the editor and workbench actually handle; Tiptap defaults are listed so they are discoverable. */
export const SHORTCUTS = {
  bold: { mod: true, key: 'B' }, italic: { mod: true, key: 'I' }, underline: { mod: true, key: 'U' },
  undo: { mod: true, key: 'Z' }, redo: { mod: true, shift: true, key: 'Z' },
  find: { mod: true, key: 'F' }, save: { mod: true, key: 'S' },
  paragraph: { mod: true, alt: true, key: '0' },
  heading1: { mod: true, alt: true, key: '1' }, heading2: { mod: true, alt: true, key: '2' }, heading3: { mod: true, alt: true, key: '3' },
  orderedList: { mod: true, shift: true, key: '7' }, bulletList: { mod: true, shift: true, key: '8' },
  taskList: { mod: true, shift: true, key: '9' }, blockquote: { mod: true, shift: true, key: 'B' },
  codeBlock: { mod: true, alt: true, key: 'C' }, strike: { mod: true, shift: true, key: 'S' },
  code: { mod: true, key: 'E' }, highlight: { mod: true, shift: true, key: 'H' },
  toggleTask: { mod: true, key: 'Enter' }, moveUp: { alt: true, shift: true, key: '↑' }, moveDown: { alt: true, shift: true, key: '↓' },
  indent: { key: 'Tab' }, outdent: { shift: true, key: 'Tab' },
  searchLibrary: { key: '/' }, shortcutHelp: { key: '?' },
} satisfies Record<string, Chord>
export type ShortcutId = keyof typeof SHORTCUTS

const APPLE_KEYS: Record<string, string> = { Enter: '↩', Tab: '⇥' }

/** Apple order is ⌃⌥⇧⌘ with no separators; other platforms spell modifiers out with '+'. */
export function shortcutLabel(id: ShortcutId, apple = isApplePlatform()): string {
  const chord: Chord = SHORTCUTS[id]
  if (apple) return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${APPLE_KEYS[chord.key] ?? chord.key}`
  return [chord.mod && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.key].filter(Boolean).join('+')
}

const ARIA_KEYS: Record<string, string> = { '↑': 'ArrowUp', '↓': 'ArrowDown' }
/** The `aria-keyshortcuts` spelling, which assistive technology reads instead of the glyphs. */
export function ariaShortcut(id: ShortcutId, apple = isApplePlatform()): string {
  const chord: Chord = SHORTCUTS[id]
  return [chord.mod && (apple ? 'Meta' : 'Control'), chord.alt && 'Alt', chord.shift && 'Shift', ARIA_KEYS[chord.key] ?? chord.key]
    .filter(Boolean).join('+')
}

/** A tooltip such as "Bold (⌘B)"; actions without keys keep their plain label. */
export function withShortcut(label: string, id: ShortcutId | undefined, apple = isApplePlatform()): string {
  return id ? `${label} (${shortcutLabel(id, apple)})` : label
}

export interface ShortcutHelpRow { label: string; keys: string[] }
export interface ShortcutHelpSection { title: string; rows: ShortcutHelpRow[] }

/** Everything the keyboard does in Jot, grouped as the help dialog shows it. */
export function shortcutHelpSections(locale: JotLocale, apple = isApplePlatform()): ShortcutHelpSection[] {
  const t = translator(locale)
  const key = (id: ShortcutId) => shortcutLabel(id, apple)
  const row = (label: string, ...keys: string[]): ShortcutHelpRow => ({ label, keys })
  return [
    { title: t('Library'), rows: [
      row(t('Search notes'), key('searchLibrary')),
      row(t('Move through the list'), '↑', '↓'),
      row(t('Open a note'), apple ? '↩' : 'Enter'),
      row(t('Show shortcuts'), key('shortcutHelp')),
    ] },
    { title: t('Editing'), rows: [
      row(t('Bold / italic / underline'), key('bold'), key('italic'), key('underline')),
      row(t('Undo / redo'), key('undo'), key('redo'), ...apple ? [] : ['Ctrl+Y']),
      row(t('Find in this note'), key('find')),
      row(t('Save now'), key('save')),
    ] },
    { title: t('Blocks'), rows: [
      row(t('Body text'), key('paragraph')),
      row(t('Heading 1 / 2 / 3'), key('heading1'), key('heading2'), key('heading3')),
      row(t('Bullet / numbered list'), key('bulletList'), key('orderedList')),
      row(t('To-do list'), key('taskList')),
      row(t('Quote / code block'), key('blockquote'), key('codeBlock')),
    ] },
    { title: t('Inline styles'), rows: [
      row(t('Strikethrough'), key('strike')),
      row(t('Inline code'), key('code')),
      row(t('Highlight'), key('highlight')),
    ] },
    { title: t('Lists'), rows: [
      row(t('Check or uncheck this to-do'), key('toggleTask')),
      row(t('Move this item up / down'), key('moveUp'), key('moveDown')),
      row(t('Indent / outdent'), key('indent'), key('outdent')),
    ] },
    { title: t('Type to format'), rows: [
      row(t('Insert a heading, list, table… on an empty line'), '/', ...locale === 'zh' ? ['、'] : []),
      row(t('Heading'), '# '),
      row(t('List / numbered'), '- ', '1. '),
      row(t('To-do'), '[ ] '),
      row(t('Quote / divider'), '> ', '---'),
      row(t('Bold'), '**…**'),
    ] },
  ]
}
