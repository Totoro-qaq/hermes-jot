import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acquireFileLock } from './file-lock.js'

export const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1_048_576
export const DEFAULT_ATTACHMENT_TOTAL_BYTES = 500 * 1_048_576
export const DEFAULT_ATTACHMENT_MAX_COUNT = 1_000
export const MAX_ATTACHMENT_FILENAME_BYTES = 512
export const ATTACHMENT_MANIFEST = 'manifest.json'
const MAX_MANIFEST_BYTES = 2 * 1_048_576
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_PIXELS = 40_000_000
const MAX_IMAGE_DIMENSION = 10_000
const MAX_PREVIEW_FILENAME_BYTES = 240

export interface AttachmentInfo {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: string
  kind: 'image' | 'pdf' | 'file'
  url: string
  downloadUrl: string
}
interface AttachmentMetadata extends Omit<AttachmentInfo, 'url' | 'downloadUrl'> { sha256: string }
interface Manifest { version: 1; attachments: AttachmentMetadata[] }
export interface AttachmentOptions {
  /** The Jot data directory. The managed attachment subdirectory is always added here. */
  directory: string
  maxFileBytes?: number
  maxTotalBytes?: number
  maxAttachments?: number
  lockTimeoutMs?: number
}

export class AttachmentError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AttachmentError'
  }
}
function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
function invalid(message: string): never { throw new AttachmentError('INVALID_ATTACHMENT', message, 400) }
function corrupt(message = 'The attachment index is invalid; its original data was preserved.'): never {
  throw new AttachmentError('CORRUPT_ATTACHMENTS', message, 500)
}
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) invalid(`Invalid ${label}.`)
  return result
}
export function validateAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/u.test(value)) invalid('Invalid attachment identifier.')
  return value
}
export function attachmentUrl(id: string, download = false): string {
  validateAttachmentId(id)
  return `/jot/api/attachments/${id}/content${download ? '?download=1' : ''}`
}
export function validateAttachmentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200
    || Buffer.byteLength(value, 'utf8') > MAX_ATTACHMENT_FILENAME_BYTES
    || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(value)
    || value === '.' || value === '..') invalid('Use a plain file name of at most 200 characters.')
  try { encodeURIComponent(value) } catch { invalid('The attachment name contains invalid text.') }
  return value
}
/** Native preview copies need a portable basename without changing the stored upload name. */
function previewFilename(name: string): string {
  let safe = name.replace(/[<>:"|?*]/gu, '_').trim().replace(/[. ]+$/u, '') || 'attachment'
  const deviceStem = safe.split('.')[0]!.trimEnd()
  if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/iu.test(deviceStem)) safe = `_${safe}`
  if (Buffer.byteLength(safe, 'utf8') <= MAX_PREVIEW_FILENAME_BYTES) return safe
  const cut = (value: string, maximum: number): string => {
    let result = '', size = 0
    for (const character of value) {
      size += Buffer.byteLength(character, 'utf8')
      if (size > maximum) break
      result += character
    }
    return result
  }
  const dot = safe.lastIndexOf('.')
  const extension = dot > 0 ? safe.slice(dot) : ''
  // Keep normal extensions intact even when the human-readable stem is long.
  if (Buffer.byteLength(extension, 'utf8') < MAX_PREVIEW_FILENAME_BYTES) {
    return (cut(dot > 0 ? safe.slice(0, dot) : safe, MAX_PREVIEW_FILENAME_BYTES - Buffer.byteLength(extension, 'utf8')) + extension).replace(/[. ]+$/u, '')
  }
  return cut(safe, MAX_PREVIEW_FILENAME_BYTES).replace(/[. ]+$/u, '')
}
function declaredMime(value: unknown): string {
  if (value === undefined || value === '') return 'application/octet-stream'
  if (typeof value !== 'string' || value.length > 128) invalid('Invalid attachment media type.')
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(normalized)) invalid('Invalid attachment media type.')
  return normalized
}

function imageDimensions(data: Buffer, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === 'image/png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  if (mimeType === 'image/gif' && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  if (mimeType === 'image/webp') {
    const chunk = data.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && data.length >= 30) return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 47) {
      const packed = data.readUInt32LE(21)
      return { width: (packed & 16383) + 1, height: (packed >>> 14 & 16383) + 1 }
    }
    if (chunk === 'VP8 ' && data.length >= 30 && data.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      return { width: data.readUInt16LE(26) & 16383, height: data.readUInt16LE(28) & 16383 }
    }
  }
  if (mimeType === 'image/jpeg') {
    let position = 2
    while (position + 4 <= data.length) {
      if (data[position] !== 255) break
      while (position < data.length && data[position] === 255) position++
      const marker = data[position++]
      if (marker === undefined || marker === 217 || marker === 218) break
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (position + 2 > data.length) break
      const length = data.readUInt16BE(position)
      if (length < 2 || position + length > data.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        return { width: data.readUInt16BE(position + 5), height: data.readUInt16BE(position + 3) }
      }
      position += length
    }
  }
  return undefined
}

/** Inline eligibility is based on byte signatures, never the upload's claimed type. */
export function attachmentMedia(bytes: Uint8Array, claimedType?: string): Pick<AttachmentMetadata, 'mimeType' | 'kind'> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const declared = declaredMime(claimedType)
  let detected: string | undefined
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) detected = 'image/png'
  else if (data.length >= 5 && data[0] === 255 && data[1] === 216 && data[2] === 255
    && data[data.length - 2] === 255 && data[data.length - 1] === 217) detected = 'image/jpeg'
  else if (data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
    && data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0) detected = 'image/gif'
  else if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) detected = 'image/webp'
  else if (data.length >= 8 && /^%PDF-[12]\.\d/u.test(data.toString('ascii', 0, 8))) detected = 'application/pdf'
  if (detected === 'application/pdf') return { mimeType: detected, kind: 'pdf' }
  if (detected) {
    const dimensions = imageDimensions(data, detected)
    if (dimensions && dimensions.width > 0 && dimensions.height > 0 && dimensions.width <= MAX_IMAGE_DIMENSION
      && dimensions.height <= MAX_IMAGE_DIMENSION && dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS) {
      return { mimeType: detected, kind: 'image' }
    }
    return { mimeType: 'application/octet-stream', kind: 'file' }
  }
  // Unverified image/PDF claims, including SVG, are ordinary downloadable files.
  return { mimeType: declared.startsWith('image/') || declared === 'application/pdf' ? 'application/octet-stream' : declared, kind: 'file' }
}

function info(metadata: AttachmentMetadata): AttachmentInfo {
  const { sha256: _hash, ...fields } = metadata
  return { ...fields, url: attachmentUrl(metadata.id), downloadUrl: attachmentUrl(metadata.id, true) }
}
function metadata(value: unknown): AttachmentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) corrupt()
  const item = value as Record<string, unknown>
  const keys = ['id', 'name', 'mimeType', 'size', 'createdAt', 'kind', 'sha256']
  if (Object.keys(item).some(key => !keys.includes(key))) corrupt()
  let id: string, name: string, mimeType: string
  try { id = validateAttachmentId(item.id); name = validateAttachmentName(item.name); mimeType = declaredMime(item.mimeType) }
  catch { corrupt() }
  if (!Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > 1_073_741_824
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || new Date(item.createdAt).toISOString() !== item.createdAt
    || !['image', 'pdf', 'file'].includes(String(item.kind))) corrupt()
  if (item.kind === 'image' && !INLINE_IMAGES.has(mimeType) || item.kind === 'pdf' && mimeType !== 'application/pdf') corrupt()
  return { id, name, mimeType, size: item.size as number, createdAt: item.createdAt, kind: item.kind as AttachmentMetadata['kind'], sha256: item.sha256 }
}

/** Immutable blobs plus an atomic managed manifest; request paths never become file paths. */
export class AttachmentStore {
  readonly directory: string
  readonly manifestPath: string
  readonly lockPath: string
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxAttachments: number
  private readonly lockTimeoutMs: number

  constructor(options: AttachmentOptions) {
    if (!options || typeof options.directory !== 'string' || !options.directory || options.directory.length > 4096) invalid('Invalid attachment directory.')
    this.directory = join(resolve(options.directory), 'attachments')
    this.manifestPath = join(this.directory, ATTACHMENT_MANIFEST)
    this.lockPath = join(this.directory, '.attachments.lock')
    this.maxFileBytes = limit(options.maxFileBytes, DEFAULT_ATTACHMENT_MAX_BYTES, 1_073_741_824, 'attachment size limit')
    this.maxTotalBytes = limit(options.maxTotalBytes, DEFAULT_ATTACHMENT_TOTAL_BYTES, 10_737_418_240, 'attachment storage limit')
    this.maxAttachments = limit(options.maxAttachments, DEFAULT_ATTACHMENT_MAX_COUNT, 10_000, 'attachment count limit')
    this.lockTimeoutMs = limit(options.lockTimeoutMs, 5_000, 60_000, 'attachment lock timeout')
  }

  private async checkDirectory(): Promise<void> {
    try {
      const entry = await lstat(this.directory)
      if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt('The managed attachment directory is not a plain directory.')
    } catch (cause) { if (!errno(cause, 'ENOENT')) throw cause }
  }
  private async readManaged(path: string, maximum: number): Promise<Buffer> {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) corrupt('The attachment data is not a valid managed file.')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const entry = await file.stat()
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > maximum || entry.ino !== before.ino || entry.dev !== before.dev) corrupt('The attachment data is not a valid managed file.')
      const chunks: Buffer[] = []
      const chunk = Buffer.alloc(Math.min(65_536, maximum + 1))
      let size = 0
      while (true) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
        if (!bytesRead) break
        size += bytesRead
        if (size > maximum) corrupt('The attachment data exceeds its managed size limit.')
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      }
      return Buffer.concat(chunks, size)
    } finally { await file.close() }
  }
  private async load(): Promise<Manifest> {
    await this.checkDirectory()
    let bytes: Buffer
    try { bytes = await this.readManaged(this.manifestPath, MAX_MANIFEST_BYTES) }
    catch (cause) {
      if (errno(cause, 'ENOENT')) {
        let entries: string[] = []
        try { entries = await readdir(this.directory) } catch (error) { if (!errno(error, 'ENOENT')) throw error }
        if (entries.some(name => /^[a-f0-9]{32}\.blob$/u.test(name))) corrupt('The attachment index is missing while managed files remain.')
        return { version: 1, attachments: [] }
      }
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('CORRUPT_ATTACHMENTS', 'Cannot read the managed attachment index.', 500, { cause })
    }
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
      if (parsed.version !== 1 || !Array.isArray(parsed.attachments) || Object.keys(parsed).some(key => !['version', 'attachments'].includes(key))) corrupt()
      const attachments = parsed.attachments.map(metadata)
      if (attachments.length > 10_000 || new Set(attachments.map(item => item.id)).size !== attachments.length) corrupt()
      return { version: 1, attachments }
    } catch (cause) {
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('CORRUPT_ATTACHMENTS', 'The attachment index is invalid; its original data was preserved.', 500, { cause })
    }
  }
  private async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await this.checkDirectory()
    return acquireFileLock({
      path: this.lockPath, timeoutMs: this.lockTimeoutMs,
      initialize: async file => { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await file.sync() },
      persistenceError: cause => new AttachmentError('ATTACHMENT_PERSISTENCE', 'Cannot lock attachment storage.', 500, { cause }),
      timeoutError: () => new AttachmentError('ATTACHMENT_LOCKED', 'Attachment storage is busy.', 503),
    })
  }
  private async writeSynced(path: string, bytes: Uint8Array): Promise<void> {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  }

  private async previewLock(): Promise<() => Promise<void>> {
    await this.checkDirectory()
    const path = join(this.directory, '.preview.lock')
    try {
      const existing = await lstat(path)
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) corrupt('The attachment preview lock is not a plain managed file.')
    } catch (cause) { if (!errno(cause, 'ENOENT')) throw cause }
    return acquireFileLock({
      path, timeoutMs: this.lockTimeoutMs,
      initialize: async file => { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await file.sync() },
      persistenceError: cause => new AttachmentError('ATTACHMENT_PERSISTENCE', 'Cannot lock attachment previews.', 500, { cause }),
      timeoutError: () => new AttachmentError('ATTACHMENT_LOCKED', 'Attachment previews are busy.', 503),
    })
  }

  private async previewDirectory(path: string): Promise<{ ino: number; dev: number }> {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (cause) { if (!errno(cause, 'EEXIST')) throw cause }
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) corrupt('The attachment preview directory is not a plain directory.')
    if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0) corrupt('The attachment preview directory is not private.')
    return { ino: entry.ino, dev: entry.dev }
  }

  /**
   * Project verified immutable bytes into a private native-file cache. External
   * applications may edit this copy; a later preview restores the upload bytes.
   * Only an attachment identifier can select the source or destination.
   */
  async previewFile(id: string): Promise<{ attachment: AttachmentInfo; path: string }> {
    const { attachment, bytes } = await this.content(id)
    const unlock = await this.previewLock()
    const root = join(this.directory, '.preview')
    const directory = join(root, attachment.id)
    const path = join(directory, previewFilename(attachment.name))
    const temporary = join(directory, `.preview-${randomBytes(16).toString('hex')}.tmp`)
    let temporaryCreated = false
    let checkDirectories: (() => Promise<void>) | undefined
    try {
      const rootIdentity = await this.previewDirectory(root)
      const directoryIdentity = await this.previewDirectory(directory)
      checkDirectories = async () => {
        await this.checkDirectory()
        for (const [managed, identity] of [[root, rootIdentity], [directory, directoryIdentity]] as const) {
          const current = await lstat(managed)
          if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) {
            corrupt('The attachment preview directory changed during preparation.')
          }
        }
      }
      await checkDirectories()
      try {
        const existing = await lstat(path)
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) corrupt('The attachment preview is not a plain managed file.')
        if (existing.size <= bytes.length && (process.platform === 'win32' || (existing.mode & 0o077) === 0)) {
          const cached = await this.readManaged(path, bytes.length)
          if (cached.length === bytes.length && sha256(cached) === sha256(bytes)) {
            await checkDirectories()
            return { attachment, path }
          }
        }
      } catch (cause) { if (!errno(cause, 'ENOENT')) throw cause }
      await checkDirectories()
      // Exclusive creation and rename publish one complete independent copy;
      // hardlinking the immutable source would allow native edits to corrupt it.
      const file = await open(temporary, 'wx', 0o600)
      temporaryCreated = true
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await checkDirectories()
      // Rename replaces the entry itself and never follows a final symlink.
      await rename(temporary, path)
      temporaryCreated = false
      const published = await this.readManaged(path, bytes.length)
      if (published.length !== bytes.length || sha256(published) !== sha256(bytes)) corrupt('The attachment preview changed during preparation.')
      await checkDirectories()
      return { attachment, path }
    } catch (cause) {
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('ATTACHMENT_PERSISTENCE', 'The attachment preview could not be prepared.', 500, { cause })
    } finally {
      if (temporaryCreated) {
        // A replaced cache parent is no longer ours to clean up through.
        await (async () => { await checkDirectories?.(); await rm(temporary, { force: true }) })().catch(() => {})
      }
      await unlock()
    }
  }

  async upload(input: { name: string; mimeType?: string; bytes: Uint8Array }): Promise<AttachmentInfo> {
    if (!input || typeof input !== 'object') invalid('An attachment is required.')
    const name = validateAttachmentName(input.name)
    if (!(input.bytes instanceof Uint8Array)) invalid('Attachment bytes are required.')
    if (input.bytes.byteLength > this.maxFileBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'This attachment exceeds the file size limit.', 413)
    const bytes = Buffer.from(input.bytes)
    const media = attachmentMedia(bytes, input.mimeType)
    const unlock = await this.lock()
    let blobPath: string | undefined
    let blobCreated = false
    const temporary = join(this.directory, `.upload-${randomBytes(16).toString('hex')}.tmp`)
    const indexTemporary = join(this.directory, `.manifest-${randomBytes(16).toString('hex')}.tmp`)
    let committed = false
    try {
      const previous = await this.load()
      const total = previous.attachments.reduce((sum, item) => sum + item.size, 0)
      if (previous.attachments.length >= this.maxAttachments || total + bytes.length > this.maxTotalBytes) {
        throw new AttachmentError('ATTACHMENT_QUOTA', 'Attachment storage has reached its limit.', 413)
      }
      const id = randomBytes(16).toString('hex')
      const entry: AttachmentMetadata = { id, name, ...media, size: bytes.length, createdAt: new Date().toISOString(), sha256: sha256(bytes) }
      const manifest: Manifest = { version: 1, attachments: [...previous.attachments, entry] }
      const index = Buffer.from(JSON.stringify(manifest) + '\n', 'utf8')
      if (index.length > MAX_MANIFEST_BYTES) throw new AttachmentError('ATTACHMENT_QUOTA', 'Attachment storage has reached its index limit.', 413)
      await this.writeSynced(temporary, bytes)
      blobPath = join(this.directory, `${id}.blob`)
      // link is exclusive: even an extraordinarily rare id collision cannot overwrite an existing blob.
      await link(temporary, blobPath)
      blobCreated = true
      await rm(temporary)
      await this.writeSynced(indexTemporary, index)
      await rename(indexTemporary, this.manifestPath)
      committed = true
      return info(entry)
    } catch (cause) {
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('ATTACHMENT_PERSISTENCE', 'The attachment could not be saved.', 500, { cause })
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      await rm(indexTemporary, { force: true }).catch(() => {})
      if (!committed && blobCreated && blobPath) await rm(blobPath, { force: true }).catch(() => {})
      await unlock()
    }
  }

  /**
   * Remove attachments that no note references any more. The index is updated
   * first; a blob left behind by a failed unlink is unreachable and harmless.
   */
  async remove(ids: readonly string[]): Promise<number> {
    const targets = new Set(ids.map(validateAttachmentId))
    if (!targets.size) return 0
    const unlock = await this.lock()
    const indexTemporary = join(this.directory, `.manifest-${randomBytes(16).toString('hex')}.tmp`)
    try {
      const previous = await this.load()
      const removed = previous.attachments.filter(item => targets.has(item.id))
      if (!removed.length) return 0
      const manifest: Manifest = { version: 1, attachments: previous.attachments.filter(item => !targets.has(item.id)) }
      await this.writeSynced(indexTemporary, Buffer.from(JSON.stringify(manifest) + '\n', 'utf8'))
      await rename(indexTemporary, this.manifestPath)
      for (const item of removed) {
        await rm(join(this.directory, `${item.id}.blob`), { force: true }).catch(() => {})
      }
      await this.removePreviewFiles(removed.map(item => item.id)).catch(() => {})
      return removed.length
    } catch (cause) {
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('ATTACHMENT_PERSISTENCE', 'Unused attachments could not be removed.', 500, { cause })
    } finally {
      await rm(indexTemporary, { force: true }).catch(() => {})
      await unlock()
    }
  }

  /** Cleanup shares the preview lock and never traverses a replaced cache root. */
  private async removePreviewFiles(ids: readonly string[]): Promise<void> {
    const unlock = await this.previewLock()
    const root = join(this.directory, '.preview')
    try {
      let identity
      try { identity = await lstat(root) }
      catch (cause) { if (errno(cause, 'ENOENT')) return; throw cause }
      if (!identity.isDirectory() || identity.isSymbolicLink()) corrupt('The attachment preview directory is not a plain directory.')
      for (const id of ids) {
        await this.checkDirectory()
        const current = await lstat(root)
        if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) {
          corrupt('The attachment preview directory changed during cleanup.')
        }
        await rm(join(root, id), { recursive: true, force: true })
      }
    } finally { await unlock() }
  }

  async get(id: string): Promise<AttachmentInfo> {
    validateAttachmentId(id)
    const manifest = await this.load()
    const entry = manifest.attachments.find(item => item.id === id)
    if (!entry) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'This attachment is unavailable.', 404)
    return info(entry)
  }

  /** Validate managed references against one manifest read before saving a note. */
  async assertReferences(ids: readonly string[]): Promise<void> {
    const references = new Set(ids.map(validateAttachmentId))
    if (!references.size) return
    const available = new Set((await this.load()).attachments.map(item => item.id))
    for (const id of references) if (!available.has(id)) {
      throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'This attachment is unavailable.', 404)
    }
  }

  async content(id: string): Promise<{ attachment: AttachmentInfo; bytes: Buffer }> {
    validateAttachmentId(id)
    const manifest = await this.load()
    const entry = manifest.attachments.find(item => item.id === id)
    if (!entry) throw new AttachmentError('ATTACHMENT_NOT_FOUND', 'This attachment is unavailable.', 404)
    let bytes: Buffer
    try { bytes = await this.readManaged(join(this.directory, `${id}.blob`), entry.size) }
    catch (cause) {
      if (cause instanceof AttachmentError) throw cause
      throw new AttachmentError('CORRUPT_ATTACHMENTS', 'The attachment data is unavailable.', 500, { cause })
    }
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) corrupt('The attachment data has changed; its original index was preserved.')
    return { attachment: info(entry), bytes }
  }
}
