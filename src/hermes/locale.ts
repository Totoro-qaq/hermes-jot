import type { JotLocale } from '../client/types.js'

/** Hermes edition starts in English; changing Jot never changes the host locale. */
export function createLocalePreference(storage: {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}) {
  const key = 'interface-language'
  let value: JotLocale = storage.get<string>(key, 'en') === 'zh' ? 'zh' : 'en'
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: JotLocale) {
      if (next === value) return
      storage.set(key, next)
      value = next
      for (const listener of listeners) listener()
    },
  }
}
