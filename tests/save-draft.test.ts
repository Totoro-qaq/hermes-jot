import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { JotStore, StoreError } from '../src/store.js'
import { docFromText } from '../src/model.js'
import { draftFromNote } from '../src/client/drafts.js'
import { JotApiError } from '../src/client/api.js'
import { saveHumanDraft } from '../src/client/save-draft.js'
import type { JotApi } from '../src/client/types.js'

test('two panes saving the identical draft acknowledge the same store revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jot-pane-save-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new JotStore({ directory })
  const api: Pick<JotApi, 'getNote' | 'updateNote'> = {
    getNote: id => store.getNote(id),
    async updateNote(id, { revision, ...patch }) {
      try { return await store.updateNote(id, revision, patch) }
      catch (error) { if (error instanceof StoreError) throw new JotApiError(error.status, error.code, error.message); throw error }
    },
  }
  const note = await store.createNote({ title: 'Handoff' })
  const draft = { ...draftFromNote(note), dirty: true, content: docFromText('The same unsaved thought') }
  const [wide, compact] = await Promise.all([saveHumanDraft(api, draft), saveHumanDraft(api, draft)])
  assert.equal(wide.revision, 2)
  assert.deepEqual(wide, compact)
  const different = { ...draft, content: docFromText('A different thought') }
  await assert.rejects(saveHumanDraft(api, different), (error: unknown) => error instanceof JotApiError && error.code === 'REVISION_CONFLICT')
  await assert.rejects(saveHumanDraft(api, { ...draft, pinned: true }), /revision/i)
  assert.equal((await store.getNote(note.id)).text, 'The same unsaved thought')
})
