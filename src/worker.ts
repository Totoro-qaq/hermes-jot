/** One bounded stdio request. Reuses Jot's tested HTTP contract without opening a network port. */
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { JotStore } from './store.js'
import { AttachmentStore } from './attachments.js'
import { createJotHandler } from './http.js'
import { createJotTools } from './tools.js'
import { toolSchema, validateToolArgs } from './tool-definition.js'

const MAX_INPUT = 30 * 1024 * 1024
const MAX_OUTPUT = 210 * 1024 * 1024

class MemoryResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: Buffer[] = []
  headersSent = false
  writableFinished = false
  destroyed = false
  size = 0
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = String(value); return this }
  writeHead(status: number, headers: Record<string, unknown>) {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    this.headersSent = true
    return this
  }
  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) {
      const bytes = Buffer.from(chunk)
      this.size += bytes.length
      if (this.size > MAX_OUTPUT) throw new Error('Result exceeds the export limit.')
      this.chunks.push(bytes)
    }
    this.writableFinished = true
    this.emit('finish')
    return this
  }
}

async function exportFile(directory: string, bytes: Buffer, headers: Record<string, string>) {
  const target = join(directory, 'downloads')
  await mkdir(target, { recursive: true, mode: 0o700 })
  // Only this worker's UUID files are temporary. Never touch notes or attachment originals.
  for (const name of await readdir(target)) {
    if (!/^[a-f0-9-]{36}\.(?:pdf|docx|zip|txt|md)$/u.test(name)) continue
    const file = join(target, name)
    if (Date.now() - (await stat(file)).mtimeMs > 24 * 60 * 60 * 1000) await unlink(file)
  }
  const encoded = /filename\*=UTF-8''([^;]+)/u.exec(headers['content-disposition'] ?? '')?.[1]
  const filename = encoded ? decodeURIComponent(encoded) : 'Jot-download'
  const suffix = /\.(pdf|docx|zip|txt|md)$/u.exec(filename)?.[1] ?? 'txt'
  const path = join(target, `${randomUUID()}.${suffix}`)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { path, filename, size: bytes.length, mimeType: headers['content-type'] ?? 'application/octet-stream' }
}

export async function runWorker(input: Record<string, any>, directory: string) {
  if (!directory || !isAbsolute(directory)) throw new Error('A host-owned absolute data directory is required.')
  const store = new JotStore({ directory: resolve(directory) })
  const attachments = new AttachmentStore({ directory: store.directory })
  if (input.kind === 'tool') {
    const tool = createJotTools(store).find(item => item.name === input.name)
    if (!tool) throw new Error('Unknown Jot tool.')
    validateToolArgs(tool, input.args)
    return { data: await tool.execute(input.args) }
  }
  if (input.kind === 'attachment-preview') return { data: await attachments.previewFile(input.id) }
  if (input.kind === 'attachment-inline') {
    const { attachment, bytes } = await attachments.content(input.id)
    if (attachment.kind !== 'image' && attachment.kind !== 'pdf') throw new Error('Only verified images and PDF have inline previews.')
    return { data: { ...attachment, base64: bytes.toString('base64') } }
  }
  if (input.kind !== 'http' || typeof input.path !== 'string' || !/^\/(?!\/)/u.test(input.path)
      || input.path.includes('..') || !['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(input.method)) {
    throw new Error('Invalid local request.')
  }
  const body = input.base64 !== undefined ? Buffer.from(input.base64, 'base64')
    : Buffer.from(input.body === undefined ? '' : JSON.stringify(input.body))
  const request = Object.assign(Readable.from(body.length ? [body] : [], { autoDestroy: false }), {
    method: input.method, url: '/jot/api' + input.path,
    headers: { ...(input.headers ?? {}), host: '127.0.0.1', 'content-length': String(body.length),
      'content-type': input.base64 !== undefined ? 'application/octet-stream' : 'application/json' },
    socket: { remoteAddress: '127.0.0.1' }, complete: true, aborted: false,
  })
  const response = new MemoryResponse()
  const handler = createJotHandler(store, { attachments, authorize: () => undefined })
  await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  const bytes = Buffer.concat(response.chunks)
  if (response.statusCode === 304) return { status: 304, headers: response.headers }
  if (response.headers['content-type']?.includes('application/json')) {
    return { status: response.statusCode, headers: response.headers, ...JSON.parse(bytes.toString('utf8')) }
  }
  if (response.statusCode >= 400) throw new Error('Could not prepare the file.')
  return { status: response.statusCode, headers: response.headers, file: await exportFile(directory, bytes, response.headers) }
}

async function main() {
  if (process.argv.includes('--schemas')) {
    process.stdout.write(JSON.stringify(createJotTools(null as unknown as JotStore).map(toolSchema)))
    return
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT) throw new Error('Request exceeds the attachment limit.')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  try { process.stdout.write(JSON.stringify(await runWorker(input, process.argv[2] ?? ''))) }
  catch (error) {
    const known = error && typeof error === 'object' && 'code' in error
    process.stdout.write(JSON.stringify({ error: { code: known ? error.code : 'INVALID_INPUT',
      message: error instanceof Error ? error.message : 'The operation failed.' },
      status: error && typeof error === 'object' && 'status' in error ? error.status : 400 }))
  }
}
main().catch(() => { process.stdout.write(JSON.stringify({ status: 400, error: { code: 'INVALID_INPUT', message: 'Invalid worker request.' } })); process.exitCode = 1 })
