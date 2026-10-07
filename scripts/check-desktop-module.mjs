// Exercise the compiled ESM without CommonJS globals, as Hermes' loader does.
// This checks module evaluation and registration, not rendering or native UI.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

const atom = value => ({ get: () => value, subscribe: () => () => {} })
const contributions = []
const disposals = []
const sdk = {
  host: {
    state: { connectionId: atom(null), profile: atom('default'), activeSessionId: atom(null) },
    navigate() {}, revealPane() {}, paneVisibility: () => atom(false), notify() {}, notifyError() {},
  },
  useValue: value => value.get(),
  useTheme: () => ({ resolvedMode: 'light' }),
  captureGatewayFileDownload: () => async () => {},
  MessageTextContent: () => null,
  SandboxedFrame: () => null,
}
const context = vm.createContext({ console, crypto, AbortController, EventTarget, setTimeout, clearTimeout,
  document: new EventTarget() })
const modules = new Map(Object.entries({ react: React, 'react/jsx-runtime': jsx, '@hermes/plugin-sdk': sdk })
  .map(([name, exports]) => [name, new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  }, { context, identifier: name })]))
const module = new vm.SourceTextModule(await readFile('desktop/plugin.js', 'utf8'), { context })
await module.link(name => {
  assert.ok(modules.has(name), `Unsupported host import: ${name}`)
  return modules.get(name)
})
await module.evaluate()
const plugin = module.namespace.default
assert.equal(plugin.id, 'jot')
plugin.register({
  register: item => contributions.push(item),
  registerMany: items => contributions.push(...items),
  onDispose: fn => disposals.push(fn), addEventListener() {},
  storage: { get: (_key, fallback) => fallback, set() {}, remove() {} },
})
assert.deepEqual(contributions.filter(item => item.area === 'keybinds').map(item => item.data.id).sort(),
  ['jot.capture', 'jot.new-note', 'jot.open'])
assert.ok(contributions.filter(item => item.area === 'keybinds').every(item => item.data.category === 'view'))
assert.ok(contributions.some(item => item.area === 'panes'))
assert.ok(contributions.some(item => item.area === 'routes'))
for (const dispose of disposals.reverse()) dispose()
console.log('PASS compiled Desktop module: ESM evaluation, public imports, entry points and three keybindings')
