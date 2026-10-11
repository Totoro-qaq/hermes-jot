import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const placeholder = 'See the package source for license details.'

test('generated notices retain licenses for vendored SVG icons', async () => {
  const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8')
  const license = await readFile('LICENSES/lucide.txt', 'utf8')
  assert.match(notices, /lucide@0\.292\.0 — \[license\]\(LICENSES\/lucide\.txt\)/)
  assert.match(license, /License: ISC AND MIT/)
  assert.match(license, /Vendored in: Inline SVG icon paths in src\/client\/icons\.tsx/)
  assert.match(license, /Lucide Contributors 2022/)
  assert.match(license, /Cole Bemis/)
  assert.match(license, /ISC License/)
  assert.match(license, /MIT License/)
  assert.match(license, /feathericons\/feather\/v4\.29\.0\/LICENSE/)
})

test('versioned license sources are included in build fingerprints', async () => {
  const build = JSON.parse(await readFile('runtime/build-info.json', 'utf8'))
  const sources = (await readdir('scripts/license-texts')).filter(name => name.endsWith('.txt'))
  assert.ok(sources.length > 0)
  for (const source of sources) {
    const name = `scripts/license-texts/${source}`
    const hash = createHash('sha256').update(await readFile(name)).digest('hex')
    assert.equal(build.inputs[name], hash, `missing or stale build fingerprint for ${name}`)
  }
})

test('packaging rejects license source changes after the last build', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const packager = resolve('scripts/package.py')
  const layout = JSON.parse(execFileSync(python, ['-c',
    'import json, runpy, sys; p = runpy.run_path(sys.argv[1]); print(json.dumps({k: p[k] for k in ("ALLOWED_FILES", "DOCS", "REQUIRED")}))',
    packager], { encoding: 'utf8' })) as { ALLOWED_FILES: string[], DOCS: string[], REQUIRED: string[] }
  const fixture = await mkdtemp(join(tmpdir(), 'jot-license-freshness-'))
  try {
    const paths = new Set([...layout.ALLOWED_FILES, ...layout.DOCS.map(name => `docs/${name}`),
      ...layout.REQUIRED, 'scripts/package.py'])
    for (const path of paths) {
      const target = join(fixture, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'Fixture content\n')
    }
    await writeFile(join(fixture, 'scripts/package.py'), await readFile(packager))
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ version: '0.0.0' }))
    const source = 'scripts/license-texts/fontkit@2.0.4.txt'
    const license = await readFile(source)
    const build = JSON.parse(await readFile('runtime/build-info.json', 'utf8'))
    assert.equal(build.inputs[source], createHash('sha256').update(license).digest('hex'))
    await mkdir(dirname(join(fixture, source)), { recursive: true })
    await writeFile(join(fixture, source), license)
    await writeFile(join(fixture, 'runtime/build-info.json'), JSON.stringify({
      fullBuild: true, inputs: { [source]: build.inputs[source] },
    }))
    const pack = () => spawnSync(python, ['scripts/package.py'], { cwd: fixture, encoding: 'utf8' })
    const fresh = pack()
    assert.equal(fresh.status, 0, fresh.stderr)
    await writeFile(join(fixture, source), Buffer.concat([license, Buffer.from('\nUpdated license source\n')]))
    const stale = pack()
    assert.equal(stale.status, 1, stale.stderr)
    assert.match(stale.stderr, /Source changed after the last build: scripts\/license-texts\/fontkit@2\.0\.4\.txt/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

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
