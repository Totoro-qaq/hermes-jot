import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { JotStore } from './store.js'
import { boundedString, documentAttachmentIds, MAX_DOC_BYTES, MAX_TITLE_LENGTH, onlyKeys, validateId, validateRichDoc, type RichDoc } from './model.js'
import { AttachmentStore, validateAttachmentId } from './attachments.js'
import type { AttachmentActions } from './attachment-actions.js'
import { EXPORT_FORMATS, exportJotLibrary, exportJotNote, LIBRARY_EXPORT_FORMATS, type ExportFormat, type LibraryExportFormat } from './exports.js'

export const JOT_API_PATH = '/jot/api'
// The request must carry a maximum-size rich document plus bounded note metadata.
export const MAX_REQUEST_BYTES = MAX_DOC_BYTES + 8192

export interface JotHttpOptions {
  /** The shared DSH Connection's Host/Origin fence and signed-cookie check. */
  authorize?: (request: IncomingMessage) => number | undefined
  attachments?: AttachmentStore
  /** Native attachment gestures are explicitly installed by the Host, never by a standalone server. */
  actions?: AttachmentActions
}

class HttpError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function loopback(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '::ffff:127.0.0.1') return true
  return isIP(address) === 4 && address.startsWith('127.')
}

/** Defense in depth; Desktop strips Origin only after admitting its owned app window. */
export function assertJotRequestTrust(request: IncomingMessage): void {
  const host = header(request, 'host')
  if (!host || /[\s/@\\?#]/u.test(host)) throw new HttpError('FORBIDDEN', 'Invalid request authority.', 403)
  let authority: URL
  try { authority = new URL(`http://${host}`) }
  catch { throw new HttpError('FORBIDDEN', 'Invalid request authority.', 403) }
  if (!authority.hostname || header(request, 'sec-fetch-site') === 'cross-site') {
    throw new HttpError('FORBIDDEN', 'Cross-site requests are not allowed.', 403)
  }
  const origin = header(request, 'origin')
  if (origin !== undefined) {
    let parsed: URL
    try { parsed = new URL(origin) }
    catch { throw new HttpError('FORBIDDEN', 'Invalid request origin.', 403) }
    // Compare using the same scheme so an HTTPS proxy's default port is normalized correctly.
    const expected = new URL(`${parsed.protocol}//${host}`)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== expected.origin
      || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new HttpError('FORBIDDEN', 'Request origin does not match this application.', 403)
    }
  } else if (!['GET', 'HEAD'].includes(request.method ?? '') && !loopback(request.socket.remoteAddress)) {
    throw new HttpError('FORBIDDEN', 'Mutations require a same-origin application request.', 403)
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const mediaType = header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new HttpError('CONTENT_TYPE', 'Use application/json.', 415)
  const length = header(request, 'content-length')
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new HttpError('REQUEST_TOO_LARGE', 'Request body is too large.', 413)
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_REQUEST_BYTES) {
      request.resume()
      throw new HttpError('REQUEST_TOO_LARGE', 'Request body is too large.', 413)
    }
    chunks.push(bytes)
  }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError('INVALID_JSON', 'Request body must be valid JSON.', 400) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('INVALID_INPUT', 'Request body must be an object.', 400)
  }
  return body as Record<string, unknown>
}

async function readAttachment(request: IncomingMessage, maximum: number): Promise<Buffer> {
  if (header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
    throw new HttpError('CONTENT_TYPE', 'Upload attachment bytes as application/octet-stream.', 415)
  }
  const length = header(request, 'content-length')
  if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    request.resume()
    throw new HttpError('ATTACHMENT_TOO_LARGE', 'This attachment exceeds the file size limit.', 413)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maximum) {
      request.resume()
      throw new HttpError('ATTACHMENT_TOO_LARGE', 'This attachment exceeds the file size limit.', 413)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

function fileDisposition(name: string, inline = false): string {
  const safeName = Array.from(name, character => character.length === 1 && /[\ud800-\udfff]/u.test(character) ? '\ufffd' : character).join('')
    .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
  const ascii = safeName.replace(/[^a-zA-Z0-9._ -]/gu, '_') || 'attachment'
  const encoded = encodeURIComponent(safeName).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function contentRange(range: string | undefined, size: number): { start: number; end: number } | undefined {
  if (range === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
  if (!match || !size || !match[1] && !match[2]) throw new HttpError('INVALID_RANGE', 'The requested attachment range is unavailable.', 416)
  const startValue = match[1] ? Number(match[1]) : undefined
  const endValue = match[2] ? Number(match[2]) : undefined
  if (startValue !== undefined && !Number.isSafeInteger(startValue) || endValue !== undefined && !Number.isSafeInteger(endValue)) {
    throw new HttpError('INVALID_RANGE', 'The requested attachment range is unavailable.', 416)
  }
  const start = startValue ?? Math.max(0, size - (endValue ?? 0))
  const end = startValue === undefined ? size - 1 : Math.min(endValue ?? size - 1, size - 1)
  if (start >= size || end < start || startValue === undefined && endValue === 0) {
    throw new HttpError('INVALID_RANGE', 'The requested attachment range is unavailable.', 416)
  }
  return { start, end }
}

function requireRevision(body: Record<string, unknown>): number {
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
    throw new HttpError('INVALID_INPUT', 'A positive integer revision is required.', 400)
  }
  return body.revision as number
}

function pathId(encoded: string): string {
  try { return decodeURIComponent(encoded) }
  catch { throw new HttpError('INVALID_INPUT', 'Invalid encoded identifier.', 400) }
}

function reply(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(JSON.stringify(payload))
}

/** A generated download; it is private to the authenticated user and never cached. */
function sendFile(response: ServerResponse, file: { buffer: Buffer; filename: string; contentType: string }, headers: Record<string, string> = {}) {
  response.writeHead(200, {
    'content-type': file.contentType,
    'content-disposition': fileDisposition(file.filename),
    'content-length': file.buffer.length,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...headers,
  })
  response.end(file.buffer)
}

/** A completed request body is normal; a disconnected response cancels a pending native gesture. */
function requestLifetime(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const requestClosed = () => { if (!request.complete) abort() }
  const responseClosed = () => { if (!response.writableFinished) abort() }
  request.on('aborted', abort)
  request.on('close', requestClosed)
  response.on('close', responseClosed)
  if (request.aborted || request.destroyed && !request.complete || response.destroyed) abort()
  return {
    signal: controller.signal,
    dispose: () => {
      request.off('aborted', abort)
      request.off('close', requestClosed)
      response.off('close', responseClosed)
    },
  }
}

/** A standalone adapter; a missing shared authorizer always refuses access. */
export function createJotHandler(store: JotStore, options: JotHttpOptions = {}) {
  const attachments = options.attachments ?? new AttachmentStore({ directory: store.directory })
  const verifyAttachments = (content: RichDoc) => attachments.assertReferences([...documentAttachmentIds(content)])
  const attachmentLoader = async (id: string) => {
    const result = await attachments.content(id)
    return { name: result.attachment.name, mimeType: result.attachment.mimeType, size: result.attachment.size, data: result.bytes }
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      assertJotRequestTrust(request)
      const rejection = options.authorize?.(request) ?? (options.authorize === undefined ? 401 : undefined)
      if (rejection !== undefined) throw new HttpError(rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', 'Application authentication is required.', rejection)
      const url = new URL(request.url ?? '/', 'http://jot.invalid')
      const path = url.pathname.slice(JOT_API_PATH.length)
      if (!url.pathname.startsWith(JOT_API_PATH + '/') && url.pathname !== JOT_API_PATH) {
        throw new HttpError('NOT_FOUND', 'Unknown Jot endpoint.', 404)
      }
      const method = request.method ?? 'GET'
      let data: unknown
      let status = 200
      if (path === '/attachment-capabilities') {
        if (method !== 'GET') {
          response.setHeader('allow', 'GET')
          throw new HttpError('METHOD_NOT_ALLOWED', 'Unsupported attachment operation.', 405)
        }
        data = options.actions?.capabilities() ?? { nativeOpen: false }
      } else if (/^\/attachments\/[^/]+\/(?:preview|open)$/u.test(path)) {
        if (method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new HttpError('METHOD_NOT_ALLOWED', 'Attachment actions require POST.', 405)
        }
        const match = /^\/attachments\/([^/]+)\/(preview|open)$/u.exec(path)!
        const id = validateAttachmentId(pathId(match[1]!))
        const body = await readJson(request)
        onlyKeys(body, [], 'attachment action')
        const actions = options.actions
        if (!actions) throw new HttpError('ATTACHMENT_ACTIONS_UNAVAILABLE', 'Attachment application actions are unavailable on this Host. Download the file to open it.', 409)
        if (match[2] === 'preview') data = await actions.preparePreview(id)
        else {
          const lifetime = requestLifetime(request, response)
          try { await actions.open(id, lifetime.signal) }
          finally { lifetime.dispose() }
          data = null
        }
      } else if (method === 'POST' && path === '/export') {
        const body = await readJson(request)
        onlyKeys(body, ['title', 'content', 'format'], 'export')
        const title = boundedString(body.title ?? '', MAX_TITLE_LENGTH, 'title')
        const content = validateRichDoc(body.content)
        if (typeof body.format !== 'string' || !EXPORT_FORMATS.includes(body.format as ExportFormat)) {
          throw new HttpError('INVALID_EXPORT_FORMAT', 'Choose TXT, Markdown, PDF or DOCX.', 400)
        }
        const exported = await exportJotNote({ title, content }, body.format as ExportFormat, { attachmentLoader })
        sendFile(response, exported)
        return
      } else if (method === 'POST' && path === '/export-library') {
        const body = await readJson(request)
        onlyKeys(body, ['format', 'folderId', 'locale'], 'library export')
        if (typeof body.format !== 'string' || !LIBRARY_EXPORT_FORMATS.includes(body.format as LibraryExportFormat)) {
          throw new HttpError('INVALID_EXPORT_FORMAT', 'Choose Word, PDF or Markdown.', 400)
        }
        // Absent exports every note; null exports unfiled notes; an id exports one folder. Trash is never exported.
        const folderId = body.folderId === undefined || body.folderId === null ? body.folderId : validateId(body.folderId)
        const state = await store.readState('user')
        const notes = state.notes.filter(note => note.deletedAt === null && (folderId === undefined || note.folderId === folderId))
        const exported = await exportJotLibrary({ notes, folders: state.folders }, body.format as LibraryExportFormat, {
          attachmentLoader, locale: body.locale === 'en' ? 'en' : 'zh',
        })
        sendFile(response, exported, { 'x-jot-export-notes': String(exported.notes), 'x-jot-export-attachments': String(exported.attachments) })
        return
      } else if (method === 'POST' && path === '/attachments') {
        const encodedName = header(request, 'x-jot-filename')
        if (!encodedName) throw new HttpError('INVALID_ATTACHMENT', 'An attachment file name is required.', 400)
        let name: string
        try { name = decodeURIComponent(encodedName) } catch { throw new HttpError('INVALID_ATTACHMENT', 'The attachment file name is invalid.', 400) }
        const bytes = await readAttachment(request, attachments.maxFileBytes)
        data = await attachments.upload({ name, mimeType: header(request, 'x-jot-mime-type'), bytes })
        status = 201
      } else if (/^\/attachments\/[^/]+(?:\/content)?$/u.test(path)) {
        const match = /^\/attachments\/([^/]+)(\/content)?$/u.exec(path)!
        const id = pathId(match[1]!)
        if (method === 'GET' && !match[2]) data = await attachments.get(id)
        else if (['GET', 'HEAD'].includes(method) && match[2]) {
          const { attachment, bytes } = await attachments.content(id)
          let range: ReturnType<typeof contentRange>
          try { range = contentRange(header(request, 'range'), bytes.length) }
          catch (cause) { response.setHeader('content-range', `bytes */${bytes.length}`); throw cause }
          const body = range ? bytes.subarray(range.start, range.end + 1) : bytes
          response.writeHead(range ? 206 : 200, {
            'content-type': attachment.kind === 'file' ? 'application/octet-stream' : attachment.mimeType,
            'content-disposition': fileDisposition(attachment.name, url.searchParams.get('download') !== '1' && attachment.kind !== 'file'),
            'content-length': body.length,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
            'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'self'",
            'accept-ranges': 'bytes',
            ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}` } : {}),
          })
          response.end(method === 'HEAD' ? undefined : body)
          return
        } else throw new HttpError('METHOD_NOT_ALLOWED', 'Unsupported attachment operation.', 405)
      } else if (method === 'GET' && path === '/state') {
        // Polling clients send the previous tag; an unchanged library costs no body or client render.
        const previous = header(request, 'if-none-match')
        const result = await store.readSnapshot(previous)
        if (!result.snapshot) {
          response.writeHead(304, { etag: result.tag, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          response.end()
          return
        }
        if (!response.destroyed) reply(response, 200, { data: result.snapshot }, { etag: result.tag })
        return
      } else if (method === 'POST' && path === '/trash/empty') {
        const body = await readJson(request)
        onlyKeys(body, [], 'empty trash')
        data = await store.purgeNotes('trash', 'user', async ids => { await attachments.remove(ids) })
      } else if (method === 'GET' && path === '/notes') {
        const query = url.searchParams.get('q') ?? ''
        const rawFolderId = url.searchParams.get('folderId')
        const folderId = rawFolderId === null ? undefined : rawFolderId === '' ? null : rawFolderId
        if (url.searchParams.get('trash') === '1') {
          const state = await store.readState('user')
          const needle = query.toLocaleLowerCase()
          data = state.notes.filter(note => note.deletedAt !== null && note.deletedAt !== undefined
            && (folderId === undefined || note.folderId === folderId)
            && (!needle || `${note.title}\n${note.text}`.toLocaleLowerCase().includes(needle)))
        } else data = await store.search(query, folderId, 'user')
      } else if (method === 'POST' && path === '/notes') {
        const body = await readJson(request)
        data = await store.createNote(body as Parameters<JotStore['createNote']>[0], 'user', verifyAttachments)
        status = 201
      } else if (/^\/notes\/[^/]+\/revert-agent-edit$/u.test(path)) {
        if (method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new HttpError('METHOD_NOT_ALLOWED', 'Undoing an AI edit requires POST.', 405)
        }
        const id = pathId(/^\/notes\/([^/]+)\/revert-agent-edit$/u.exec(path)![1]!)
        const body = await readJson(request)
        onlyKeys(body, ['revision'], 'undo AI edit')
        data = await store.revertAgentEdit(id, requireRevision(body), 'user', verifyAttachments)
      } else if (/^\/notes\/[^/]+\/purge$/u.test(path)) {
        if (method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new HttpError('METHOD_NOT_ALLOWED', 'Permanent deletion requires POST.', 405)
        }
        const id = pathId(/^\/notes\/([^/]+)\/purge$/u.exec(path)![1]!)
        const body = await readJson(request)
        onlyKeys(body, ['revision'], 'permanent deletion')
        data = await store.purgeNotes([{ id, revision: requireRevision(body) }], 'user', async ids => { await attachments.remove(ids) })
      } else if (/^\/notes\/[^/]+(?:\/restore)?$/u.test(path)) {
        const match = /^\/notes\/([^/]+)(\/restore)?$/u.exec(path)!
        const id = pathId(match[1]!)
        if (method === 'GET' && !match[2]) data = await store.getNote(id, 'user')
        else if (method === 'PATCH' && !match[2]) {
          const body = await readJson(request)
          const { revision: _revision, ...patch } = body
          data = await store.updateNote(id, requireRevision(body), patch, 'user', verifyAttachments)
        } else if (method === 'DELETE' && !match[2]) {
          const body = await readJson(request)
          data = await store.deleteNote(id, requireRevision(body), 'user')
        } else if (method === 'POST' && match[2]) {
          const body = await readJson(request)
          data = await store.restoreNote(id, requireRevision(body), 'user')
        } else throw new HttpError('METHOD_NOT_ALLOWED', 'Unsupported operation.', 405)
      } else if (method === 'POST' && path === '/folders') {
        const body = await readJson(request)
        data = await store.createFolder(body.name as string, 'user')
        status = 201
      } else if (/^\/folders\/[^/]+$/u.test(path)) {
        const id = pathId(path.slice('/folders/'.length))
        if (method === 'PATCH') {
          const body = await readJson(request)
          data = await store.renameFolder(id, body.name as string, 'user')
        } else if (method === 'DELETE') {
          await store.deleteFolder(id, 'user')
          data = null
        } else throw new HttpError('METHOD_NOT_ALLOWED', 'Unsupported operation.', 405)
      } else if (method === 'PATCH' && path === '/settings') {
        const body = await readJson(request)
        if (typeof body.agentEnabled !== 'boolean') throw new HttpError('INVALID_INPUT', 'agentEnabled must be boolean.', 400)
        await store.setAgentEnabled(body.agentEnabled, 'user')
        data = { agentEnabled: (await store.readState('user')).agentEnabled }
      } else throw new HttpError('NOT_FOUND', 'Unknown Jot endpoint.', 404)
      if (!response.destroyed) reply(response, status, { data })
    } catch (error) {
      const known = error !== null && typeof error === 'object' && 'code' in error && 'status' in error
      const status = known && typeof error.status === 'number' ? error.status : 500
      const code = known && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
      const message = status < 500 && error instanceof Error ? error.message : 'Jot could not complete the operation.'
      if (response.destroyed) return
      if (!response.headersSent) reply(response, status, { error: { code, message } })
      else response.end()
    }
  }
}
