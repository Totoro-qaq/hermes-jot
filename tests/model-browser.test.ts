import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendExcerpt } from '../src/client/note-actions.js'
import { docFromText, docToText, MAX_DOC_BYTES, StoreError, validateRichDoc } from '../src/model.js'

test('browser-shared document validation and capture work without the Node Buffer global', () => {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')!
  Reflect.deleteProperty(globalThis, 'Buffer')
  try {
    const initial = docFromText('已有正文 🙂')
    const captured = appendExcerpt(initial, '新的摘录 👩🏽\u200d💻', 'https://example.org/reading')
    assert.ok(docToText(validateRichDoc(captured)).includes('新的摘录 👩🏽\u200d💻'))
  } finally { Object.defineProperty(globalThis, 'Buffer', buffer) }
})

test('Unicode document size uses UTF-8 bytes rather than JavaScript string length', () => {
  const document = (character: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: Array.from({ length: 450 }, () => ({
    type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: `https://example.org/${character.repeat(800)}` } }],
  })) }] })
  const ascii = document('a')
  const unicode = document('界')
  assert.ok(JSON.stringify(unicode).length < MAX_DOC_BYTES)
  assert.ok(new TextEncoder().encode(JSON.stringify(unicode)).byteLength > MAX_DOC_BYTES)
  assert.doesNotThrow(() => validateRichDoc(ascii))
  assert.throws(() => validateRichDoc(unicode), error => error instanceof StoreError && error.code === 'INVALID_INPUT' && /byte limit/.test(error.message))
  // Ordinary Unicode prose remains valid up to the existing character cap.
  assert.equal(docToText(docFromText('界'.repeat(200_000))).length, 200_000)
})
