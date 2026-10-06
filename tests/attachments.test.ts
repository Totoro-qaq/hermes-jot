import assert from 'node:assert/strict'
import { createServer, request as nodeRequest, type IncomingMessage } from 'node:http'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { AttachmentError, AttachmentStore, attachmentMedia, attachmentUrl } from '../src/attachments.js'
import { createJotHandler } from '../src/http.js'
import { JotStore } from '../src/store.js'
import { docFromText } from '../src/model.js'
import { strFromU8, unzipSync } from 'fflate'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwS8AAAAASUVORK5CYII=', 'base64')
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-jot-attachments-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('attachment uploads publish immutable metadata and survive a store restart', async t => {
  const root = await directory(t)
  const store = new AttachmentStore({ directory: root })
  const image = await store.upload({ name: '截图 1.png', mimeType: 'image/png', bytes: png })
  assert.match(image.id, /^[a-f0-9]{32}$/u)
  assert.equal(image.kind, 'image')
  assert.equal(image.size, png.length)
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.url, attachmentUrl(image.id))
  assert.equal(image.downloadUrl, attachmentUrl(image.id, true))
  assert.ok(!JSON.stringify(image).includes(root))
  const restarted = new AttachmentStore({ directory: root })
  assert.deepEqual(await restarted.get(image.id), image)
  assert.deepEqual((await restarted.content(image.id)).bytes, png)
  image.name = 'changed client object'
  assert.equal((await restarted.get(image.id)).name, '截图 1.png')
  assert.deepEqual((await readdir(store.directory)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), [])
})

test('inline classification uses byte signatures and refuses SVG or forged MIME claims', () => {
  assert.deepEqual(attachmentMedia(png, 'text/html'), { mimeType: 'image/png', kind: 'image' })
  assert.deepEqual(attachmentMedia(pdf, 'image/png'), { mimeType: 'application/pdf', kind: 'pdf' })
  assert.deepEqual(attachmentMedia(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/svg+xml'), { mimeType: 'application/octet-stream', kind: 'file' })
  assert.deepEqual(attachmentMedia(Buffer.from('<script>bad</script>'), 'image/png'), { mimeType: 'application/octet-stream', kind: 'file' })
  assert.deepEqual(attachmentMedia(Buffer.from('ordinary text'), 'text/plain'), { mimeType: 'text/plain', kind: 'file' })
  assert.deepEqual(attachmentMedia(new Uint8Array()), { mimeType: 'application/octet-stream', kind: 'file' })
  assert.throws(() => attachmentMedia(png, 'image/png\r\nInjected: yes'), AttachmentError)
  const dimensionsBomb = Buffer.from(png)
  dimensionsBomb.writeUInt32BE(20_000, 16)
  dimensionsBomb.writeUInt32BE(20_000, 20)
  assert.deepEqual(attachmentMedia(dimensionsBomb, 'image/png'), { mimeType: 'application/octet-stream', kind: 'file' })
})

test('attachment input cannot select filesystem paths or inject filenames into headers', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  for (const name of ['../escape.png', '..\\escape.png', '.', '..', 'file\r\nX-Injected:yes', 'a'.repeat(201), '名'.repeat(180), '\ud800']) {
    await assert.rejects(store.upload({ name, bytes: png }), (error: unknown) => error instanceof AttachmentError && error.status === 400)
  }
  for (const id of ['../private', 'https://example.test/image.png', 'a'.repeat(31), 'A'.repeat(32), 'f'.repeat(32) + '/file']) {
    await assert.rejects(store.get(id), (error: unknown) => error instanceof AttachmentError && error.status === 400)
  }
  await assert.rejects(store.get('f'.repeat(32)), (error: unknown) => error instanceof AttachmentError && error.status === 404)
})

test('byte/count quotas remain atomic across concurrent store instances', async t => {
  const root = await directory(t)
  const first = new AttachmentStore({ directory: root, maxFileBytes: 8, maxTotalBytes: 8, maxAttachments: 1 })
  const second = new AttachmentStore({ directory: root, maxFileBytes: 8, maxTotalBytes: 8, maxAttachments: 1 })
  await assert.rejects(first.upload({ name: 'large.bin', bytes: Buffer.alloc(9) }), (error: unknown) => error instanceof AttachmentError && error.status === 413)
  const outcomes = await Promise.allSettled([
    first.upload({ name: 'first.bin', bytes: Buffer.from('12345678') }),
    second.upload({ name: 'second.bin', bytes: Buffer.from('abcdefgh') }),
  ])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  const refused = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult
  assert.equal(refused.reason.code, 'ATTACHMENT_QUOTA')
  assert.equal((await readdir(first.directory)).filter(name => name.endsWith('.blob')).length, 1)
})

test('corrupt or missing indexes are preserved instead of silently overwriting managed files', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  const original = await store.upload({ name: 'first.png', bytes: png })
  await writeFile(store.manifestPath, '{broken')
  await assert.rejects(store.upload({ name: 'second.png', bytes: png }), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
  assert.equal(await readFile(store.manifestPath, 'utf8'), '{broken')
  assert.deepEqual(await readFile(join(store.directory, `${original.id}.blob`)), png)
  assert.deepEqual((await readdir(store.directory)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), [])
  await rm(store.manifestPath)
  await assert.rejects(store.upload({ name: 'third.png', bytes: png }), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
})

test('managed reads reject changed bytes, symlink blobs, hardlinks, and symlink indexes', async t => {
  const root = await directory(t)
  const store = new AttachmentStore({ directory: root })
  const original = await store.upload({ name: 'first.png', bytes: png })
  const blob = join(store.directory, `${original.id}.blob`)
  await writeFile(blob, Buffer.alloc(png.length, 1))
  await assert.rejects(store.content(original.id), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
  const outside = join(root, 'private.txt')
  await writeFile(outside, 'private material')
  await rm(blob)
  await symlink(outside, blob)
  await assert.rejects(store.content(original.id), AttachmentError)
  await rm(blob)
  await link(outside, blob)
  await assert.rejects(store.content(original.id), AttachmentError)
  await rm(store.manifestPath)
  await symlink(outside, store.manifestPath)
  await assert.rejects(store.get(original.id), AttachmentError)
})

test('a held attachment lock times out without stealing or removing it', async t => {
  const store = new AttachmentStore({ directory: await directory(t), lockTimeoutMs: 20 })
  await store.upload({ name: 'first.txt', bytes: Buffer.from('first') })
  await writeFile(store.lockPath, 'owned by another writer')
  await assert.rejects(store.upload({ name: 'next.txt', bytes: Buffer.from('next') }), (error: unknown) => error instanceof AttachmentError && error.code === 'ATTACHMENT_LOCKED')
  assert.equal(await readFile(store.lockPath, 'utf8'), 'owned by another writer')
})

test('native preview copies retain names and bytes without sharing the immutable blob inode', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  const attachment = await store.upload({ name: '会议记录.docx', bytes: Buffer.from('original Office bytes') })
  const projection = await store.previewFile(attachment.id)
  assert.deepEqual(projection.attachment, attachment)
  assert.equal(projection.path, join(store.directory, '.preview', attachment.id, attachment.name))
  assert.deepEqual(await readFile(projection.path), (await store.content(attachment.id)).bytes)
  const original = await lstat(join(store.directory, `${attachment.id}.blob`))
  const copy = await lstat(projection.path)
  assert.equal(original.nlink, 1)
  assert.equal(copy.nlink, 1)
  assert.notEqual(copy.ino, original.ino)
  if (process.platform !== 'win32') {
    assert.equal(copy.mode & 0o077, 0)
    assert.equal((await lstat(dirname(projection.path))).mode & 0o077, 0)
    assert.equal((await lstat(join(store.directory, '.preview'))).mode & 0o077, 0)
  }
  const restarted = new AttachmentStore({ directory: dirname(store.directory) })
  assert.equal((await restarted.previewFile(attachment.id)).path, projection.path)
  assert.deepEqual((await readdir(store.directory)).filter(name => name.endsWith('.lock')), [])
  assert.deepEqual((await readdir(dirname(projection.path))).filter(name => name.endsWith('.tmp')), [])
})

test('native preview restores an externally edited copy while preserving the original', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  const bytes = Buffer.from('original content')
  const attachment = await store.upload({ name: 'draft.txt', bytes })
  const { path } = await store.previewFile(attachment.id)
  for (const changed of [Buffer.alloc(bytes.length, 1), Buffer.from('short'), Buffer.alloc(bytes.length + 1024, 2)]) {
    await writeFile(path, changed)
    assert.equal((await store.previewFile(attachment.id)).path, path)
    assert.deepEqual(await readFile(path), bytes)
    assert.deepEqual((await store.content(attachment.id)).bytes, bytes)
  }
})

test('native preview validates the source on every call even when a verified copy exists', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  const attachment = await store.upload({ name: 'draft.txt', bytes: Buffer.from('original') })
  const { path } = await store.previewFile(attachment.id)
  await writeFile(join(store.directory, `${attachment.id}.blob`), 'tampered')
  await assert.rejects(store.previewFile(attachment.id), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
  assert.equal(await readFile(path, 'utf8'), 'original')
  await assert.rejects(store.previewFile('../escape'), (error: unknown) => error instanceof AttachmentError && error.status === 400)
  await assert.rejects(store.previewFile('f'.repeat(32)), (error: unknown) => error instanceof AttachmentError && error.status === 404)
})

test('native preview refuses linked source files without creating a cache', async t => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const root = await directory(t)
    const store = new AttachmentStore({ directory: root })
    const bytes = Buffer.from('original')
    const attachment = await store.upload({ name: 'draft.txt', bytes })
    const outside = join(root, 'outside.txt')
    await writeFile(outside, bytes)
    const blob = join(store.directory, `${attachment.id}.blob`)
    await rm(blob)
    if (kind === 'symlink') await symlink(outside, blob)
    else await link(outside, blob)
    await assert.rejects(store.previewFile(attachment.id), AttachmentError)
    assert.ok(!(await readdir(store.directory)).includes('.preview'))
    assert.equal(await readFile(outside, 'utf8'), 'original')
  }
})

test('native preview refuses symlink cache layers and never writes outside managed storage', async t => {
  for (const layer of ['root', 'attachment'] as const) {
    const root = await directory(t)
    const store = new AttachmentStore({ directory: root })
    const attachment = await store.upload({ name: 'draft.txt', bytes: Buffer.from('original') })
    const outside = join(root, 'outside')
    await mkdir(outside)
    const cacheRoot = join(store.directory, '.preview')
    if (layer === 'attachment') await mkdir(cacheRoot, { mode: 0o700 })
    await symlink(outside, layer === 'root' ? cacheRoot : join(cacheRoot, attachment.id), 'junction')
    await assert.rejects(store.previewFile(attachment.id), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
    assert.deepEqual(await readdir(outside), [])
    assert.ok(!(await readdir(store.directory)).includes('.preview.lock'))
  }
})

test('native preview rejects cache symlinks, hardlinks and directories instead of replacing them', async t => {
  for (const kind of ['symlink', 'hardlink', 'directory'] as const) {
    const root = await directory(t)
    const store = new AttachmentStore({ directory: root })
    const attachment = await store.upload({ name: 'draft.txt', bytes: Buffer.from('original') })
    const { path } = await store.previewFile(attachment.id)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'private outside bytes')
    await rm(path)
    if (kind === 'symlink') await symlink(outside, path)
    else if (kind === 'hardlink') await link(outside, path)
    else await mkdir(path)
    await assert.rejects(store.previewFile(attachment.id), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
    assert.equal(await readFile(outside, 'utf8'), 'private outside bytes')
    const remaining = await lstat(path)
    assert.ok(kind === 'symlink' ? remaining.isSymbolicLink() : kind === 'hardlink' ? remaining.nlink === 2 : remaining.isDirectory())
    assert.deepEqual((await readdir(dirname(path))).filter(name => name.endsWith('.tmp')), [])
  }
})

test('native preview publication is shared across concurrent store instances', async t => {
  const root = await directory(t)
  const first = new AttachmentStore({ directory: root })
  const second = new AttachmentStore({ directory: root })
  const bytes = Buffer.alloc(128 * 1024, 42)
  const attachment = await first.upload({ name: 'draft.docx', bytes })
  const copies = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? first : second).previewFile(attachment.id)))
  assert.equal(new Set(copies.map(copy => copy.path)).size, 1)
  assert.deepEqual(await readFile(copies[0]!.path), bytes)
  assert.deepEqual(await readdir(dirname(copies[0]!.path)), ['draft.docx'])
  assert.equal((await lstat(join(first.directory, `${attachment.id}.blob`))).nlink, 1)
  assert.deepEqual((await readdir(first.directory)).filter(name => name.endsWith('.lock')), [])
})

test('native preview names work across Windows and POSIX while preserving useful extensions', async t => {
  const store = new AttachmentStore({ directory: await directory(t) })
  for (const [name, expected] of [
    ['CON.docx', '_CON.docx'], ['CON .docx', '_CON .docx'], ['lpt1.xlsx', '_lpt1.xlsx'], ['COM¹.txt', '_COM¹.txt'], ['NUL', '_NUL'],
    ['CONIN$.txt', '_CONIN$.txt'], [' report:2026?*.docx.  ', 'report_2026__.docx'], ['... ', 'attachment'],
  ]) {
    const attachment = await store.upload({ name: name!, bytes: Buffer.from('data') })
    const projection = await store.previewFile(attachment.id)
    assert.equal(basename(projection.path), expected)
    assert.equal(projection.attachment.name, name)
  }
  const long = await store.upload({ name: '记'.repeat(160) + '.docx', bytes: Buffer.from('data') })
  const projected = basename((await store.previewFile(long.id)).path)
  assert.ok(Buffer.byteLength(projected, 'utf8') <= 240)
  assert.ok(projected.endsWith('.docx'))
  assert.ok(!/[<>:"|?*]|[. ]$/u.test(projected))
})

test('a held native preview lock times out without stealing it', async t => {
  const store = new AttachmentStore({ directory: await directory(t), lockTimeoutMs: 20 })
  const attachment = await store.upload({ name: 'draft.txt', bytes: Buffer.from('original') })
  const path = join(store.directory, '.preview.lock')
  await writeFile(path, 'owned by another preview')
  await assert.rejects(store.previewFile(attachment.id), (error: unknown) => error instanceof AttachmentError && error.code === 'ATTACHMENT_LOCKED')
  assert.equal(await readFile(path, 'utf8'), 'owned by another preview')
})

test('native preview rejects linked projection locks without changing their targets', async t => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const root = await directory(t)
    const store = new AttachmentStore({ directory: root })
    const attachment = await store.upload({ name: 'draft.txt', bytes: Buffer.from('original') })
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'untouched')
    const path = join(store.directory, '.preview.lock')
    if (kind === 'symlink') await symlink(outside, path)
    else await link(outside, path)
    await assert.rejects(store.previewFile(attachment.id), (error: unknown) => error instanceof AttachmentError && error.code === 'CORRUPT_ATTACHMENTS')
    assert.equal(await readFile(outside, 'utf8'), 'untouched')
    assert.ok((await lstat(path)).isSymbolicLink() || (await lstat(path)).nlink === 2)
  }
})

async function httpFixture(t: TestContext, maxFileBytes = 1024) {
  const root = await directory(t)
  const attachments = new AttachmentStore({ directory: root, maxFileBytes })
  const store = new JotStore({ directory: root })
  let authority = ''
  const authorize = (request: IncomingMessage) => request.headers.host !== authority ? 403
    : request.headers.cookie === 'attachment-session=valid' ? undefined : 401
  const server = createServer(createJotHandler(store, { attachments, authorize }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  authority = `127.0.0.1:${address.port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const headers = { origin: base, cookie: 'attachment-session=valid' }
  const upload = (name: string, bytes: Uint8Array, mimeType = 'application/octet-stream', extra: Record<string, string> = {}) => fetch(`${base}/jot/api/attachments`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-jot-filename': encodeURIComponent(name), 'x-jot-mime-type': mimeType, ...extra }, body: new Uint8Array(bytes),
  })
  return { base, headers, upload, attachments, store }
}

test('raw upload and content routes require authentication and reject foreign origins for every access', async t => {
  const { base, headers, upload } = await httpFixture(t)
  assert.equal((await upload('private.png', png, 'image/png', { cookie: '' })).status, 401)
  assert.equal((await upload('private.png', png, 'image/png', { origin: 'https://attacker.invalid' })).status, 403)
  const created = await upload('private.png', png, 'image/png')
  assert.equal(created.status, 201)
  const { data: attachment } = await created.json()
  for (const path of [`/attachments/${attachment.id}`, `/attachments/${attachment.id}/content`]) {
    assert.equal((await fetch(`${base}/jot/api${path}`, { headers: { ...headers, cookie: '' } })).status, 401)
    assert.equal((await fetch(`${base}/jot/api${path}`, { headers: { ...headers, origin: 'https://attacker.invalid' } })).status, 403)
  }
  assert.equal((await fetch(base + attachment.url, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
})

test('safe image/PDF bytes are inline while SVG/HTML are downloads; ranges and HEAD retain security headers', async t => {
  const { base, headers, upload } = await httpFixture(t)
  const image = (await (await upload('截图.png', png, 'image/png')).json()).data
  const imageResponse = await fetch(base + image.url, { headers })
  assert.equal(imageResponse.headers.get('content-type'), 'image/png')
  assert.match(imageResponse.headers.get('content-disposition')!, /^inline;/u)
  assert.ok(imageResponse.headers.get('content-disposition')!.includes("filename*=UTF-8''%E6%88%AA%E5%9B%BE.png"))
  assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(imageResponse.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png)
  const download = await fetch(base + image.downloadUrl, { headers })
  assert.match(download.headers.get('content-disposition')!, /^attachment;/u)
  await download.arrayBuffer()
  const document = (await (await upload('paper.pdf', pdf, 'application/pdf')).json()).data
  const range = await fetch(base + document.url, { headers: { ...headers, range: 'bytes=0-7' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${pdf.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pdf.subarray(0, 8))
  const head = await fetch(base + document.url, { method: 'HEAD', headers })
  assert.equal(head.headers.get('content-type'), 'application/pdf')
  assert.equal(head.headers.get('content-length'), String(pdf.length))
  assert.equal(await head.text(), '')
  const badRange = await fetch(base + document.url, { headers: { ...headers, range: 'bytes=1000-2000' } })
  assert.equal(badRange.status, 416)
  for (const [name, bytes, type] of [['evil.svg', '<svg onload="bad()" />', 'image/svg+xml'], ['evil.html', '<script>bad()</script>', 'text/html']] as const) {
    const uploaded = (await (await upload(name, Buffer.from(bytes), type)).json()).data
    const response = await fetch(base + uploaded.url, { headers })
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition')!, /^attachment;/u)
  }
})

test('raw attachment routes bound names, declared lengths and streamed bytes without weakening JSON limits', async t => {
  const { base, headers, upload } = await httpFixture(t, 128)
  assert.equal((await upload('big.bin', Buffer.alloc(129))).status, 413)
  assert.equal((await upload('../escape.png', png)).status, 400)
  assert.equal((await upload('plain.txt', Buffer.from('text'), 'text/plain', { 'content-type': 'text/plain' })).status, 415)
  const malformedName = await fetch(`${base}/jot/api/attachments`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-jot-filename': '%E0%A4%A' }, body: 'x' })
  assert.equal(malformedName.status, 400)
  const streamed = await new Promise<number>((resolve, reject) => {
    const outgoing = nodeRequest(base + '/jot/api/attachments', { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-jot-filename': 'stream.bin', 'transfer-encoding': 'chunked' } }, incoming => {
      incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode!))
    })
    outgoing.on('error', reject)
    outgoing.write(Buffer.alloc(64)); outgoing.end(Buffer.alloc(65))
  })
  assert.equal(streamed, 413)
})

test('export routes authenticate and export the current draft without changing authoritative notes', async t => {
  const { base, headers, store } = await httpFixture(t)
  const draft = { title: '草稿', content: docFromText('Unsaved current draft'), format: 'txt' }
  const exporting = (body: unknown, extra: Record<string, string> = {}) => fetch(base + '/jot/api/export', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  })
  assert.equal((await exporting(draft, { cookie: '' })).status, 401)
  assert.equal((await exporting(draft, { origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await exporting({ ...draft, format: 'html' })).status, 400)
  assert.equal((await exporting({ ...draft, fontDirectory: '/private/path' })).status, 400)
  assert.equal((await exporting({ ...draft, content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'file:///private/file' } }] } })).status, 400)
  const result = await exporting(draft)
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-type')!, /^text\/plain/u)
  assert.match(result.headers.get('content-disposition')!, /^attachment;/u)
  assert.ok(result.headers.get('content-disposition')!.includes("filename*=UTF-8''%E8%8D%89%E7%A8%BF.txt"))
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.ok((await result.text()).includes('Unsaved current draft'))
  assert.equal((await store.readState()).notes.length, 0)
})

test('Markdown export packages managed image bytes instead of a nonportable local URL', async t => {
  const { base, headers, upload } = await httpFixture(t)
  const attachment = (await (await upload('截图.png', png, 'image/png')).json()).data
  const response = await fetch(base + '/jot/api/export', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'With image', format: 'md', content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Draft image' }] },
      { type: 'image', attrs: { attachmentId: attachment.id, alt: 'Screenshot' } },
    ] } }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
  const assetPath = Object.keys(entries).find(path => path.startsWith('assets/'))
  assert.ok(assetPath)
  assert.deepEqual(Buffer.from(entries[assetPath]!), png)
  const markdown = Object.entries(entries).find(([path]) => path.endsWith('.md'))
  assert.ok(markdown)
  assert.ok(strFromU8(markdown[1]).includes('assets/'))
  assert.ok(!strFromU8(markdown[1]).includes('/jot/api'))
})
