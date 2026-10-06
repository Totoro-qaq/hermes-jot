import { DraftStorage, type DraftStorageBackend } from '../client/drafts.js'

export interface Preferences { get(key: string): string | null; set(key: string, value: string | null): void }
export interface JotPersistence { preferences: Preferences; drafts: DraftStorage }

/** Scope captures a connection and profile; old async saves never acquire a new profile's keys. */
export function createPersistence(scope: string, backend: DraftStorageBackend): JotPersistence {
  const prefix = `jot:${encodeURIComponent(scope)}:`
  const scoped: DraftStorageBackend = {
    getItem: key => backend.getItem(prefix + key),
    setItem: (key, value) => backend.setItem(prefix + key, value),
    removeItem: key => backend.removeItem(prefix + key),
  }
  return { drafts: new DraftStorage(scoped), preferences: {
    get: key => scoped.getItem(key),
    set: (key, value) => value === null ? scoped.removeItem(key) : scoped.setItem(key, value),
  } }
}
