import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const placeholder = 'See the package source for license details.'

test('third-party notices cover bundled packages without placeholder or stale license files', async () => {
  const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8')
  const build = await readFile('scripts/build.mjs', 'utf8')
  const packager = await readFile('scripts/package.py', 'utf8')
  const ofl = await readFile('assets/fonts/OFL.txt', 'utf8')
  assert.match(packager, /"LICENSES"/)
  assert.match(packager, /"THIRD_PARTY_NOTICES\.md"/)
  assert.match(packager, /"LICENSE"/)
  assert.ok(ofl.startsWith("Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'."))
  assert.match(notices, /runtime\/data\/\*\.afm/)
  assert.match(notices, /runtime\/data\/sRGB_IEC61966_2_1\.icc/)
  assert.doesNotMatch(notices, /_tanstack_react-virtual/)

  const listed = [...build.matchAll(/\{ name: '([^']+)', version: '([^']+)', license: '([^']+)' \}/g)]
  assert.ok(listed.length >= 40, 'versioned docx prebuilt list lives in scripts/build.mjs')
  const links = [...notices.matchAll(/^- (.+?)@([^ ]+) — \[license\]\(LICENSES\/([^)]+)\)/gm)]
  assert.ok(links.length > listed.length)
  const byId = new Map(links.map(match => [`${match[1]}@${match[2]}`, match[3]]))
  for (const [, name, version] of listed) {
    assert.ok(byId.has(`${name}@${version}`), `notice missing ${name}@${version}`)
  }
  const versions = new Map()
  for (const [, name, version] of links) {
    if (!versions.has(name)) versions.set(name, new Set())
    versions.get(name).add(version)
  }
  const referenced = new Set()
  for (const [, name, version, file] of links) {
    referenced.add(file)
    const text = await readFile(`LICENSES/${file}`, 'utf8')
    assert.equal(text.startsWith(`${name}@${version}\n`), true, file)
    assert.equal(text.includes(placeholder), false, file)
    if (versions.get(name).size > 1) assert.equal(file, `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}@${version}.txt`)
  }
  assert.notEqual(byId.get('base64-js@0.0.8'), byId.get('base64-js@1.5.1'))
  const oldBase64 = await readFile(`LICENSES/${byId.get('base64-js@0.0.8')}`, 'utf8')
  const newBase64 = await readFile(`LICENSES/${byId.get('base64-js@1.5.1')}`, 'utf8')
  assert.match(oldBase64, /Copyright \(c\) 2014\n/)
  assert.match(newBase64, /Jameson Little/)
  assert.doesNotMatch(oldBase64, /Jameson Little/)

  const jszip = await readFile(`LICENSES/${byId.get('jszip@3.10.1')}`, 'utf8')
  assert.match(jszip, /elects the MIT license/)
  assert.match(jszip, /Stuart Knightley/)
  assert.doesNotMatch(jszip, /GNU GENERAL PUBLIC LICENSE/)
  const pako = await readFile(`LICENSES/${byId.get('pako@1.0.11')}`, 'utf8')
  assert.match(pako, /Vitaly Puzrin/)
  assert.match(pako, /Jean-loup Gailly and Mark Adler/)
  const sax = await readFile(`LICENSES/${byId.get('sax@1.2.4')}`, 'utf8')
  assert.match(sax, /License: ISC\n/)
  assert.match(sax, /Isaac Z\. Schlueter/)
  assert.match(sax, /does not apply to this version/)
  assert.notEqual(byId.get('readable-stream@2.3.6'), byId.get('readable-stream@3.6.0'))

  for (const id of ['fontkit@2.0.4', 'dfa@1.2.0', 'brotli@1.3.3']) {
    const text = await readFile(`LICENSES/${byId.get(id)}`, 'utf8')
    assert.match(text, /Devon Govett/)
    assert.equal(text.includes(placeholder), false, id)
  }
  const brotli = await readFile(`LICENSES/${byId.get('brotli@1.3.3')}`, 'utf8')
  assert.match(brotli, /Copyright 2013 Google Inc\./)
  assert.match(brotli, /Apache License/)

  const files = await readdir('LICENSES')
  assert.equal(files.includes('_tanstack_react-virtual.txt'), false)
  for (const file of files) assert.ok(referenced.has(file), `unreferenced LICENSES/${file}`)
})
