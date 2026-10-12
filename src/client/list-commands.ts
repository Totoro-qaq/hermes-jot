import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

type Dispatch = ((tr: Transaction) => void) | undefined
const LIST_ITEMS = new Set(['listItem', 'taskItem'])

/** Depth of the innermost node of one of `types` that contains the whole selection. */
function sharedAncestor(state: EditorState, types: ReadonlySet<string>): number | null {
  const { $from, $to } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if (!types.has($from.node(depth).type.name)) continue
    // A selection spanning two items moves or toggles neither.
    return $to.depth >= depth && $to.before(depth) === $from.before(depth) ? depth : null
  }
  return null
}

/** Mod+Enter inside a to-do flips its checkbox; anywhere else the key keeps its editor meaning. */
export function toggleTaskAtSelection(state: EditorState, dispatch?: Dispatch): boolean {
  const depth = sharedAncestor(state, new Set(['taskItem']))
  if (depth === null) return false
  const position = state.selection.$from.before(depth)
  const item = state.doc.nodeAt(position)
  if (!item) return false
  dispatch?.(state.tr.setNodeMarkup(position, undefined, { ...item.attrs, checked: !item.attrs.checked }).scrollIntoView())
  return true
}

/**
 * Swap the list or to-do item holding the selection with its neighbour, keeping
 * the caret in the moved item. Nested lists move within their own level.
 */
export function moveListItem(direction: 'up' | 'down') {
  return (state: EditorState, dispatch?: Dispatch): boolean => {
    const depth = sharedAncestor(state, LIST_ITEMS)
    if (depth === null) return false
    const { $from, anchor, head } = state.selection
    const list = $from.node(depth - 1)
    const index = $from.index(depth - 1)
    const neighbour = direction === 'up' ? index - 1 : index + 1
    if (neighbour < 0 || neighbour >= list.childCount) return false
    if (!dispatch) return true
    const item = $from.node(depth)
    const other = list.child(neighbour)
    const itemStart = $from.before(depth)
    const start = direction === 'up' ? itemStart - other.nodeSize : itemStart
    const end = direction === 'up' ? itemStart + item.nodeSize : itemStart + item.nodeSize + other.nodeSize
    const tr = state.tr.replaceWith(start, end, Fragment.from(direction === 'up' ? [item, other] : [other, item]))
    const shift = direction === 'up' ? -other.nodeSize : other.nodeSize
    const moved = state.selection instanceof TextSelection
      ? TextSelection.create(tr.doc, anchor + shift, head + shift) : Selection.near(tr.doc.resolve(head + shift))
    dispatch(tr.setSelection(moved).scrollIntoView())
    return true
  }
}

function listNeedsTidy(list: ProseMirrorNode): boolean {
  let seenCompleted = false
  for (let index = 0; index < list.childCount; index++) {
    const completed = list.child(index).attrs.checked === true
    if (!completed && seenCompleted) return true
    if (completed) seenCompleted = true
  }
  return false
}

const tidyNeeded = new WeakMap<ProseMirrorNode, boolean>()

/** 同一份文档只扫一次。按钮的禁用状态可以在每次重绘时问，不必重建事务。 */
export function taskListsNeedTidy(doc: ProseMirrorNode): boolean {
  const cached = tidyNeeded.get(doc)
  if (cached !== undefined) return cached
  let needs = false
  doc.descendants(node => {
    if (needs) return false
    if (node.type.name === 'taskList' && listNeedsTidy(node)) needs = true
  })
  tidyNeeded.set(doc, needs)
  return needs
}

/** 光标所在文本块。整理会挪动条目，但块节点本身还是原来那个，用来把光标放回去。 */
function textblockBookmark(state: EditorState): { node: ProseMirrorNode; anchor: number; head: number } | null {
  const { $anchor, $head } = state.selection
  if (!$anchor.sameParent($head) || !$anchor.parent.isTextblock) return null
  const pos = $anchor.before($anchor.depth)
  return { node: $anchor.parent, anchor: state.selection.anchor - pos, head: state.selection.head - pos }
}

function restoreTextblock(tr: Transaction, bookmark: { node: ProseMirrorNode; anchor: number; head: number } | null): Transaction {
  if (!bookmark) return tr
  let found = -1
  tr.doc.descendants((node, pos) => {
    if (node === bookmark.node) { found = pos; return false }
  })
  if (found < 0) return tr
  const end = found + bookmark.node.nodeSize
  const clamp = (offset: number) => Math.min(Math.max(found + offset, found + 1), end - 1)
  return tr.setSelection(TextSelection.create(tr.doc, clamp(bookmark.anchor), clamp(bookmark.head)))
}

/**
 * 每个清单各自整理：未完成的保持原顺序留在上面，已完成的保持原顺序移到底部。
 * 嵌套清单先整理，外层再重排。这次整理单独占一个撤销步骤，光标留在原来的条目上。
 */
export function tidyCompletedTasks(state: EditorState, dispatch?: Dispatch): boolean {
  const lists: number[] = []
  state.doc.descendants((node, pos) => { if (node.type.name === 'taskList') lists.push(pos) })
  lists.sort((left, right) => right - left)
  let tr = closeHistory(state.tr)
  let changed = false
  for (const pos of lists) {
    const mapped = tr.mapping.map(pos)
    const list = tr.doc.nodeAt(mapped)
    if (!list || list.type.name !== 'taskList' || !listNeedsTidy(list)) continue
    const pending: ProseMirrorNode[] = []
    const done: ProseMirrorNode[] = []
    for (let index = 0; index < list.childCount; index++) {
      const child = list.child(index)
      ;(child.attrs.checked === true ? done : pending).push(child)
    }
    tr = tr.replaceWith(mapped + 1, mapped + list.nodeSize - 1, Fragment.from([...pending, ...done]))
    changed = true
  }
  if (!changed) return false
  dispatch?.(restoreTextblock(tr, textblockBookmark(state)).scrollIntoView())
  return true
}

/** Keys for checklist work; they only act inside list items, so other blocks keep their defaults. */
export const JotListKeys = Extension.create({
  name: 'jotListKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    const run = (command: (state: EditorState, dispatch?: Dispatch) => boolean) => () =>
      this.editor.isEditable && command(this.editor.state, this.editor.view.dispatch)
    return {
      'Mod-Enter': run(toggleTaskAtSelection),
      'Alt-Shift-ArrowUp': run(moveListItem('up')),
      'Alt-Shift-ArrowDown': run(moveListItem('down')),
    }
  },
})

/**
 * Older notes and agent Markdown may hold H4–H6, so they still render, but only
 * the three levels the Style menu offers get keys.
 */
export const JotHeadingKeys = Extension.create({
  name: 'jotHeadingKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return Object.fromEntries([4, 5, 6].map(level => [`Mod-Alt-${level}`, () => true]))
  },
})
