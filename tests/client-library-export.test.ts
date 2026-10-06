import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportSavedLibrary } from '../src/client/library-export.js'
import type { LibraryDownload } from '../src/client/types.js'

function fixture() {
  let draft = { noteId: 'active', dirty: true }
  let conflict = false
  let exports = 0
  const file: LibraryDownload = { blob: new Blob(['archive']), filename: 'Jot.zip', notes: 1, attachments: 0 }
  const options = {
    draft,
    readDraft: () => draft,
    conflicted: () => conflict,
    save: async () => { draft = { ...draft, dirty: false }; return true },
    export: async () => { exports++; return file },
    unsavedMessage: 'Resolve the kept draft before exporting.',
  }
  return { options, file, get exports() { return exports }, setConflict() { conflict = true },
    markSaved() { draft = { ...draft, dirty: false } } }
}

test('library export refuses a conflicting draft without requesting an archive', async () => {
  const value = fixture()
  value.setConflict()
  let saves = 0
  value.options.save = async () => { saves++; return true }
  await assert.rejects(exportSavedLibrary(value.options), /kept draft/u)
  assert.equal(saves, 0)
  assert.equal(value.exports, 0)
})

test('failed save never produces a successful stale library download', async () => {
  const value = fixture()
  value.options.save = async () => false
  await assert.rejects(exportSavedLibrary(value.options), /kept draft/u)
  assert.equal(value.exports, 0)
})

test('an old pending autosave settles before the latest writing is saved and exported', async () => {
  const value = fixture()
  let release!: (saved: boolean) => void
  const pending = new Promise<boolean>(resolve => { release = resolve })
  let saves = 0
  value.options.save = async () => {
    if (++saves === 1) return pending
    value.markSaved()
    return true
  }
  const result = exportSavedLibrary(value.options)
  assert.equal(value.exports, 0, 'the archive must wait for the older autosave')
  release(true)
  assert.equal(await result, value.file)
  assert.equal(saves, 2, 'the first acknowledgement did not include the latest draft')
  assert.equal(value.exports, 1)
})

test('a draft still dirty after saves, or one that becomes conflicting, blocks export', async () => {
  const value = fixture()
  let saves = 0
  value.options.save = async () => { saves++; return true }
  await assert.rejects(exportSavedLibrary(value.options), /kept draft/u)
  assert.equal(saves, 2)
  assert.equal(value.exports, 0)
  const conflicted = fixture()
  conflicted.options.save = async () => { conflicted.setConflict(); return true }
  await assert.rejects(exportSavedLibrary(conflicted.options), /kept draft/u)
  assert.equal(conflicted.exports, 0)
})

test('a clean or successfully saved note exports exactly once', async () => {
  const saved = fixture()
  assert.equal(await exportSavedLibrary(saved.options), saved.file)
  assert.equal(saved.exports, 1)
  const clean = fixture()
  clean.options.draft = { noteId: 'active', dirty: false }
  clean.options.save = async () => { assert.fail('clean notes do not need saving') }
  assert.equal(await exportSavedLibrary(clean.options), clean.file)
  assert.equal(clean.exports, 1)
})
