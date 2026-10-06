import assert from 'node:assert/strict'
import type { FileHandle } from 'node:fs/promises'
import { test } from 'node:test'
import { acquireFileLock } from '../src/file-lock.js'
import { StoreError } from '../src/store.js'
import { AttachmentError } from '../src/attachments.js'

const failure = (code: string) => Object.assign(new Error(`Synthetic filesystem ${code}`), { code })
const path = 'synthetic-lock-file'
const errors = [
  {
    name: 'notes',
    persistenceError: (cause: unknown) => new StoreError('PERSISTENCE_ERROR', 'Cannot acquire the notes lock', { cause }),
    timeoutError: () => new StoreError('LOCK_TIMEOUT', 'Notes are locked'),
    persistenceCode: 'PERSISTENCE_ERROR', timeoutCode: 'LOCK_TIMEOUT',
  },
  {
    name: 'attachments',
    persistenceError: (cause: unknown) => new AttachmentError('ATTACHMENT_PERSISTENCE', 'Cannot lock attachment storage.', 500, { cause }),
    timeoutError: () => new AttachmentError('ATTACHMENT_LOCKED', 'Attachment storage is busy.', 503),
    persistenceCode: 'ATTACHMENT_PERSISTENCE', timeoutCode: 'ATTACHMENT_LOCKED',
  },
]

function file() {
  const calls = { writes: 0, syncs: 0, closes: 0 }
  const handle: Pick<FileHandle, 'writeFile' | 'sync' | 'close'> = {
    writeFile: async () => { calls.writes++ },
    sync: async () => { calls.syncs++ },
    close: async () => { calls.closes++ },
  }
  return { calls, handle }
}

for (const domain of errors) {
  test(`${domain.name} lock retries Windows exclusive-open EPERM and EEXIST without stealing or reinitializing`, async () => {
    const held = file()
    const events: string[] = []
    const sequence = [failure('EPERM'), failure('EEXIST')]
    let time = 0, attempts = 0
    const unlock = await acquireFileLock({
      path, timeoutMs: 24, ...domain,
      initialize: async handle => { events.push('initialize'); await handle.writeFile('synthetic ownership') },
    }, {
      platform: 'win32', now: () => time,
      open: async (actualPath, flags, mode) => {
        assert.equal(actualPath, path); assert.equal(flags, 'wx'); assert.equal(mode, 0o600)
        events.push('open'); attempts++
        if (sequence.length) throw sequence.shift()!
        return held.handle
      },
      wait: async milliseconds => { assert.equal(milliseconds, 12); time += milliseconds; events.push('wait') },
      remove: async actualPath => { assert.equal(actualPath, path); events.push('remove') },
    })
    assert.equal(attempts, 3)
    assert.deepEqual(events, ['open', 'wait', 'open', 'wait', 'open', 'initialize'])
    assert.deepEqual(held.calls, { writes: 1, syncs: 0, closes: 1 })
    await unlock()
    assert.equal(events.at(-1), 'remove')
    assert.equal(events.filter(event => event === 'remove').length, 1)
  })

  test(`${domain.name} lock preserves a persistent Windows EPERM and its original deadline/cause`, async () => {
    const denied = failure('EPERM')
    let time = 0, attempts = 0
    await assert.rejects(acquireFileLock({
      path, timeoutMs: 24, ...domain,
      initialize: async () => { assert.fail('An unacquired lock must not initialize') },
    }, {
      platform: 'win32', now: () => time,
      open: async (_path, flags) => { assert.equal(flags, 'wx'); attempts++; throw denied },
      wait: async milliseconds => { assert.equal(milliseconds, 12); time += milliseconds },
      remove: async () => { assert.fail('A foreign lock must never be removed') },
    }), (error: unknown) => error instanceof Error && 'code' in error && error.code === domain.persistenceCode && error.cause === denied)
    assert.equal(attempts, 3)
    assert.equal(time, 24)
  })

  test(`${domain.name} lock retains EEXIST timeout semantics and never removes the held lock`, async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      let time = 0, attempts = 0
      await assert.rejects(acquireFileLock({
        path, timeoutMs: 24, ...domain,
        initialize: async () => { assert.fail('An unacquired lock must not initialize') },
      }, {
        platform, now: () => time,
        open: async () => { attempts++; throw failure('EEXIST') },
        wait: async milliseconds => { assert.equal(milliseconds, 12); time += milliseconds },
        remove: async () => { assert.fail('A foreign lock must never be removed') },
      }), (error: unknown) => error instanceof Error && 'code' in error && error.code === domain.timeoutCode)
      assert.equal(attempts, 3)
      assert.equal(time, 24)
    }
  })

  test(`${domain.name} lock fails immediately for non-Windows EPERM and other filesystem errors`, async () => {
    for (const [platform, code] of [['darwin', 'EPERM'], ['linux', 'EPERM'], ['win32', 'EACCES'], ['win32', 'ENOSPC']] as const) {
      const denied = failure(code)
      let attempts = 0
      await assert.rejects(acquireFileLock({
        path, timeoutMs: 24, ...domain,
        initialize: async () => { assert.fail('An unacquired lock must not initialize') },
      }, {
        platform, now: () => 0,
        open: async () => { attempts++; throw denied },
        wait: async () => { assert.fail('A non-contention error must not retry') },
        remove: async () => { assert.fail('An unowned lock must never be removed') },
      }), (error: unknown) => error instanceof Error && 'code' in error && error.code === domain.persistenceCode && error.cause === denied)
      assert.equal(attempts, 1)
    }
  })

  test(`${domain.name} lock metadata failures clean up owned handles/locks without entering Windows acquisition retries`, async () => {
    for (const stage of ['writeFile', 'sync'] as const) {
      const denied = failure('EPERM')
      const held = file()
      let attempts = 0, removals = 0
      held.handle[stage] = async () => { throw denied }
      await assert.rejects(acquireFileLock({
        path, timeoutMs: 24, ...domain,
        initialize: async handle => { await handle.writeFile('synthetic ownership'); await handle.sync() },
      }, {
        platform: 'win32', now: () => 0,
        open: async () => { attempts++; return held.handle },
        wait: async () => { assert.fail('Failure after ownership must not retry') },
        remove: async actualPath => { assert.equal(actualPath, path); removals++ },
      }), (error: unknown) => error instanceof Error && 'code' in error && error.code === domain.persistenceCode && error.cause === denied)
      assert.equal(attempts, 1)
      assert.equal(held.calls.closes, 1)
      assert.equal(removals, 1)
    }
  })
}
