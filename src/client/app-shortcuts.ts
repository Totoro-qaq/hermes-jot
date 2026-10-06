import { isApplePlatform, type EditorKeyEvent } from './editor-shortcuts.js'

export function appShortcut(event: EditorKeyEvent, apple = isApplePlatform()): 'save' | 'find' | null {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey
    || (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null
  return ({ s: 'save', f: 'find' } as const)[event.key.toLowerCase() as 's' | 'f'] ?? null
}
