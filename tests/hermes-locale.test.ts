import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalePreference } from '../src/hermes/locale.js'

test('Hermes starts in English and preserves an explicit Chinese preference across reloads', () => {
  const data = new Map<string, unknown>()
  const storage = { get: <T>(key: string, fallback: T) => data.has(key) ? data.get(key) as T : fallback,
    set: (key: string, value: unknown) => { data.set(key, value) } }
  const preference = createLocalePreference(storage)
  assert.equal(preference.getSnapshot(), 'en')
  let updates = 0
  const unsubscribe = preference.subscribe(() => updates++)
  preference.set('zh')
  assert.equal(updates, 1)
  assert.equal(createLocalePreference(storage).getSnapshot(), 'zh')
  unsubscribe()
  preference.set('en')
  assert.equal(updates, 1)
  assert.equal(createLocalePreference(storage).getSnapshot(), 'en')
})
