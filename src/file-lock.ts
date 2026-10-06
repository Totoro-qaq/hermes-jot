import { open, rm, type FileHandle } from 'node:fs/promises'

type LockFile = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>

interface FileLockOptions {
  path: string
  timeoutMs: number
  initialize: (file: LockFile) => Promise<void>
  persistenceError: (cause: unknown) => Error
  timeoutError: () => Error
}

/** Internal test seams; they are not user-configurable Store options. */
interface FileLockRuntime {
  platform: NodeJS.Platform
  open: (path: string, flags: 'wx', mode: number) => Promise<LockFile>
  remove: (path: string) => Promise<void>
  now: () => number
  wait: (milliseconds: number) => Promise<void>
}

function errno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code
}

/** Acquire without stealing existing locks, and initialize only after exclusive creation succeeds. */
export async function acquireFileLock(options: FileLockOptions, runtime: Partial<FileLockRuntime> = {}): Promise<() => Promise<void>> {
  const platform = runtime.platform ?? process.platform
  const openFile = runtime.open ?? open
  const remove = runtime.remove ?? (async (path: string) => { await rm(path, { force: true }) })
  const now = runtime.now ?? Date.now
  const wait = runtime.wait ?? (async (milliseconds: number) => { await new Promise(resolve => setTimeout(resolve, milliseconds)) })
  const deadline = now() + options.timeoutMs

  let file: LockFile
  while (true) {
    try {
      file = await openFile(options.path, 'wx', 0o600)
      break
    } catch (cause) {
      const exists = errno(cause, 'EEXIST')
      // Windows can return access denied while a just-released lock is delete-pending.
      // Retry only exclusive creation; persistent permission failures retain their cause.
      const pendingDelete = platform === 'win32' && errno(cause, 'EPERM')
      if (!exists && !pendingDelete) throw options.persistenceError(cause)
      if (now() >= deadline) throw exists ? options.timeoutError() : options.persistenceError(cause)
      await wait(12)
    }
  }

  // Errors after ownership must never re-enter the acquisition loop.
  try { await options.initialize(file) }
  catch (cause) {
    try { await file.close(); await remove(options.path) }
    catch (cleanupCause) { throw options.persistenceError(cleanupCause) }
    throw options.persistenceError(cause)
  }
  try { await file.close() }
  catch (cause) { throw options.persistenceError(cause) }
  return async () => { await remove(options.path) }
}
