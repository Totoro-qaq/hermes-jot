// Exercise the compiled ESM without CommonJS globals, as Hermes' loader does.
// This checks module evaluation and registration, not rendering or native UI.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

const atom = value => ({ get: () => value, subscribe: () => () => {} })
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

/** A gateway event subscription that records whether it is still live. */
const eventSource = () => {
  const subscriptions = []
  return {
    subscriptions,
    onEvent(type, listener) {
      const subscription = { type, listener, live: true }
      subscriptions.push(subscription)
      return () => { subscription.live = false }
    },
  }
}

// Current hosts offer ctx.onEvent, host.onEvent and host.composer; older ones
// offer none of them, and Jot must still register and fall back to polling.
const NOTES_CHANGED = 'plugin.jot.notes.changed'
const scenarios = [
  { name: 'ctx.onEvent', ctx: eventSource(), host: eventSource(), composer: true },
  { name: 'host.onEvent only', host: eventSource() },
  { name: 'no event stream' },
]
for (const scenario of scenarios) {
  const contributions = []
  const disposals = []
  delete sdk.host.onEvent
  delete sdk.host.composer
  if (scenario.host) sdk.host.onEvent = scenario.host.onEvent
  if (scenario.composer) sdk.host.composer = { insertText: async () => true }
  plugin.register({
    register: item => contributions.push(item),
    registerMany: items => contributions.push(...items),
    onDispose: fn => disposals.push(fn), addEventListener() {},
    ...(scenario.ctx ? { onEvent: scenario.ctx.onEvent, os: { writeClipboard: async () => true, openExternal: async () => true } } : {}),
    storage: { get: (_key, fallback) => fallback, set() {}, remove() {} },
  })
  assert.deepEqual(contributions.filter(item => item.area === 'keybinds').map(item => item.data.id).sort(),
    ['jot.capture', 'jot.new-note', 'jot.open'], scenario.name)
  assert.ok(contributions.filter(item => item.area === 'keybinds').every(item => item.data.category === 'view'))
  assert.ok(contributions.some(item => item.area === 'panes'))
  assert.ok(contributions.some(item => item.area === 'routes'))
  // Exactly one subscription, on the plugin-scoped door when the host has it.
  const subscribed = scenario.ctx?.subscriptions.length ? scenario.ctx : scenario.host
  if (subscribed) {
    assert.deepEqual(subscribed.subscriptions.map(item => item.type), [NOTES_CHANGED], scenario.name)
    if (scenario.ctx) assert.equal(scenario.host.subscriptions.length, 0, 'host.onEvent is only a fallback')
    subscribed.subscriptions[0].listener({ type: NOTES_CHANGED, payload: {}, session_id: '' })
  }
  for (const dispose of disposals.reverse()) dispose()
  if (subscribed) assert.equal(subscribed.subscriptions[0].live, false, `${scenario.name}: disposed with the plugin`)
}
console.log('PASS compiled Desktop module: ESM evaluation, public imports, entry points, three keybindings and notes.changed subscription with and without host events')
