import { isApplePlatform } from './editor-shortcuts.js'
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

/** A tooltip such as "粗体 (⌘B)"; actions without keys keep their plain label. */
export function withShortcut(label: string, id: ShortcutId | undefined, apple = isApplePlatform()): string {
  return id ? `${label} (${shortcutLabel(id, apple)})` : label
}

export interface ShortcutHelpRow { label: string; keys: string[] }
export interface ShortcutHelpSection { title: string; rows: ShortcutHelpRow[] }

/** Everything the keyboard does in Jot, grouped as the help dialog shows it. */
export function shortcutHelpSections(locale: JotLocale, apple = isApplePlatform()): ShortcutHelpSection[] {
  const en = locale === 'en'
  const copy = (zh: string, english: string) => en ? english : zh
  const key = (id: ShortcutId) => shortcutLabel(id, apple)
  const row = (label: string, ...keys: string[]): ShortcutHelpRow => ({ label, keys })
  return [
    { title: copy('笔记库', 'Library'), rows: [
      row(copy('搜索笔记', 'Search notes'), key('searchLibrary')),
      row(copy('在列表中移动', 'Move through the list'), '↑', '↓'),
      row(copy('打开笔记', 'Open a note'), apple ? '↩' : 'Enter'),
      row(copy('显示快捷键', 'Show shortcuts'), key('shortcutHelp')),
    ] },
    { title: copy('编辑', 'Editing'), rows: [
      row(copy('粗体／斜体／下划线', 'Bold / italic / underline'), key('bold'), key('italic'), key('underline')),
      row(copy('撤销／重做', 'Undo / redo'), key('undo'), key('redo'), ...apple ? [] : ['Ctrl+Y']),
      row(copy('在当前笔记中查找', 'Find in this note'), key('find')),
      row(copy('立即保存', 'Save now'), key('save')),
    ] },
    { title: copy('段落', 'Blocks'), rows: [
      row(copy('正文', 'Body text'), key('paragraph')),
      row(copy('标题 1／2／3', 'Heading 1 / 2 / 3'), key('heading1'), key('heading2'), key('heading3')),
      row(copy('无序／有序列表', 'Bullet / numbered list'), key('bulletList'), key('orderedList')),
      row(copy('待办清单', 'To-do list'), key('taskList')),
      row(copy('引用／代码块', 'Quote / code block'), key('blockquote'), key('codeBlock')),
    ] },
    { title: copy('文字', 'Text'), rows: [
      row(copy('删除线', 'Strikethrough'), key('strike')),
      row(copy('行内代码', 'Inline code'), key('code')),
      row(copy('高亮', 'Highlight'), key('highlight')),
    ] },
    { title: copy('清单', 'Lists'), rows: [
      row(copy('勾选或取消当前待办', 'Check or uncheck this to-do'), key('toggleTask')),
      row(copy('上移／下移这一项', 'Move this item up / down'), key('moveUp'), key('moveDown')),
      row(copy('缩进／取消缩进', 'Indent / outdent'), key('indent'), key('outdent')),
    ] },
    { title: copy('边写边转换', 'Type to format'), rows: [
      row(copy('在空行插入标题、清单、表格等', 'Insert a heading, list, table… on an empty line'), '/', ...en ? [] : ['、']),
      row(copy('标题', 'Heading'), '# '),
      row(copy('列表／编号', 'List / numbered'), '- ', '1. '),
      row(copy('待办', 'To-do'), '[ ] '),
      row(copy('引用／分割线', 'Quote / divider'), '> ', '---'),
      row(copy('粗体', 'Bold'), '**…**'),
    ] },
  ]
}
