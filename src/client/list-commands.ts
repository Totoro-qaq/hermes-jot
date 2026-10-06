import { Extension } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
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
