import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHostLocale, hostLabels } from '../src/hermes/host-locale.js'
import { JOT_LOCALES } from '../src/client/i18n.js'

/** Hermes' ctx.i18n: the active locale's bundle, then the plugin's English one, then the key. */
function hostI18n(initial: string, options: { events?: boolean } = {}) {
  let locale = initial
  const bundles = new Map<string, Record<string, string>>()
  const listeners = new Set<() => void>()
  return {
    register(next: Record<string, Record<string, string>>) {
      for (const [id, messages] of Object.entries(next)) bundles.set(id, { ...bundles.get(id), ...messages })
      return () => bundles.clear()
    },
    t: (key: string) => bundles.get(locale)?.[key] ?? bundles.get('en')?.[key] ?? key,
    ...options.events === false ? {} : {
      onLocaleChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    set(next: string) { locale = next; for (const listener of listeners) listener() },
    get listeners() { return listeners.size },
  }
}

test('Jot reads the Hermes language outside React and hears when it changes', () => {
  const i18n = hostI18n('zh-hant')
  const locale = createHostLocale(i18n)
  assert.equal(locale.getSnapshot(), 'zh-hant')
  let changes = 0
  const unsubscribe = locale.subscribe(() => changes++)
  i18n.set('ar')
  assert.equal(locale.getSnapshot(), 'ar')
  assert.equal(changes, 1)
  i18n.set('pl')
  assert.equal(locale.getSnapshot(), 'en', 'a language Jot does not ship (a Hermes pack) shows English')
  i18n.set('en')
  assert.equal(changes, 2, 'no change to the language Jot shows, no update')
  unsubscribe()
  i18n.set('ja')
  assert.equal(changes, 2)
  for (const id of JOT_LOCALES) { i18n.set(id); assert.equal(locale.getSnapshot(), id) }
  locale.dispose()
  assert.equal(i18n.listeners, 0)
})

test('older hosts stay English, and a host without change events is read when asked', () => {
  assert.equal(createHostLocale(undefined).getSnapshot(), 'en')
  assert.equal(createHostLocale({ register: () => () => {} }).getSnapshot(), 'en', 'register without t')
  const i18n = hostI18n('fr', { events: false })
  const locale = createHostLocale(i18n)
  assert.equal(locale.getSnapshot(), 'fr')
  i18n.set('de')
  assert.equal(locale.getSnapshot(), 'de')
  assert.equal(createHostLocale({ register: () => () => {}, t: () => { throw new Error('host failure') } }).getSnapshot(), 'en')
})

test('labels Hermes samples at registration follow the language', () => {
  const english = hostLabels('en')
  assert.deepEqual(english.commands, { 'jot.open': 'Jot: Open Jot', 'jot.new-note': 'Jot: New note', 'jot.capture': 'Jot: Capture selected text' })
  assert.equal(english.name, 'Jot')
  assert.equal(english.open, 'Open Jot')
  assert.deepEqual(english.keywords, ['jot', 'notes'])
  const chinese = hostLabels('zh')
  assert.deepEqual(chinese.commands, { 'jot.open': '随记：打开随记', 'jot.new-note': '随记：新建笔记', 'jot.capture': '随记：摘录选中的文字' })
  assert.equal(chinese.name, '随记')
  assert.equal(chinese.open, '打开随记')
  assert.deepEqual(chinese.keywords, ['jot', 'notes', '随记', '笔记'])
  assert.equal(hostLabels('zh-hant').name, '隨記')
  for (const locale of JOT_LOCALES) {
    const labels = hostLabels(locale)
    if (locale !== 'zh' && locale !== 'zh-hant') assert.equal(labels.name, 'Jot', `${locale} keeps the product name`)
    if (locale !== 'en') {
      assert.notEqual(labels.backendOff, english.backendOff, `${locale} notice`)
      assert.notEqual(labels.commands['jot.new-note'], english.commands['jot.new-note'], `${locale} command`)
    }
  }
})
