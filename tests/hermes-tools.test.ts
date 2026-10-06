import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JotStore } from '../src/store.js'
import { docFromText } from '../src/model.js'
import { createJotTools } from '../src/tools.js'

test('tool summaries never split an emoji into an unpaired surrogate across the Python bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jot-tool-unicode-'))
  try {
    const store = new JotStore({ directory })
    await store.setAgentEnabled(true)
    await store.createNote({ title: 'Unicode', content: docFromText('a'.repeat(159) + '🙂 more') })
    const tool = createJotTools(store).find(item => item.name === 'jot_list')!
    const result = await tool.execute({}) as { notes: Array<{ excerpt: string }> }
    assert.equal(Array.from(result.notes[0].excerpt).length, 160)
    assert.ok(result.notes[0].excerpt.endsWith('🙂'))
    assert.doesNotThrow(() => encodeURIComponent(result.notes[0].excerpt))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
