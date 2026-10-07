import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeError, describeSkipReason } from '../src/client/errors.js'
import { JotApiError } from '../src/client/api.js'
import { JOT_LOCALES } from '../src/client/i18n.js'

const coded = (code: string, message = 'English detail for logs') => new JotApiError(400, code, message)

test('host error codes read as sentences in every language, never as the English log message', () => {
  for (const code of ['REVISION_CONFLICT', 'PROFILE_CHANGED', 'ATTACHMENT_QUOTA', 'RUNTIME_UNAVAILABLE', 'EDITOR_UNAVAILABLE', 'UNSUPPORTED_LINK']) {
    const english = describeError(coded(code), 'en')
    assert.notEqual(english, 'English detail for logs', code)
    for (const locale of JOT_LOCALES) {
      if (locale !== 'en') assert.notEqual(describeError(coded(code), locale), english, `${locale} ${code}`)
    }
  }
  assert.equal(describeError(coded('REVISION_CONFLICT'), 'zh'), '这条笔记已在别处更新，请重新打开后再试。')
  assert.equal(describeError(coded('ATTACHMENT_QUOTA'), 'fr'), "L'espace des pièces jointes est plein. Videz la Corbeille pour libérer de l'espace.")
  assert.equal(describeError(coded('INVALID_INPUT', 'Folder name already exists'), 'ru'), 'Папка с таким именем уже существует.')
  assert.equal(describeError(coded('INVALID_INPUT', 'something else'), 'es'), 'No se pudo guardar este contenido. Revísalo e inténtalo de nuevo.')
  assert.equal(describeError(new TypeError('Failed to fetch'), 'ar'), 'تعذّر الوصول إلى Hermes. تأكّد من أنه لا يزال قيد التشغيل.')
  assert.equal(describeError(new Error('Already localized by the client.'), 'de'), 'Already localized by the client.')
  assert.equal(describeError({ code: 'UNKNOWN' }, 'zh-hant'), '操作沒有完成，請重試。')
  assert.equal(describeError(coded('toString'), 'en'), 'The operation did not complete. Try again.', 'codes are not object keys')
})

test('import skip reasons follow the language; English keeps the engine detail', () => {
  const detailed = 'The note is too large or complex for Jot: Document exceeds byte limit.'
  assert.equal(describeSkipReason(detailed, 'en'), detailed)
  assert.equal(describeSkipReason(detailed, 'ja'), 'ノートが大きすぎるか複雑すぎるため、Jot で扱えません。')
  assert.equal(describeSkipReason('Unsafe path in the archive.', 'zh'), '压缩包中的路径不安全。')
  assert.equal(describeSkipReason('The file could not be attached.', 'de'), 'Die Datei konnte nicht angehängt werden.')
  assert.equal(describeSkipReason('7 more files were skipped.', 'fr'), '7 more files were skipped.', 'the summary entry is parsed, not shown')
})
