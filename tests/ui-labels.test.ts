import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileSize } from '../src/client/AttachmentPreview.js'
import { JOT_COMMANDS } from '../src/client/commands.js'
import { JOT_LOCALES, translator, type JotLocale } from '../src/client/i18n.js'
import { shortcutHelpSections } from '../src/client/shortcut-labels.js'

test('shortcut help is complete in every language', () => {
  for (const locale of JOT_LOCALES) for (const apple of [true, false]) {
    const sections = shortcutHelpSections(locale, apple)
    assert.ok(sections.length >= 5)
    for (const section of sections) for (const row of section.rows) {
      assert.ok(row.label && row.keys.length && row.keys.every(Boolean), `${locale}/${apple}: ${row.label}`)
    }
  }
  // Only the Simplified Chinese input method types 、 on the slash key.
  const ideographicComma = (locale: JotLocale) => shortcutHelpSections(locale, true).some(section => section.rows.some(row => row.keys.includes('、')))
  assert.deepEqual(JOT_LOCALES.filter(ideographicComma), ['zh'])
  assert.equal(shortcutHelpSections('fr', true)[0]!.title, 'Bibliothèque')
  assert.equal(shortcutHelpSections('en', true)[3]!.title, 'Inline styles')
})

test('attachment sizes are binary kilobytes in the reader\'s digits and unit', () => {
  assert.equal(fileSize(1536, 'en'), '1.5 KB')
  assert.equal(fileSize(1536, 'zh'), '1.5 KB')
  assert.equal(fileSize(1536, 'fr'), '1,5\u00a0Ko')
  assert.equal(fileSize(1536, 'ru'), '1,5\u00a0КБ')
  assert.equal(fileSize(2048, 'de'), '2,0 KB')
})

test('commands keep their ids and actions and carry an English label the host can translate', () => {
  assert.deepEqual(JOT_COMMANDS.map(item => [item.id, item.action]), [['jot.open', 'open'], ['jot.new-note', 'new'], ['jot.capture', 'capture']])
  for (const item of JOT_COMMANDS) {
    assert.match(item.label, /^Jot: /u)
    assert.equal(item.en, item.label, 'hosts that still read `en` register the English label')
  }
  assert.deepEqual(JOT_COMMANDS.map(item => translator('zh')(item.label)), ['随记：打开随记', '随记：新建笔记', '随记：摘录选中的文字'])
})
