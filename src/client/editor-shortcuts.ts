export type EditorShortcut = 'bold' | 'italic' | 'underline' | 'undo' | 'redo' | 'find'
export interface EditorKeyEvent {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean
  isComposing?: boolean; keyCode?: number
}

export function isApplePlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform)
}

/** Only the platform primary modifier; leave clipboard, selection, and unrelated chords to their owners. */
export function editorShortcut(event: EditorKeyEvent, apple = isApplePlatform()): EditorShortcut | null {
  if (event.isComposing || event.keyCode === 229 || event.altKey || (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (!apple && key === 'y' && !event.shiftKey) return 'redo'
  if (event.shiftKey) return null
  return ({ b: 'bold', i: 'italic', u: 'underline', f: 'find' } as const)[key as 'b' | 'i' | 'u' | 'f'] ?? null
}

export function editorShortcutLabel(action: EditorShortcut, apple = isApplePlatform()): string {
  const key = { bold: 'B', italic: 'I', underline: 'U', undo: 'Z', redo: 'Z', find: 'F' }[action]
  return apple ? `${action === 'redo' ? '⇧' : ''}⌘${key}` : `${action === 'redo' ? 'Ctrl+Shift+' : 'Ctrl+'}${key}`
}
