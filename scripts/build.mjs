import { build } from 'esbuild'
import { cp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
await mkdir('runtime', { recursive: true })
// Every request is a fresh worker process. Export/import code and its large
// dependencies live in runtime/library.cjs, loaded by `await import('./library.js')`
// only when a request needs it. Both bundles locate assets from their own URL.
const nodeBundle = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: false, metafile: true,
  define: { 'import.meta.url': '__jotModuleUrl' },
  banner: { js: 'const __jotModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
}
// The import() becomes a lazy require: Node's ESM loader would first scan the
// 3 MB CommonJS file for export names, costing about 40 ms per export.
const lazyLibrary = { name: 'jot-lazy-library', setup(build) {
  build.onResolve({ filter: /^\.\/library\.js$/ }, () => ({ path: 'library', namespace: 'jot-library' }))
  build.onLoad({ filter: /.*/, namespace: 'jot-library' }, () => ({ contents: 'module.exports = require("./library.cjs")', loader: 'js' }))
  build.onResolve({ filter: /^\.\/library\.cjs$/, namespace: 'jot-library' }, () => ({ path: './library.cjs', external: true }))
} }
const engine = await build({ ...nodeBundle, entryPoints: ['src/worker.ts'], outfile: 'runtime/worker.cjs', plugins: [lazyLibrary] })
const heavy = Object.keys(engine.metafile.inputs).filter(input => /(?:^|\/)(?:src\/(?:exports|markdown-import)\.ts|node_modules\/(?:pdfkit|fontkit|docx|fflate|markdown-it)\/)/u.test(input))
if (heavy.length) throw new Error(`runtime/worker.cjs must not bundle export/import code: ${heavy.slice(0, 5).join(', ')}`)
const library = await build({ ...nodeBundle, entryPoints: ['src/library.ts'], outfile: 'runtime/library.cjs' })
const pdf = dirname(require.resolve('pdfkit/package.json'))
const inputs = new Set([...Object.keys(engine.metafile.inputs), ...Object.keys(library.metafile.inputs)])
await cp(join(pdf, 'js/data'), 'runtime/data', { recursive: true })
await writeFile('runtime/tools.json', execFileSync(process.execPath, ['runtime/worker.cjs', '--schemas']))
if (!process.argv.includes('--engine-only')) {
  const editor = await build({ entryPoints: ['src/hermes/editor-guest.tsx'], bundle: true, write: false,
    platform: 'browser', format: 'iife', target: 'es2022', minify: true,
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' } })
  const script = editor.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  const hash = createHash('sha256').update(script).digest('base64')
  await writeFile('runtime/editor.html', `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';"><style>html,body{margin:0;padding:0;background:transparent;font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}.jot-top-layer>.jot-overlay-root{pointer-events:auto}.jot-top-layer::backdrop{background:transparent;pointer-events:none}.jot-editor-frame{--jot-body-pad:0px;--jot-table-gutter:20px;padding:0!important;border:0!important;min-width:0!important}</style></head><body><div id="jot-editor-root"></div><script>${script}</script></body></html>`)
  await mkdir('desktop', { recursive: true })
  const result = await build({ entryPoints: ['src/hermes/entry.tsx'], outfile: 'desktop/plugin.js', bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', minify: true,
    external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
    define: { 'process.env.NODE_ENV': '"production"' }, metafile: true,
  })
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/client-metafile.json', JSON.stringify(result.metafile, null, 2))
  for (const input of [...Object.keys(editor.metafile.inputs), ...Object.keys(result.metafile.inputs)]) inputs.add(input)
}
// 未附带 LICENSE 文件的包。值会覆盖 package.json 里的许可证标识；
// 正文在 scripts/license-texts/<name>@<version>.txt。
const licenseFallbacks = new Map([
  ['fontkit@2.0.4', 'MIT'],
  ['dfa@1.2.0', 'MIT'],
  ['brotli@1.3.3', 'MIT AND Apache-2.0'],
])
// 内联在 docx 预构建 dist/index.mjs 里的代码。esbuild 的 metafile 只能看到 docx。
// 版本取自 docx 9.5.1 的 lockfile，且对应文件里确实出现的模块
//（JSZip 自己的包报告 3.10.1；sax 1.2.4 是 ISC，不是后来的 Blue Oak）。
// docx 版本变化时要重新核对 dist/index.mjs，并为每个 id 保留一份许可证正文。
const docxPrebuilt = {
  '9.5.1': [
    { name: 'hash.js', version: '1.1.7', license: 'MIT' },
    { name: 'minimalistic-assert', version: '1.0.1', license: 'ISC' },
    { name: 'inherits', version: '2.0.4', license: 'ISC' },
    { name: 'jszip', version: '3.10.1', license: 'MIT (elected from MIT OR GPL-3.0-or-later)' },
    { name: 'pako', version: '1.0.11', license: '(MIT AND Zlib)' },
    { name: 'lie', version: '3.3.0', license: 'MIT' },
    { name: 'immediate', version: '3.0.6', license: 'MIT' },
    { name: 'setimmediate', version: '1.0.5', license: 'MIT' },
    { name: 'readable-stream', version: '2.3.6', license: 'MIT' },
    { name: 'core-util-is', version: '1.0.3', license: 'MIT' },
    { name: 'isarray', version: '1.0.0', license: 'MIT' },
    { name: 'process-nextick-args', version: '2.0.1', license: 'MIT' },
    { name: 'safe-buffer', version: '5.1.2', license: 'MIT' },
    { name: 'string_decoder', version: '1.1.1', license: 'MIT' },
    { name: 'util-deprecate', version: '1.0.2', license: 'MIT' },
    { name: 'nanoid', version: '5.1.5', license: 'MIT' },
    { name: 'xml', version: '1.0.1', license: 'MIT' },
    { name: 'xml-js', version: '1.6.11', license: 'MIT' },
    { name: 'sax', version: '1.2.4', license: 'ISC' },
    { name: 'events', version: '3.3.0', license: 'MIT' },
    { name: 'stream-browserify', version: '3.0.0', license: 'MIT' },
    { name: 'readable-stream', version: '3.6.0', license: 'MIT' },
    { name: 'buffer', version: '5.7.1', license: 'MIT' },
    { name: 'base64-js', version: '1.5.1', license: 'MIT' },
    { name: 'ieee754', version: '1.2.1', license: 'BSD-3-Clause' },
    { name: 'util', version: '0.12.5', license: 'MIT' },
    { name: 'is-arguments', version: '1.1.1', license: 'MIT' },
    { name: 'call-bind', version: '1.0.7', license: 'MIT' },
    { name: 'es-define-property', version: '1.0.1', license: 'MIT' },
    { name: 'es-errors', version: '1.3.0', license: 'MIT' },
    { name: 'function-bind', version: '1.1.2', license: 'MIT' },
    { name: 'get-intrinsic', version: '1.3.0', license: 'MIT' },
    { name: 'call-bind-apply-helpers', version: '1.0.2', license: 'MIT' },
    { name: 'es-object-atoms', version: '1.1.1', license: 'MIT' },
    { name: 'get-proto', version: '1.0.1', license: 'MIT' },
    { name: 'dunder-proto', version: '1.0.1', license: 'MIT' },
    { name: 'gopd', version: '1.2.0', license: 'MIT' },
    { name: 'has-symbols', version: '1.1.0', license: 'MIT' },
    { name: 'hasown', version: '2.0.2', license: 'MIT' },
    { name: 'math-intrinsics', version: '1.1.0', license: 'MIT' },
    { name: 'set-function-length', version: '1.2.2', license: 'MIT' },
    { name: 'define-data-property', version: '1.1.4', license: 'MIT' },
    { name: 'has-property-descriptors', version: '1.0.2', license: 'MIT' },
    { name: 'has-tostringtag', version: '1.0.2', license: 'MIT' },
    { name: 'is-generator-function', version: '1.0.10', license: 'MIT' },
    { name: 'is-typed-array', version: '1.1.13', license: 'MIT' },
    { name: 'which-typed-array', version: '1.1.15', license: 'MIT' },
    { name: 'available-typed-arrays', version: '1.0.7', license: 'MIT' },
    { name: 'possible-typed-array-names', version: '1.0.0', license: 'MIT' },
    { name: 'for-each', version: '0.3.3', license: 'MIT' },
    { name: 'is-callable', version: '1.2.7', license: 'MIT' },
  ],
}
const licenseFileName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i
const placeholder = 'See the package source for license details.'
const storedLicenseName = (name, version) => `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}@${version}.txt`
async function storedLicense(name, version) {
  try { return await readFile(join('scripts/license-texts', storedLicenseName(name, version)), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const docxBundle = await readFile(join(dirname(require.resolve('docx')), 'index.mjs'), 'utf8')
for (const marker of ['n.version = "3.10.1"', 'function requireSax(', 'let nanoid =', 'e("pako")']) {
  if (!docxBundle.includes(marker)) throw new Error(`docx prebuilt bundle no longer contains ${JSON.stringify(marker)}; update the versioned license list in scripts/build.mjs`)
}
const entries = []
const seen = new Set()
let docxVersion = null
for (const input of inputs) {
  const parts = input.split('/')
  const index = parts.lastIndexOf('node_modules')
  if (index < 0) continue
  const count = parts[index + 1]?.startsWith('@') ? 3 : 2
  const location = parts.slice(0, index + count).join('/')
  const pkg = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'))
  const id = `${pkg.name}@${pkg.version}`
  if (pkg.name === 'docx') docxVersion = pkg.version
  if (seen.has(id)) continue
  seen.add(id)
  const files = (await readdir(location)).filter(name => licenseFileName.test(name))
  const texts = []
  for (const file of files) {
    try { texts.push(`${file}\n${await readFile(join(location, file), 'utf8')}`) } catch { /* license directory; package metadata remains in the notice */ }
  }
  let license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses)
  let body = texts.join('\n\n')
  if (!body) {
    const stored = await storedLicense(pkg.name, pkg.version)
    if (!stored) throw new Error(`No license text for ${id}. Add scripts/license-texts/${storedLicenseName(pkg.name, pkg.version)}`)
    body = stored.trimEnd()
    if (licenseFallbacks.has(id)) license = licenseFallbacks.get(id)
  }
  entries.push({ name: pkg.name, version: pkg.version, license, body, inlined: null })
}
if (!docxVersion) throw new Error('docx was not bundled, so its prebuilt notices were not written')
const prebuilt = docxPrebuilt[docxVersion]
if (!prebuilt) throw new Error(`No versioned prebuilt-license list for docx@${docxVersion} in scripts/build.mjs`)
for (const item of prebuilt) {
  const id = `${item.name}@${item.version}`
  const stored = await storedLicense(item.name, item.version)
  if (!stored) throw new Error(`Missing scripts/license-texts/${storedLicenseName(item.name, item.version)} for ${id} inlined in docx`)
  if (seen.has(id)) continue
  seen.add(id)
  entries.push({ name: item.name, version: item.version, license: item.license, body: stored.trimEnd(), inlined: docxVersion })
}
for (const id of licenseFallbacks.keys()) {
  if (!seen.has(id)) throw new Error(`License fallback ${id} was not used; that package was not in the bundle`)
}
for (const item of prebuilt) {
  if (!seen.has(`${item.name}@${item.version}`)) throw new Error(`Bundled package ${item.name}@${item.version} has no notice`)
}
const versions = new Map()
for (const entry of entries) {
  if (!versions.has(entry.name)) versions.set(entry.name, new Set())
  versions.get(entry.name).add(entry.version)
}
await rm('LICENSES', { recursive: true, force: true })
await mkdir('LICENSES', { recursive: true })
const notices = []
const written = new Set()
for (const entry of entries) {
  const safe = entry.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = versions.get(entry.name).size > 1 ? `${safe}@${entry.version}.txt` : `${safe}.txt`
  const tail = entry.inlined ? `Inlined in: docx@${entry.inlined} prebuilt distribution\n\n` : '\n'
  const text = `${entry.name}@${entry.version}\nLicense: ${entry.license}\nSource: https://www.npmjs.com/package/${entry.name}\n${tail}${entry.body}\n`
  if (text.includes(placeholder)) throw new Error(`Refusing placeholder license text for ${entry.name}@${entry.version}`)
  await writeFile(join('LICENSES', file), text)
  written.add(file)
  notices.push(`- ${entry.name}@${entry.version} — [license](LICENSES/${file})`)
}
const noticeBody = [...notices].sort().join('\n')
const noticeText = '# Third-party notices\n\nThe compiled editor and note engine include these dependencies. Hermes supplies the React singleton for the host-facing UI; the isolated editor includes its own React runtime. Packages inlined in docx\'s prebuilt file, which esbuild\'s metafile cannot see, are included here and tagged in their license files.\n\n' + noticeBody + '\n\npdfkit\'s Adobe Core 14 AFM metric files are shipped in `runtime/data/*.afm` with their copyright comments intact, along with the ICC sRGB profile `runtime/data/sRGB_IEC61966_2_1.icc` (Copyright International Color Consortium, 2015).\n\nOffline PDF fonts: [SIL Open Font License](assets/fonts/OFL.txt). Original Jot source: [MIT](LICENSE), provenance in [UPSTREAM.json](UPSTREAM.json).\n'
if (!noticeText.includes('runtime/data/*.afm') || !noticeText.includes('runtime/data/sRGB_IEC61966_2_1.icc')) throw new Error('Third-party notices are missing the pdfkit AFM or ICC line')
const ofl = await readFile('assets/fonts/OFL.txt', 'utf8')
if (!ofl.startsWith("Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.")) throw new Error('assets/fonts/OFL.txt is missing the Adobe copyright line')
const licenseFiles = new Set(await readdir('LICENSES'))
for (const file of licenseFiles) {
  if (!written.has(file)) throw new Error(`Stale license file LICENSES/${file}`)
  if ((await readFile(join('LICENSES', file), 'utf8')).includes(placeholder)) throw new Error(`Placeholder license text in LICENSES/${file}`)
}
await writeFile('THIRD_PARTY_NOTICES.md', noticeText)
const sourceFiles = [...inputs].filter(name => name.startsWith('src/'))
sourceFiles.push('package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs',
  '__init__.py', 'backend.py', 'native_open.py', 'plugin.yaml', 'dashboard/plugin_api.py', 'dashboard/manifest.json')
const fingerprints = {}
for (const name of sourceFiles.sort()) fingerprints[name] = createHash('sha256').update(await readFile(name)).digest('hex')
await writeFile('runtime/build-info.json', JSON.stringify({ fullBuild: !process.argv.includes('--engine-only'), inputs: fingerprints }, null, 2) + '\n')
console.log('Built Jot note engine' + (process.argv.includes('--engine-only') ? '' : ' and Hermes Desktop plugin') + '.')
