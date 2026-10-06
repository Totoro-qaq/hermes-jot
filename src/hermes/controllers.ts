import { createCommandBus, type JotCompactRecipient } from '../client/commands.js'
import { createNoteHandoff } from '../client/note-handoff.js'

export function createControllers(openWide: () => void) {
  const entries = new Map<string, ReturnType<typeof make>>()
  function make(owner: string) {
    const lifetime = new AbortController()
    const bus = createCommandBus()
    const recipient: JotCompactRecipient = { sessionId: owner, tabId: 'jot:notes', signal: lifetime.signal }
    let selectedText = '', selectionOwner = ''
    return { bus, recipient, handoff: createNoteHandoff(openWide), get selectedText() { return selectedText },
      select(frame: string, text: string | null) {
        if (text === null) { if (selectionOwner === frame) selectedText = ''; return }
        selectionOwner = frame; selectedText = text
      },
      clearSelection() { selectedText = ''; selectionOwner = '' },
      dispose() { lifetime.abort(); bus.dispose(); selectedText = ''; selectionOwner = '' },
    }
  }
  return {
    forOwner(owner: string) {
      if (!entries.has(owner)) entries.set(owner, make(owner))
      return entries.get(owner)!
    },
    retainOwner(owner: string) {
      for (const [key, entry] of entries) if (key !== owner) { entry.dispose(); entries.delete(key) }
    },
    dispose() { for (const entry of entries.values()) entry.dispose(); entries.clear() },
  }
}
