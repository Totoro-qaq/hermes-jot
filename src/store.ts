import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acquireFileLock } from './file-lock.js'
import {
  StoreError, appendBlocks, boundedString, docFromText, documentAttachmentIds, onlyKeys, record,
  validateActor, validateId, validateRichDoc, validatedDocText,
  MAX_FOLDER_NAME_LENGTH, MAX_STATE_BYTES, MAX_TEXT_LENGTH, MAX_TITLE_LENGTH,
  type Actor, type CreateNoteInput, type Folder, type JotState,
  type Note, type NoteSummary, type RichDoc, type UpdateNotePatch,
} from './model.js'

export { StoreError } from './model.js'
export const STATE_FILENAME = 'jot.json'
export const BACKUP_FILENAME = 'jot.json.bak'
export const LOCK_FILENAME = '.jot.lock'
/** Best-effort attribution beside jot.json, so older plugin versions can still read the notes file. */
export const ACTIVITY_FILENAME = 'jot.activity.json'
const MAX_ACTIVITY_BYTES = 2 * 1_048_576
/** Pre-AI versions live beside jot.json, one small file per note, so the notes file format never changes. */
export const AGENT_UNDO_DIRECTORY = 'jot.agent-undo'
const MAX_UNDO_BYTES = 2 * 1_048_576
const NOTE_KEYS = ['id', 'title', 'content', 'text', 'folderId', 'pinned', 'revision', 'createdAt', 'updatedAt', 'deletedAt']

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
function invalid(message: string): never { throw new StoreError('INVALID_INPUT', message) }
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(`${name} must be a boolean`)
  return value
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('Invalid timestamp')
  return value
}
function timestamp(previous?: string): string {
  return new Date(Math.max(Date.now(), previous === undefined ? 0 : Date.parse(previous) + 1)).toISOString()
}
function compareNotes(a: Note, b: Note): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
}
function summary(note: Note): NoteSummary {
  const { content: _content, text: _text, ...metadata } = note
  return structuredClone(metadata)
}
function emptyState(): JotState { return { version: 1, notes: [], folders: [], agentEnabled: false } }
const contentTag = (source: string): string => createHash('sha256').update(source).digest('base64url').slice(0, 22)

/** The latest saved revision of a note that came from an agent tool. */
export interface AgentEdit {
  revision: number
  at: string
  /** True when the version before this run of agent edits was kept and can be restored. */
  undo?: boolean
}
/** The note as it was before an uninterrupted run of agent edits. */
export interface AgentUndoBefore { revision: number; title: string; content: RichDoc; folderId: string | null }
interface AgentUndo { version: 1; noteId: string; revision: number; at: string; before: AgentUndoBefore }
/** User-facing snapshot: the notes state plus agent attribution for unchanged agent revisions. */
export interface JotSnapshot extends JotState { agentEdits: Record<string, AgentEdit> }
export interface PurgeResult { purged: string[]; attachments: string[] }
/** Imported notes name a folder created or reused by the same import, or an existing folder id. */
export interface ImportNoteInput { title: string; content: RichDoc; folderName: string | null; folderId: string | null }
export interface ImportNotesInput { folders: string[]; notes: ImportNoteInput[] }
/** `folders` counts the folders this import created. */
export interface ImportNotesResult { noteIds: string[]; folders: number }
export const MAX_NOTES = 10_000
export const MAX_FOLDERS = 1_000

function validateState(input: unknown): JotState {
  const data = record(input, 'state')
  onlyKeys(data, ['version', 'notes', 'folders', 'agentEnabled'], 'state')
  if (data.version !== 1 || !Array.isArray(data.notes) || !Array.isArray(data.folders)) invalid('Unsupported state format')
  if (data.notes.length > MAX_NOTES || data.folders.length > MAX_FOLDERS) invalid('State contains too many entries')
  const folders: Folder[] = data.folders.map(value => {
    const folder = record(value, 'folder')
    onlyKeys(folder, ['id', 'name', 'createdAt', 'updatedAt'], 'folder')
    const name = boundedString(folder.name, MAX_FOLDER_NAME_LENGTH, 'folder name', false)
    if (name !== name.trim()) invalid('Folder names must be trimmed')
    return { id: validateId(folder.id), name, createdAt: date(folder.createdAt), updatedAt: date(folder.updatedAt) }
  })
  const folderIds = new Set(folders.map(folder => folder.id))
  if (folderIds.size !== folders.length) invalid('Duplicate folder ids')
  const notes: Note[] = data.notes.map(value => {
    const note = record(value, 'note')
    onlyKeys(note, NOTE_KEYS, 'note')
    const content = validateRichDoc(note.content)
    const text = boundedString(note.text, MAX_TEXT_LENGTH, 'derived text')
    if (text !== validatedDocText(content)) invalid('Derived text does not match the document')
    if (!Number.isSafeInteger(note.revision) || (note.revision as number) < 1) invalid('Invalid revision')
    const folderId = note.folderId === null ? null : validateId(note.folderId)
    if (folderId !== null && !folderIds.has(folderId)) invalid('A note references a missing folder')
    const createdAt = date(note.createdAt)
    const updatedAt = date(note.updatedAt)
    const deletedAt = note.deletedAt === null ? null : date(note.deletedAt)
    if (updatedAt < createdAt || (deletedAt !== null && deletedAt > updatedAt)) invalid('Inconsistent note timestamps')
    return {
      id: validateId(note.id), title: boundedString(note.title, MAX_TITLE_LENGTH, 'title'),
      content, text, folderId, pinned: boolean(note.pinned, 'pinned'), revision: note.revision as number,
      createdAt, updatedAt, deletedAt,
    }
  })
  if (new Set(notes.map(note => note.id)).size !== notes.length) invalid('Duplicate note ids')
  return { version: 1, notes, folders, agentEnabled: boolean(data.agentEnabled, 'agentEnabled') }
}

export interface StoreOptions { directory: string; lockTimeoutMs?: number }
/** Optional adapter validation that runs under the same lock as note writes and purges. */
export type ContentVerifier = (content: RichDoc) => Promise<void>

/**
 * A lockfile serializes reads and writes across store instances and processes.
 * Every operation reloads the latest state while holding that lock, including permission checks.
 * Locks left by a killed process time out visibly; they are never stolen from an active writer.
 * Cached state is keyed by saved bytes and cloned before mutations, so failed
 * writes cannot advance the cached version.
 */
export class JotStore {
  readonly directory: string
  readonly statePath: string
  readonly backupPath: string
  readonly lockPath: string
  private readonly lockTimeoutMs: number
  readonly activityPath: string
  /**
   * Parsed state keyed by the exact bytes on disk. A different file, from any
   * process, misses the cache, so it can never serve state that is not saved.
   * Read-only operations receive the cached object and must not mutate it.
   */
  private cache: { source: string; state: JotState; tag: string } | null = null

  constructor(options: StoreOptions) {
    const input = record(options, 'store options')
    onlyKeys(input, ['directory', 'lockTimeoutMs'], 'store options')
    this.directory = resolve(boundedString(input.directory, 4_096, 'directory', false))
    this.statePath = join(this.directory, STATE_FILENAME)
    this.backupPath = join(this.directory, BACKUP_FILENAME)
    this.lockPath = join(this.directory, LOCK_FILENAME)
    this.activityPath = join(this.directory, ACTIVITY_FILENAME)
    this.lockTimeoutMs = input.lockTimeoutMs === undefined ? 5_000 : input.lockTimeoutMs as number
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1 || this.lockTimeoutMs > 60_000) invalid('Invalid lock timeout')
  }

  private async lock(): Promise<() => Promise<void>> {
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }) }
    catch (cause) { throw new StoreError('PERSISTENCE_ERROR', 'Cannot create the notes directory', { cause }) }
    return acquireFileLock({
      path: this.lockPath, timeoutMs: this.lockTimeoutMs,
      initialize: async file => { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: timestamp() })) },
      persistenceError: cause => new StoreError('PERSISTENCE_ERROR', 'Cannot acquire the notes lock', { cause }),
      timeoutError: () => new StoreError('LOCK_TIMEOUT', 'Notes are locked by another operation; inspect .jot.lock if its process has stopped'),
    })
  }

  private async load(readOnly = false): Promise<{ state: JotState; previous: string | null; tag: string }> {
    let source: string
    try {
      const info = await stat(this.statePath)
      if (info.size > MAX_STATE_BYTES) throw new StoreError('CORRUPT_STATE', 'The notes state exceeds its size limit')
      source = await readFile(this.statePath, 'utf8')
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) {
        try { await stat(this.backupPath) }
        catch (backupError) {
          if (isErrno(backupError, 'ENOENT')) return { state: emptyState(), previous: null, tag: 'empty' }
          throw new StoreError('PERSISTENCE_ERROR', 'Cannot inspect the notes backup', { cause: backupError })
        }
        throw new StoreError('CORRUPT_STATE', 'The main notes file is missing but a backup exists; restore it explicitly before continuing')
      }
      if (cause instanceof StoreError) throw cause
      throw new StoreError('PERSISTENCE_ERROR', 'Cannot read the notes state', { cause })
    }
    const cached = this.cache
    if (cached?.source === source) return { state: readOnly ? cached.state : structuredClone(cached.state), previous: source, tag: cached.tag }
    let state: JotState
    try { state = validateState(JSON.parse(source)) }
    catch (cause) {
      throw new StoreError('CORRUPT_STATE', 'The notes state is invalid; the original and its backup were preserved', { cause })
    }
    const tag = contentTag(source)
    this.cache = { source, state: readOnly ? state : structuredClone(state), tag }
    return { state, previous: source, tag }
  }

  private async writeSynced(path: string, contents: string): Promise<void> {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(contents, 'utf8'); await file.sync() }
    finally { await file.close() }
  }

  private async persist(state: JotState, previous: string | null): Promise<void> {
    const validated = validateState(state)
    const serialized = JSON.stringify(validated) + '\n'
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) invalid('Notes storage has reached its size limit')
    const suffix = `${process.pid}-${randomUUID()}`
    const temporary = join(this.directory, `.jot-${suffix}.tmp`)
    const backupTemporary = join(this.directory, `.jot-${suffix}.bak.tmp`)
    try {
      await this.writeSynced(temporary, serialized)
      if (previous !== null) {
        await this.writeSynced(backupTemporary, previous)
        await rename(backupTemporary, this.backupPath)
      }
      await rename(temporary, this.statePath)
      this.cache = { source: serialized, state: validated, tag: contentTag(serialized) }
    } catch (cause) {
      throw new StoreError('PERSISTENCE_ERROR', 'Could not save notes; the previous state remains active', { cause })
    } finally {
      await Promise.all([rm(temporary, { force: true }), rm(backupTemporary, { force: true })])
    }
  }

  private async access<T>(actor: Actor, mutate: boolean, operation: (state: JotState) => T | Promise<T>, hooks: {
    /** The version an agent edit replaced, captured by the operation. */
    undo?: () => AgentUndoBefore | undefined
    /** Sidecar cleanup that must follow a successful save while the lock is still held. */
    saved?: () => Promise<void>
  } = {}): Promise<T> {
    validateActor(actor)
    const unlock = await this.lock()
    try {
      const { state, previous } = await this.load(!mutate)
      if (actor === 'agent' && !state.agentEnabled) throw new StoreError('AGENT_DISABLED', 'Jot AI collaboration is off. Ask the user to turn on “Allow AI collaboration” at the bottom of the Jot note list, then retry.')
      // Compare the saved human revisions, including operations such as deleting
      // a folder that can change several notes without returning one note.
      const previousRevisions = actor === 'user' && mutate ? new Map(state.notes.map(note => [note.id, note.revision])) : undefined
      const result = await operation(state)
      if (mutate) {
        await this.persist(state, previous)
        if (actor === 'agent') await this.recordAgentEdit(result, state, hooks.undo?.())
        if (previousRevisions) {
          const revisions = new Map(state.notes.map(note => [note.id, note.revision]))
          await Promise.all([...previousRevisions].filter(([id, revision]) => revisions.get(id) !== revision)
            .map(([id]) => rm(this.undoPath(id), { force: true }).catch(() => {})))
        }
        await hooks.saved?.().catch(() => {})
      }
      return structuredClone(result)
    } finally { await unlock() }
  }

  private async readActivity(): Promise<{ edits: Record<string, AgentEdit>; tag: string }> {
    let source: string
    try {
      const info = await stat(this.activityPath)
      if (!info.isFile() || info.size > MAX_ACTIVITY_BYTES) return { edits: {}, tag: 'none' }
      source = await readFile(this.activityPath, 'utf8')
    } catch { return { edits: {}, tag: 'none' } }
    const edits: Record<string, AgentEdit> = {}
    try {
      const parsed = JSON.parse(source) as { version?: unknown; notes?: unknown }
      if (parsed?.version === 1 && parsed.notes && typeof parsed.notes === 'object' && !Array.isArray(parsed.notes)) {
        for (const [id, value] of Object.entries(parsed.notes as Record<string, unknown>)) {
          const entry = value as Partial<AgentEdit> | null
          if (/^[a-zA-Z0-9_-]{1,100}$/u.test(id) && Number.isSafeInteger(entry?.revision) && typeof entry?.at === 'string') {
            edits[id] = { revision: entry.revision!, at: entry.at, ...entry.undo === true ? { undo: true } : {} }
          }
        }
      }
    } catch { /* Attribution is optional; a damaged sidecar is ignored. */ }
    return { edits, tag: contentTag(source) }
  }

  /** Best effort and never fails the saved agent operation. Entries for later human revisions are pruned. */
  private async recordAgentEdit(result: unknown, state: JotState, before?: AgentUndoBefore): Promise<void> {
    const changed = result as Partial<Note> | null
    if (!changed || typeof changed.id !== 'string' || typeof changed.revision !== 'number') return
    try {
      const { edits } = await this.readActivity()
      const revisions = new Map(state.notes.map(note => [note.id, note.revision]))
      const notes: Record<string, AgentEdit> = {}
      const stale: string[] = []
      for (const [id, entry] of Object.entries(edits)) {
        if (revisions.get(id) === entry.revision) notes[id] = entry
        else if (entry.undo && id !== changed.id) stale.push(id)
      }
      const undo = before ? await this.recordAgentUndo(changed.id, changed.revision, before) : false
      if (!before) await rm(this.undoPath(changed.id), { force: true }).catch(() => {})
      notes[changed.id] = { revision: changed.revision, at: timestamp(), ...undo ? { undo: true } : {} }
      const temporary = join(this.directory, `.jot-activity-${process.pid}-${randomUUID()}.tmp`)
      try {
        await this.writeSynced(temporary, JSON.stringify({ version: 1, notes }) + '\n')
        await rename(temporary, this.activityPath)
      } finally { await rm(temporary, { force: true }) }
      // A human revision ended those runs; their kept versions are no longer offered.
      await Promise.all(stale.map(id => rm(this.undoPath(id), { force: true }).catch(() => {})))
    } catch { /* The note itself is already saved. */ }
  }

  private undoPath(id: string): string { return join(this.directory, AGENT_UNDO_DIRECTORY, `${validateId(id)}.json`) }

  private async readUndo(id: string): Promise<AgentUndo | null> {
    let source: string
    try {
      const info = await stat(this.undoPath(id))
      if (!info.isFile() || info.size > MAX_UNDO_BYTES) return null
      source = await readFile(this.undoPath(id), 'utf8')
    } catch { return null }
    try {
      const data = record(JSON.parse(source), 'agent undo')
      const before = record(data.before, 'agent undo version')
      if (data.version !== 1 || data.noteId !== id || !Number.isSafeInteger(data.revision) || typeof data.at !== 'string'
        || !Number.isSafeInteger(before.revision)) return null
      return { version: 1, noteId: id, revision: data.revision as number, at: data.at, before: {
        revision: before.revision as number, title: boundedString(before.title, MAX_TITLE_LENGTH, 'title'),
        content: validateRichDoc(before.content), folderId: before.folderId === null ? null : validateId(before.folderId),
      } }
    } catch { return null }
  }

  /**
   * Keep the version from before an uninterrupted run of agent edits: a later
   * agent edit of the same note extends the run instead of replacing its start.
   */
  private async recordAgentUndo(id: string, revision: number, before: AgentUndoBefore): Promise<boolean> {
    try {
      const existing = await this.readUndo(id)
      const start = existing && existing.revision === before.revision ? existing.before : before
      const serialized = JSON.stringify({ version: 1, noteId: id, revision, at: timestamp(), before: start } satisfies AgentUndo) + '\n'
      if (Buffer.byteLength(serialized, 'utf8') > MAX_UNDO_BYTES) {
        await rm(this.undoPath(id), { force: true })
        return false
      }
      await mkdir(join(this.directory, AGENT_UNDO_DIRECTORY), { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, AGENT_UNDO_DIRECTORY, `.undo-${process.pid}-${randomUUID()}.tmp`)
      try {
        await this.writeSynced(temporary, serialized)
        await rename(temporary, this.undoPath(id))
      } finally { await rm(temporary, { force: true }) }
      return true
    } catch { return false }
  }

  private note(state: JotState, id: string, actor: Actor, activeOnly = false): Note {
    validateId(id)
    const note = state.notes.find(item => item.id === id)
    if (!note || (note.deletedAt !== null && (actor === 'agent' || activeOnly))) throw new StoreError('NOT_FOUND', 'Note not found')
    return note
  }
  private checkRevision(note: Note, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) invalid('An expected revision is required')
    if (note.revision !== revision) throw new StoreError('REVISION_CONFLICT', `Note changed; expected revision ${revision}, current revision ${note.revision}`)
  }
  private folder(state: JotState, id: string): Folder {
    validateId(id)
    const folder = state.folders.find(item => item.id === id)
    if (!folder) throw new StoreError('NOT_FOUND', 'Folder not found')
    return folder
  }
  private folderId(state: JotState, value: unknown): string | null {
    if (value === null) return null
    const id = validateId(value)
    this.folder(state, id)
    return id
  }

  async readState(actor: Actor = 'user'): Promise<JotState> {
    return this.access(actor, false, state => ({ ...state,
      notes: state.notes.filter(note => actor === 'user' || note.deletedAt === null).sort(compareNotes),
    }))
  }
  /**
   * The user's library view with a content tag. When the tag equals `ifNoneMatch`,
   * the notes are not copied or returned, allowing an HTTP 304.
   */
  async readSnapshot(ifNoneMatch?: string): Promise<{ tag: string; snapshot?: JotSnapshot }> {
    const unlock = await this.lock()
    try {
      const { state, tag } = await this.load(true)
      const activity = await this.readActivity()
      const combined = `"${tag}.${activity.tag}"`
      if (ifNoneMatch !== undefined && ifNoneMatch === combined) return { tag: combined }
      const agentEdits: Record<string, AgentEdit> = {}
      for (const note of state.notes) {
        const edit = activity.edits[note.id]
        if (edit && edit.revision === note.revision) agentEdits[note.id] = edit
      }
      return { tag: combined, snapshot: structuredClone({ ...state, notes: [...state.notes].sort(compareNotes), agentEdits }) }
    } finally { await unlock() }
  }
  async getNote(id: string, actor: Actor = 'user'): Promise<Note> {
    return this.access(actor, false, state => this.note(state, id, actor))
  }
  async search(query: string, folderId?: string | null, actor: Actor = 'user'): Promise<Note[]> {
    return this.access(actor, false, state => {
      const needle = boundedString(query, 512, 'query').trim().toLocaleLowerCase()
      if (folderId !== undefined && folderId !== null) validateId(folderId)
      return state.notes.filter(note => note.deletedAt === null && (folderId === undefined || note.folderId === folderId) &&
        (needle === '' || note.title.toLocaleLowerCase().includes(needle) || note.text.toLocaleLowerCase().includes(needle)))
        .sort((a, b) => Number(b.title.toLocaleLowerCase().includes(needle)) - Number(a.title.toLocaleLowerCase().includes(needle)) || compareNotes(a, b))
    })
  }
  async createNote(input: CreateNoteInput, actor: Actor = 'user', verify?: ContentVerifier): Promise<Note> {
    return this.access(actor, true, async state => {
      const data = record(input, 'new note')
      onlyKeys(data, ['title', 'content', 'folderId', 'pinned'], 'new note')
      const content = data.content === undefined ? docFromText('') : validateRichDoc(data.content)
      await verify?.(content)
      const now = timestamp()
      const note: Note = { id: randomUUID(), title: data.title === undefined ? '' : boundedString(data.title, MAX_TITLE_LENGTH, 'title'),
        content, text: validatedDocText(content), folderId: data.folderId === undefined ? null : this.folderId(state, data.folderId),
        pinned: data.pinned === undefined ? false : boolean(data.pinned, 'pinned'), revision: 1,
        createdAt: now, updatedAt: now, deletedAt: null }
      state.notes.push(note)
      return note
    })
  }
  /**
   * Create imported notes, and the named folders they need, in one locked write.
   * Folder names reuse existing folders case-insensitively. Only the user imports.
   * Notes keep their import order in the list: earlier notes get later timestamps.
   */
  async importNotes(input: ImportNotesInput, verify?: ContentVerifier): Promise<ImportNotesResult> {
    return this.access('user', true, async state => {
      const data = record(input, 'import')
      onlyKeys(data, ['folders', 'notes'], 'import')
      if (!Array.isArray(data.folders) || data.folders.length > MAX_FOLDERS || !Array.isArray(data.notes) || data.notes.length === 0) {
        invalid('An import needs notes and a list of folder names')
      }
      if (state.notes.length + data.notes.length > MAX_NOTES) {
        invalid(`Jot holds at most ${MAX_NOTES.toLocaleString('en')} notes, including Trash; the library has ${state.notes.length} and the import has ${data.notes.length}`)
      }
      const key = (value: unknown) => boundedString(value, MAX_FOLDER_NAME_LENGTH, 'folder name', false).trim().toLocaleLowerCase()
      const byName = new Map(state.folders.map(folder => [folder.name.toLocaleLowerCase(), folder.id]))
      const base = Date.now()
      let created = 0
      for (const value of data.folders) {
        const name = boundedString(value, MAX_FOLDER_NAME_LENGTH, 'folder name', false).trim()
        if (byName.has(name.toLocaleLowerCase())) continue
        if (state.folders.length >= MAX_FOLDERS) invalid(`Jot holds at most ${MAX_FOLDERS} folders`)
        const now = new Date(base).toISOString()
        const folder: Folder = { id: randomUUID(), name, createdAt: now, updatedAt: now }
        state.folders.push(folder)
        byName.set(name.toLocaleLowerCase(), folder.id)
        created++
      }
      const noteIds: string[] = []
      for (const [index, value] of (data.notes as unknown[]).entries()) {
        const item = record(value, 'imported note')
        onlyKeys(item, ['title', 'content', 'folderName', 'folderId'], 'imported note')
        const title = boundedString(item.title, MAX_TITLE_LENGTH, 'title')
        const content = validateRichDoc(item.content)
        await verify?.(content)
        let folderId: string | null = null
        if (item.folderName != null) {
          if (item.folderId != null) invalid('An imported note needs a folder name or a folder id, not both')
          folderId = byName.get(key(item.folderName)) ?? invalid('An imported note names a folder that is not part of the import')
        } else if (item.folderId != null) folderId = this.folderId(state, item.folderId)
        const now = new Date(base - index).toISOString()
        const note: Note = { id: randomUUID(), title, content, text: validatedDocText(content), folderId, pinned: false,
          revision: 1, createdAt: now, updatedAt: now, deletedAt: null }
        state.notes.push(note)
        noteIds.push(note.id)
      }
      return { noteIds, folders: created }
    })
  }
  async updateNote(id: string, revision: number, patch: UpdateNotePatch, actor: Actor = 'user', verify?: ContentVerifier): Promise<Note> {
    let before: AgentUndoBefore | undefined
    return this.access(actor, true, async state => {
      const note = this.note(state, id, actor, true)
      this.checkRevision(note, revision)
      if (actor === 'agent') before = { revision: note.revision, title: note.title, content: structuredClone(note.content), folderId: note.folderId }
      const data = record(patch, 'note patch')
      onlyKeys(data, ['title', 'content', 'appendText', 'appendContent', 'folderId', 'pinned'], 'note patch')
      if (Object.keys(data).length === 0) invalid('Note patch must change at least one field')
      if ([data.content, data.appendText, data.appendContent].filter(value => value !== undefined).length > 1) {
        invalid('Choose one of document replacement, appendText or appendContent')
      }
      if (data.title !== undefined) note.title = boundedString(data.title, MAX_TITLE_LENGTH, 'title')
      if (data.content !== undefined) note.content = validateRichDoc(data.content)
      if (data.appendText !== undefined) {
        const text = boundedString(data.appendText, MAX_TEXT_LENGTH, 'appendText', false)
        note.content = validateRichDoc({ type: 'doc', content: [...note.content.content, ...docFromText(text).content] })
      }
      if (data.appendContent !== undefined) {
        const added = validateRichDoc(data.appendContent)
        note.content = validateRichDoc({ type: 'doc', content: appendBlocks(note.content.content, added.content) })
      }
      if (data.folderId !== undefined) note.folderId = this.folderId(state, data.folderId)
      if (data.pinned !== undefined) note.pinned = boolean(data.pinned, 'pinned')
      await verify?.(note.content)
      note.text = validatedDocText(note.content)
      note.revision++
      note.updatedAt = timestamp(note.updatedAt)
      return note
    }, { undo: () => before })
  }
  /**
   * Restore the version from before the latest run of agent edits, as a new
   * human revision. Only the user can do this, and only while the agent's
   * version is still the current one.
   */
  async revertAgentEdit(id: string, revision: number, actor: Actor = 'user', verify?: ContentVerifier): Promise<Note> {
    validateActor(actor)
    if (actor !== 'user') throw new StoreError('HUMAN_ONLY', 'Only the user can undo an agent edit')
    return this.access(actor, true, async state => {
      const note = this.note(state, id, 'user', true)
      this.checkRevision(note, revision)
      const undo = await this.readUndo(id)
      const { edits } = await this.readActivity()
      if (!undo || undo.revision !== note.revision || edits[id]?.revision !== note.revision) {
        throw new StoreError('NOT_FOUND', 'There is no agent edit to undo for this version')
      }
      note.title = undo.before.title
      note.content = undo.before.content
      // A folder deleted since the agent moved the note leaves it unfiled.
      note.folderId = undo.before.folderId !== null && state.folders.some(folder => folder.id === undo.before.folderId) ? undo.before.folderId : null
      await verify?.(note.content)
      note.text = validatedDocText(note.content)
      note.revision++
      note.updatedAt = timestamp(note.updatedAt)
      return note
    }, { saved: () => rm(this.undoPath(id), { force: true }) })
  }
  async deleteNote(id: string, revision: number, actor: Actor = 'user'): Promise<NoteSummary> {
    return this.access(actor, true, state => {
      const note = this.note(state, id, actor, true)
      this.checkRevision(note, revision)
      note.updatedAt = timestamp(note.updatedAt)
      note.deletedAt = note.updatedAt
      note.revision++
      return summary(note)
    })
  }
  async restoreNote(id: string, revision: number, actor: Actor = 'user'): Promise<Note> {
    return this.access(actor, true, state => {
      // Agents may restore by id/revision, but never read the deleted body beforehand.
      const note = this.note(state, id, 'user')
      this.checkRevision(note, revision)
      if (note.deletedAt === null) invalid('Note is not deleted')
      note.deletedAt = null
      note.updatedAt = timestamp(note.updatedAt)
      note.revision++
      return note
    })
  }
  /**
   * Permanently remove notes; only the user can do this. Explicit targets need
   * their exact revisions; `'trash'` removes everything already in Trash.
   * Attachments referenced only by the removed notes are handed to `release`
   * while the notes lock is still held, so no concurrent save can adopt them.
   */
  async purgeNotes(targets: ReadonlyArray<{ id: string; revision: number }> | 'trash', actor: Actor = 'user',
    release?: (attachmentIds: string[]) => Promise<void>): Promise<PurgeResult> {
    validateActor(actor)
    if (actor !== 'user') throw new StoreError('HUMAN_ONLY', 'Only the user can permanently delete notes')
    if (targets !== 'trash' && (!Array.isArray(targets) || targets.length === 0 || targets.length > 10_000)) invalid('Choose notes to delete permanently')
    const unlock = await this.lock()
    try {
      const { state, previous } = await this.load()
      const removed = targets === 'trash' ? state.notes.filter(note => note.deletedAt !== null) : targets.map(target => {
        const data = record(target, 'purge target')
        onlyKeys(data, ['id', 'revision'], 'purge target')
        const note = this.note(state, data.id as string, 'user')
        this.checkRevision(note, data.revision as number)
        return note
      })
      if (!removed.length) return { purged: [], attachments: [] }
      const ids = new Set(removed.map(note => note.id))
      state.notes = state.notes.filter(note => !ids.has(note.id))
      const kept = new Set(state.notes.flatMap(note => [...documentAttachmentIds(note.content)]))
      // An active AI undo is another live reference. Deleting a different note
      // must not delete a file needed to restore the user's pre-AI version.
      const { edits } = await this.readActivity()
      for (const note of state.notes) if (note.deletedAt === null && edits[note.id]?.revision === note.revision) {
        const undo = await this.readUndo(note.id)
        if (undo?.revision === note.revision) for (const id of documentAttachmentIds(undo.before.content)) kept.add(id)
      }
      const orphaned = [...new Set(removed.flatMap(note => [...documentAttachmentIds(note.content)]))].filter(id => !kept.has(id))
      await this.persist(state, previous)
      await Promise.all([...ids].map(id => rm(this.undoPath(id), { force: true }).catch(() => {})))
      let attachments: string[] = []
      if (orphaned.length && release) {
        try { await release(orphaned); attachments = orphaned }
        catch { /* Notes are gone; unreleased files remain managed and harmless. */ }
      }
      return { purged: [...ids], attachments }
    } finally { await unlock() }
  }
  async createFolder(name: string, actor: Actor = 'user'): Promise<Folder> {
    return this.access(actor, true, state => {
      const clean = boundedString(name, MAX_FOLDER_NAME_LENGTH, 'folder name', false).trim()
      if (state.folders.some(folder => folder.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) invalid('Folder name already exists')
      const now = timestamp()
      const folder: Folder = { id: randomUUID(), name: clean, createdAt: now, updatedAt: now }
      state.folders.push(folder)
      return folder
    })
  }
  async renameFolder(id: string, name: string, actor: Actor = 'user'): Promise<Folder> {
    return this.access(actor, true, state => {
      const folder = this.folder(state, id)
      const clean = boundedString(name, MAX_FOLDER_NAME_LENGTH, 'folder name', false).trim()
      if (state.folders.some(item => item.id !== id && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) invalid('Folder name already exists')
      folder.name = clean
      folder.updatedAt = timestamp(folder.updatedAt)
      return folder
    })
  }
  async deleteFolder(id: string, actor: Actor = 'user'): Promise<void> {
    return this.access(actor, true, state => {
      this.folder(state, id)
      state.folders = state.folders.filter(folder => folder.id !== id)
      for (const note of state.notes) if (note.folderId === id) {
        note.folderId = null
        note.updatedAt = timestamp(note.updatedAt)
        note.revision++
      }
    })
  }
  async setAgentEnabled(enabled: boolean, actor: Actor = 'user'): Promise<void> {
    validateActor(actor)
    if (actor !== 'user') throw new StoreError('HUMAN_ONLY', 'Only the user can change agent access')
    return this.access(actor, true, state => { state.agentEnabled = boolean(enabled, 'agentEnabled') })
  }
}
