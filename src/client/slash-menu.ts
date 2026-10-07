import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { JotActionIconName } from './icons.js'
import type { ShortcutId } from './shortcut-labels.js'
import { JOT_LOCALES, translator, type JotLocale, type Translate } from './i18n.js'

/** The trigger and its filter text, both on an otherwise empty line. */
export interface SlashMatch { from: number; to: number; query: string }

export type SlashItemId = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'taskList' | 'bulletList' | 'orderedList'
  | 'blockquote' | 'codeBlock' | 'table' | 'horizontalRule' | 'attachment'
export interface SlashItem {
  id: SlashItemId
  glyph: string
  /** The toolbar's own icon, where the toolbar has one for this block. */
  icon?: JotActionIconName
  /** English words plus pinyin and its initials, so Chinese labels can be found without switching input method.
   * Every language's label is searched as well (see slashLabels). */
  keywords: readonly string[]
  shortcut?: ShortcutId
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: 'paragraph', glyph: '¶', keywords: ['text', 'paragraph', 'zhengwen', 'zw'], shortcut: 'paragraph' },
  { id: 'heading1', glyph: 'H1', keywords: ['h1', 'heading', 'title', 'biaoti', 'bt'], shortcut: 'heading1' },
  { id: 'heading2', glyph: 'H2', keywords: ['h2', 'heading', 'subtitle', 'biaoti', 'bt'], shortcut: 'heading2' },
  { id: 'heading3', glyph: 'H3', keywords: ['h3', 'heading', 'biaoti', 'bt'], shortcut: 'heading3' },
  { id: 'taskList', glyph: '', icon: 'checklist', keywords: ['todo', 'task', 'checklist', 'daiban', 'qingdan', 'db', 'qd'], shortcut: 'taskList' },
  { id: 'bulletList', glyph: '•', keywords: ['bullet', 'list', 'ul', 'liebiao', 'wuxu', 'lb'], shortcut: 'bulletList' },
  { id: 'orderedList', glyph: '1.', keywords: ['numbered', 'ordered', 'ol', 'list', 'youxu', 'bianhao', 'lb', 'bh'], shortcut: 'orderedList' },
  { id: 'blockquote', glyph: '❝', keywords: ['quote', 'blockquote', 'yinyong', 'yy'], shortcut: 'blockquote' },
  { id: 'codeBlock', glyph: '{ }', keywords: ['code', 'pre', 'daima', 'dmk'], shortcut: 'codeBlock' },
  { id: 'table', glyph: '', icon: 'table', keywords: ['table', 'grid', 'biaoge', 'bg'] },
  { id: 'horizontalRule', glyph: '—', keywords: ['divider', 'rule', 'hr', 'line', 'fengexian', 'fgx'] },
  { id: 'attachment', glyph: '', icon: 'attachment', keywords: ['image', 'picture', 'file', 'attachment', 'upload', 'tupian', 'fujian', 'tp', 'fj'] },
]

/** Each item's label in one language; the catalog keys are the English labels. */
function slashLabels(t: Translate): Record<SlashItemId, string> {
  return { paragraph: t('Text'), heading1: t('Heading 1'), heading2: t('Heading 2'), heading3: t('Heading 3'),
    taskList: t('To-do list'), bulletList: t('Bullet list'), orderedList: t('Numbered list'), blockquote: t('Quote'),
    codeBlock: t('Code block'), table: t('Table'), horizontalRule: t('Divider'), attachment: t('Image or file') }
}

/** Case- and accent-insensitive, without spaces: "Liste à puces" is found by "listeapuces" or "puces". */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase().replace(/\s+/gu, '')
let searchLabels: Record<SlashItemId, string[]> | undefined
/** Typing a label in any language Jot ships finds the item, whatever the interface language. */
function labelsInEveryLanguage(): Record<SlashItemId, string[]> {
  if (searchLabels) return searchLabels
  const all = {} as Record<SlashItemId, string[]>
  for (const locale of JOT_LOCALES) {
    for (const [id, label] of Object.entries(slashLabels(translator(locale))) as Array<[SlashItemId, string]>) {
      const folded = fold(label)
      if (!all[id]?.includes(folded)) (all[id] ??= []).push(folded)
    }
  }
  return searchLabels = all
}

/** Both the ASCII slash and the Chinese input method's 、 (the same key) open the menu. */
const TRIGGER = /^[/、]([^\s/、]{0,24})$/u

/**
 * The menu opens only for a paragraph holding nothing but the trigger and a
 * filter, with the caret at its end, so a "/" or "、" inside a sentence never
 * interrupts writing. Tables and code keep their own meaning.
 */
export function slashMatch(state: EditorState): SlashMatch | null {
  const { selection } = state
  if (!selection.empty) return null
  const { $from } = selection
  const block = $from.parent
  if (block.type.name !== 'paragraph' || $from.parentOffset !== block.content.size) return null
  for (let depth = $from.depth - 1; depth > 0; depth--) if ($from.node(depth).type.name === 'table') return null
  let plain = true
  block.forEach(child => { if (!child.isText) plain = false })
  if (!plain) return null
  const match = TRIGGER.exec(block.textContent)
  return match ? { from: $from.start(), to: $from.pos, query: match[1]! } : null
}

/** Label prefixes rank first, then any label or keyword containing the filter; order is otherwise stable. */
export function filterSlashItems(query: string, options: { attachments?: boolean } = {}): SlashItem[] {
  const items = SLASH_ITEMS.filter(item => item.id !== 'attachment' || options.attachments)
  const compact = fold(query)
  if (!compact) return [...items]
  const every = labelsInEveryLanguage()
  const rank = (item: SlashItem) => {
    const labels = every[item.id]
    if (labels.some(label => label.startsWith(compact))) return 0
    if (labels.some(label => label.includes(compact)) || item.keywords.some(word => word.startsWith(compact))) return 1
    return item.keywords.some(word => word.includes(compact)) ? 2 : -1
  }
  return items.map((item, index) => ({ item, index, score: rank(item) })).filter(entry => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index).map(entry => entry.item)
}

export const slashLabel = (item: SlashItem, locale: JotLocale) => slashLabels(translator(locale))[item.id]

/** Remove the typed trigger, then turn the empty line into the chosen block. */
export function applySlashItem(editor: Editor, match: SlashMatch, id: SlashItemId,
  options: { focus?: boolean; requestAttachment?: () => void } = {}): boolean {
  const start = options.focus === false ? editor.chain() : editor.chain().focus()
  const chain = start.deleteRange({ from: match.from, to: match.to })
  switch (id) {
    case 'paragraph': return chain.setParagraph().run()
    case 'heading1': return chain.setHeading({ level: 1 }).run()
    case 'heading2': return chain.setHeading({ level: 2 }).run()
    case 'heading3': return chain.setHeading({ level: 3 }).run()
    case 'taskList': return chain.toggleTaskList().run()
    case 'bulletList': return chain.toggleBulletList().run()
    case 'orderedList': return chain.toggleOrderedList().run()
    case 'blockquote': return chain.toggleBlockquote().run()
    case 'codeBlock': return chain.setCodeBlock().run()
    case 'table': return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    case 'horizontalRule': return chain.setHorizontalRule().run()
    case 'attachment': {
      const done = chain.run()
      options.requestAttachment?.()
      return done
    }
  }
}
