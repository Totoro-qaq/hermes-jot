import { build } from 'esbuild'
import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
await mkdir('runtime', { recursive: true })
const engine = await build({ entryPoints: ['src/worker.ts'], outfile: 'runtime/worker.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', minify: false,
  metafile: true,
  define: { 'import.meta.url': '__jotModuleUrl' },
  banner: { js: 'const __jotModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
})
const pdf = dirname(require.resolve('pdfkit/package.json'))
const inputs = new Set(Object.keys(engine.metafile.inputs))
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
await mkdir('LICENSES', { recursive: true })
const notices = new Map()
for (const input of inputs) {
  const parts = input.split('/')
  const index = parts.lastIndexOf('node_modules')
  if (index < 0) continue
  const count = parts[index + 1]?.startsWith('@') ? 3 : 2
  const location = parts.slice(0, index + count).join('/')
  if (notices.has(location)) continue
  const pkg = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'))
  const files = (await readdir(location)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name))
  const texts = []
  for (const file of files) {
    try { texts.push(`${file}\n${await readFile(join(location, file), 'utf8')}`) } catch { /* license directory; package metadata remains in the notice */ }
  }
  const name = pkg.name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt'
  await writeFile(join('LICENSES', name), `${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses)}\nSource: https://www.npmjs.com/package/${pkg.name}\n\n${texts.join('\n\n') || 'See the package source for license details.'}\n`)
  notices.set(location, `- ${pkg.name}@${pkg.version} — [license](LICENSES/${name})`)
}
await writeFile('THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nThe compiled editor and note engine include these dependencies. Hermes supplies the React singleton for the host-facing UI; the isolated editor includes its own React runtime.\n\n' + [...notices.values()].sort().join('\n') + '\n\nOffline PDF fonts: [SIL Open Font License](assets/fonts/OFL.txt). Original Jot source: [MIT](LICENSE), provenance in [UPSTREAM.json](UPSTREAM.json).\n')
const sourceFiles = [...inputs].filter(name => name.startsWith('src/'))
sourceFiles.push('package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs',
  '__init__.py', 'backend.py', 'native_open.py', 'plugin.yaml', 'dashboard/plugin_api.py', 'dashboard/manifest.json')
const fingerprints = {}
for (const name of sourceFiles.sort()) fingerprints[name] = createHash('sha256').update(await readFile(name)).digest('hex')
await writeFile('runtime/build-info.json', JSON.stringify({ fullBuild: !process.argv.includes('--engine-only'), inputs: fingerprints }, null, 2) + '\n')
console.log('Built Jot note engine' + (process.argv.includes('--engine-only') ? '' : ' and Hermes Desktop plugin') + '.')
