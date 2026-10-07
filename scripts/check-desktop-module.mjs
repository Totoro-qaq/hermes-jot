// Exercise the compiled ESM without CommonJS globals, as Hermes' loader does.
// This checks module evaluation and registration, not rendering or native UI
// (only the small host-facing labels are rendered, to check their language).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const source = await readFile('desktop/plugin.js', 'utf8')
const atom = value => ({ get: () => value, subscribe: () => () => {} })
const createSdk = (extra = {}) => ({
  host: {
    state: { connectionId: atom(null), profile: atom('default'), activeSessionId: atom(null) },
    navigate() {}, revealPane() {}, paneVisibility: () => atom(false), notify() {}, notifyError() {},
  },
  useValue: value => value.get(),
  useTheme: () => ({ resolvedMode: 'light' }),
  captureGatewayFileDownload: () => async () => {},
  MessageTextContent: () => null,
  SandboxedFrame: () => null,
  ...extra,
})

/** Link and evaluate a fresh copy of the bundle against one SDK shape (exports are fixed at link time). */
async function loadPlugin(sdk) {
  const context = vm.createContext({ console, crypto, AbortController, EventTarget, setTimeout, clearTimeout,
    document: new EventTarget() })
  const modules = new Map(Object.entries({ react: React, 'react/jsx-runtime': jsx, '@hermes/plugin-sdk': sdk })
    .map(([name, exports]) => [name, new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context, identifier: name })]))
  const module = new vm.SourceTextModule(source, { context })
  await module.link(name => {
    assert.ok(modules.has(name), `Unsupported host import: ${name}`)
    return modules.get(name)
  })
  await module.evaluate()
  const plugin = module.namespace.default
  assert.equal(plugin.id, 'jot')
  return plugin
}

/** A plugin context that records contributions; a re-registration replaces an id, as Hermes' registry does. */
function pluginContext(extra = {}) {
  const contributions = []
  const disposals = []
  const ctx = {
    register: item => { contributions.push(item); return () => {} },
    registerMany: items => { contributions.push(...items); return () => {} },
    onDispose: fn => disposals.push(fn), addEventListener() {},
    storage: { get: (_key, fallback) => fallback, set() {}, remove() {} },
    ...extra,
  }
  const latest = () => new Map(contributions.map(item => [`${item.area}:${item.id}`, item]))
  return { ctx, contributions, disposals, latest }
}

/** Hermes' ctx.i18n: the active locale's bundle, then the plugin's English bundle, then the key. */
function hostI18n(locale, { events = true, translate = true } = {}) {
  const bundles = new Map()
  const listeners = new Set()
  return {
    i18n: {
      register(next) { for (const [id, messages] of Object.entries(next)) bundles.set(id, { ...bundles.get(id), ...messages }); return () => {} },
      ...translate ? { t: key => bundles.get(locale)?.[key] ?? bundles.get('en')?.[key] ?? key } : {},
      ...events ? { onLocaleChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } } : {},
    },
    switchTo(next) { locale = next; for (const listener of [...listeners]) listener() },
    get listeners() { return listeners.size },
  }
}

const labelsOf = latest => ({
  route: latest.get('routes:page').title,
  nav: latest.get('sidebar.nav:nav').data.label,
  pane: latest.get('panes:notes').title,
  palette: ['jot.open', 'jot.new-note', 'jot.capture'].map(id => [...latest.values()].find(item => item.area === 'palette' && item.data.id === id).data.label),
  keybinds: ['jot.open', 'jot.new-note', 'jot.capture'].map(id => [...latest.values()].find(item => item.area === 'keybinds' && item.data.id === id).data.label),
})
const render = element => renderToStaticMarkup(element)

const sdk = createSdk()
const plugin = await loadPlugin(sdk)

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
  delete sdk.host.onEvent
  delete sdk.host.composer
  if (scenario.host) sdk.host.onEvent = scenario.host.onEvent
  if (scenario.composer) sdk.host.composer = { insertText: async () => true }
  const { ctx, contributions, disposals } = pluginContext(scenario.ctx
    ? { onEvent: scenario.ctx.onEvent, os: { writeClipboard: async () => true, openExternal: async () => true } } : {})
  plugin.register(ctx)
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

// Language. Without ctx.i18n or useI18n (older hosts) every label is English.
{
  const { ctx, latest, disposals } = pluginContext()
  plugin.register(ctx)
  assert.deepEqual(labelsOf(latest()), { route: 'Jot', nav: 'Jot', pane: 'Jot',
    palette: ['Jot: Open Jot', 'Jot: New note', 'Jot: Capture selected text'],
    keybinds: ['Jot: Open Jot', 'Jot: New note', 'Jot: Capture selected text'] }, 'older host')
  assert.match(render(latest().get('composer.actions:composer').render()), /title="Open Jot"/u)
  assert.equal(render(latest().get('panes:notes').data.tabTitle()), 'Jot')
  for (const dispose of disposals.reverse()) dispose()
}
// ctx.i18n.register alone (the first i18n hosts) cannot be read back: English.
{
  const { i18n } = hostI18n('zh', { translate: false, events: false })
  const { ctx, latest } = pluginContext({ i18n })
  plugin.register(ctx)
  assert.equal(labelsOf(latest()).palette[0], 'Jot: Open Jot', 'register without t')
}
// ctx.i18n.t without onLocaleChange: labels follow the language at registration.
{
  const { i18n } = hostI18n('fr', { events: false })
  const { ctx, latest } = pluginContext({ i18n })
  plugin.register(ctx)
  assert.equal(labelsOf(latest()).palette[1], 'Jot\u00a0: Nouvelle note')
  assert.match(render(latest().get('composer.actions:composer').render()), /title="Ouvrir Jot"/u, 'React falls back to ctx.i18n')
}
// Current hosts: labels start in the Hermes language and are registered again on a switch.
{
  const host = hostI18n('zh')
  const notices = []
  sdk.host.notifyError = message => notices.push(message)
  const { ctx, latest, contributions, disposals } = pluginContext({ i18n: host.i18n,
    rest: async () => { throw new Error('backend off') } })
  plugin.register(ctx)
  assert.deepEqual(labelsOf(latest()), { route: '随记', nav: '随记', pane: '随记',
    palette: ['随记：打开随记', '随记：新建笔记', '随记：摘录选中的文字'],
    keybinds: ['随记：打开随记', '随记：新建笔记', '随记：摘录选中的文字'] }, 'Chinese host')
  const page = latest().get('routes:page').render
  const before = contributions.length
  host.switchTo('ja')
  assert.ok(contributions.length > before, 'labels re-register on a locale change')
  const after = latest()
  assert.deepEqual(labelsOf(after), { route: 'Jot', nav: 'Jot', pane: '随记',
    palette: ['Jot：Jot を開く', 'Jot：新しいノート', 'Jot：選択したテキストを取り込む'],
    keybinds: ['Jot：Jot を開く', 'Jot：新しいノート', 'Jot：選択したテキストを取り込む'] }, 'after switching to Japanese')
  assert.equal(after.get('routes:page').render, page, 'the open page keeps its component, so it stays mounted')
  assert.equal(after.get('panes:notes').data.tabTitleText(), 'Jot', 'the pane tab follows through tabTitleText')
  assert.ok(after.get('palette:palette-open').data.keywords.includes('ノート'))
  const count = contributions.length
  host.switchTo('pl')
  host.switchTo('en')
  assert.equal(contributions.length, count + latestLabelCount(after), 'a Hermes-only language shows English once, then nothing changes')
  host.switchTo('ar')
  const handler = latest().get('composer.middleware:slash').data.handler
  assert.equal(await handler({ text: '/jot' }), null)
  assert.deepEqual(notices, ['فعّل الواجهة الخلفية لـ Jot في إضافات Hermes، ثم أعد المحاولة.'])
  for (const dispose of disposals.reverse()) dispose()
  assert.equal(host.listeners, 0, 'locale listeners end with the plugin')
  sdk.host.notifyError = () => {}
}
function latestLabelCount(latest) {
  return [...latest.values()].filter(item => ['routes', 'sidebar.nav', 'palette', 'keybinds'].includes(item.area)).length
}

// With useI18n, React surfaces follow Hermes' live language directly.
{
  let live = 'de'
  const withHook = await loadPlugin(createSdk({ useI18n: () => ({ locale: live }) }))
  const { ctx, latest } = pluginContext({ i18n: hostI18n('en').i18n })
  withHook.register(ctx)
  assert.match(render(latest().get('composer.actions:composer').render()), /title="Jot öffnen"/u)
  live = 'zh-hant'
  assert.equal(render(latest().get('panes:notes').data.tabTitle()), '隨記')
}
console.log('PASS compiled Desktop module: ESM evaluation, public imports, entry points, three keybindings, notes.changed subscription with and without host events, and labels in the Hermes language with and without ctx.i18n, onLocaleChange and useI18n')
