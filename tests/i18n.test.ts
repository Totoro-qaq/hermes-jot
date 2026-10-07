import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JOT_LOCALES, normalizeLocale, translator, type Catalog, type JotLocale } from '../src/client/i18n.js'
import { CATALOGS, NAMESPACES } from '../src/client/locales/index.js'

/** Every t('…') call in the sources, with the file that makes it. Keys must be plain literals. */
function sourceKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) { if (name !== 'locales') walk(path); continue }
      if (!/\.tsx?$/u.test(name)) continue
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gu)) {
        assert.ok(match[1] !== '`' || !match[2]!.includes('${'), `${path}: t() takes a literal with {placeholders}, not a template: ${match[2]}`)
        keys.set(JSON.parse(`"${match[2]!.replace(/\\'/gu, "'").replace(/"/gu, '\\"')}"`), path)
      }
    }
  }
  walk('src')
  return keys
}
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
const forms = (entry: Catalog[string]) => typeof entry === 'string' ? [entry] : Object.values(entry)

test('host locales map to the languages Jot ships', () => {
  assert.equal(normalizeLocale('zh-TW'), 'zh-hant')
  assert.equal(normalizeLocale('zh-Hant-HK'), 'zh-hant')
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale('fr-FR'), 'fr')
  assert.equal(normalizeLocale('pt-BR'), 'en')
  assert.equal(normalizeLocale(undefined), 'en')
  for (const locale of JOT_LOCALES) assert.equal(normalizeLocale(locale), locale)
})

test('every interface string has a translation in every language, with the same placeholders', () => {
  const keys = sourceKeys()
  const missing: string[] = []
  for (const [key, file] of keys) {
    for (const locale of JOT_LOCALES) {
      if (locale === 'en') continue
      const entry = CATALOGS[locale]?.[key]
      if (entry === undefined) { missing.push(`${locale}: ${JSON.stringify(key)} (${file})`); continue }
      for (const text of forms(entry)) {
        assert.deepEqual(placeholders(text).filter(name => name !== 'count'), placeholders(key).filter(name => name !== 'count'),
          `${locale} placeholders for ${JSON.stringify(key)}`)
      }
    }
  }
  assert.deepEqual(missing.slice(0, 40), [], `${missing.length} missing translations`)
})

test('catalogs hold no stale keys, and a key shared by two areas translates the same way', () => {
  const keys = sourceKeys()
  const seen = new Map<string, string>()
  for (const [name, namespace] of Object.entries(NAMESPACES)) {
    for (const [locale, catalog] of Object.entries(namespace) as Array<[JotLocale, Catalog]>) {
      for (const [key, entry] of Object.entries(catalog)) {
        assert.ok(keys.has(key), `${name}.${locale}: ${JSON.stringify(key)} is not used by any t() call`)
        const id = `${locale}\u0000${key}`
        const value = JSON.stringify(entry)
        if (seen.has(id)) assert.equal(value, seen.get(id), `${locale}: ${JSON.stringify(key)} differs between areas`)
        seen.set(id, value)
      }
    }
  }
})

test('plural forms follow each language and fall back to English forms', () => {
  const t = translator('en')
  assert.equal(t('Untranslated {name}', { name: 'x' }), 'Untranslated x')
  for (const locale of JOT_LOCALES) {
    const translate = translator(locale)
    for (const [key, entry] of Object.entries(CATALOGS[locale] ?? {})) {
      if (typeof entry === 'string') continue
      assert.ok(entry.other.length > 0, `${locale}: ${key} needs an "other" form`)
      for (const count of [0, 1, 2, 5, 11, 21, 101]) assert.ok(!/\{count\}/u.test(translate(key, { count })), `${locale}: ${key} left {count}`)
    }
  }
})
