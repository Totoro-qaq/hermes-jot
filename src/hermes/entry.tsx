import { useEffect, useMemo, useSyncExternalStore } from 'react'
import * as sdk from '@hermes/plugin-sdk'
import type { HermesPlugin, PluginContext, KeybindContribution } from '@hermes/plugin-sdk'
import { JotApp } from '../client/App.js'
import { JotIcon } from '../client/JotIcon.js'
import { readCommandSelection, JOT_COMMANDS } from '../client/commands.js'
import { createControllers } from './controllers.js'
import { createHermesApi } from './api.js'
import { createPersistence } from './persistence.js'

const { host, useValue, useI18n, captureGatewayFileDownload, MessageTextContent } = sdk

const theme = `
.jot-host,.jot-top-layer{
 --dsw-alias-bg-layer-1:var(--ui-bg-editor);--dsw-alias-bg-base:var(--ui-bg-primary);
 --dsw-alias-label-primary:var(--ui-text-primary);--dsw-alias-label-secondary:var(--ui-text-secondary);
 --dsw-alias-border-l3:var(--ui-stroke-secondary);--dsw-alias-border-l2:var(--ui-stroke-primary);
 --dsw-alias-interactive-bg-hover:var(--ui-control-hover-background);
 --dsw-static-blue-450:var(--ui-accent);--dsw-alias-state-business-primary:var(--ui-accent);
 --dsw-font-s-14:400 .8125rem/1.5 var(--font-sans,system-ui);--dsw-font-s-strong-14:600 .8125rem/1.5 var(--font-sans,system-ui);
 --dsw-font-xs-13:400 .75rem/1.5 var(--font-sans,system-ui);--dsw-font-xs-12:400 .6875rem/1.5 var(--font-sans,system-ui);
 --dsw-alias-state-error-primary:var(--ui-red);--dsw-font-family-mono:var(--font-mono,monospace);
}
.jot-host{height:100%;min-height:0;min-width:0;overflow:hidden;display:flex;flex-direction:column;font:var(--dsw-font-s-14);color:var(--ui-text-primary)}
.jot-host>.jot-app{flex:1;min-height:0;height:100%;background:var(--ui-bg-editor)}
.jot-top-layer>.jot-overlay-root{pointer-events:auto}
.jot-top-layer::backdrop{background:transparent;pointer-events:none}
.jot-host .jot-app,.jot-top-layer .jot-overlay-root{color-scheme:inherit}
.jot-host .jot-entry-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;background:transparent;color:inherit;padding:5px;cursor:pointer}
.jot-native-preview{width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:8px 12px;background:var(--ui-bg-secondary)}
`

const ownerNow = () => JSON.stringify([host.state.connectionId.get() ?? 'local', host.state.profile.get()])

export default {
  id: 'jot', name: 'Jot · 随记',
  description: 'Notes, checklists and documents, shared with your agent when you choose.',
  defaultEnabled: false,
  register(ctx: PluginContext) {
    if (typeof sdk.SandboxedFrame !== 'function' || typeof sdk.captureGatewayFileDownload !== 'function'
        || typeof sdk.useTheme !== 'function' || !host.state.connectionId || typeof host.revealPane !== 'function'
        || typeof host.paneVisibility !== 'function') {
      throw new Error('Jot requires a recent Hermes Desktop SDK with SandboxedFrame and gateway file downloads. Update Hermes Desktop, then enable Jot again.')
    }
    const controls = createControllers(() => host.navigate('/jot'))
    const changed = () => controls.retainOwner(ownerNow())
    const stopProfile = host.state.profile.subscribe(changed)
    const stopConnection = host.state.connectionId.subscribe(changed)
    ctx.addEventListener(document, 'selectionchange', () => {
      if (document.getSelection()?.toString()) controls.forOwner(ownerNow()).clearSelection()
    })
    const readSelection = (owner = ownerNow()) => {
      const target = document.activeElement as HTMLElement | null
      if (target instanceof HTMLInputElement && target.type === 'password') return ''
      return controls.forOwner(owner).selectedText || readCommandSelection(target)
    }
    const apis = new Set<ReturnType<typeof createHermesApi>>()
    const open = (action: 'open' | 'new' | 'capture' = 'open', text?: string, requestedTarget?: 'compact' | 'wide') => {
      const { bus, recipient } = controls.forOwner(ownerNow())
      const target = requestedTarget ?? (host.state.activeSessionId.get() ? 'compact' : 'wide')
      if (action !== 'open') bus.send({ action, target, text, ...(target === 'compact' ? { recipient } : {}) })
      if (target === 'compact') host.revealPane('jot:notes')
      else host.navigate('/jot')
    }
    function Content({ mode, owner }: { mode: 'wide' | 'compact'; owner: string }) {
      const controller = controls.forOwner(owner)
      const { bus, recipient, handoff } = controller
      const selectionId = useMemo(() => crypto.randomUUID(), [])
      const { locale } = useI18n()
      const api = useMemo(() => {
        const value = createHermesApi(ctx, () => ownerNow() === owner, captureGatewayFileDownload)
        apis.add(value)
        return value
      }, [owner])
      const persistence = useMemo(() => createPersistence(owner, {
        getItem: key => ctx.storage.get<string | null>(key, null),
        setItem: (key, value) => ctx.storage.set(key, value), removeItem: key => ctx.storage.remove(key),
      }), [owner])
      useEffect(() => () => { api.dispose(); apis.delete(api) }, [api])
      const command = useSyncExternalStore(bus.subscribe, () => bus.snapshotFor(mode, mode === 'compact' ? recipient : undefined))
      const request = useSyncExternalStore(handoff.subscribe, handoff.getSnapshot)
      return <div className="jot-host"><style>{theme}</style><JotApp mode={mode} locale={locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'}
        api={api} persistence={persistence} onExpand={(...args) => { if (ownerNow() === owner) handoff.open(...args) }}
        readSelectedText={() => ownerNow() === owner ? readSelection(owner) : ''}
        onEditorSelection={text => { if (!recipient.signal.aborted) controller.select(selectionId, text) }}
        openNoteRequest={mode === 'wide' ? request : undefined} onNoteRequestHandled={handoff.acknowledge}
        commandRequest={command} onCommandClaim={revision => bus.claim(revision, mode, mode === 'compact' ? recipient : undefined)}
        onCommandHandled={bus.acknowledge}
        attachmentPreviewContent={attachment => attachment.path ? <div className="jot-native-preview">
          <MessageTextContent text={`::preview{file=${JSON.stringify(attachment.path)}}`} />
        </div> : null} />
      </div>
    }
    function Surface({ mode }: { mode: 'wide' | 'compact' }) {
      const profile = useValue(host.state.profile)
      const connection = useValue(host.state.connectionId)
      const owner = JSON.stringify([connection ?? 'local', profile])
      return <Content key={owner} owner={owner} mode={mode} />
    }
    function SidePanel() {
      const visibility = useMemo(() => host.paneVisibility('jot:notes'), [])
      const visible = useValue(visibility)
      return visible ? <Surface mode="compact" /> : null
    }
    function ComposerButton() {
      const { locale } = useI18n()
      return <button type="button" title={locale.startsWith('zh') ? '打开随记' : 'Open Jot'}
        aria-label={locale.startsWith('zh') ? '打开随记' : 'Open Jot'}
        style={{ border: 0, background: 'transparent', padding: 5, borderRadius: 6, cursor: 'pointer' }}
        onClick={() => open('open', undefined, 'compact')}><JotIcon size={19} /></button>
    }
    ctx.registerMany([
      { id: 'page', area: 'routes', title: 'Jot · 随记', data: { path: '/jot' }, render: () => <Surface mode="wide" /> },
      { id: 'nav', area: 'sidebar.nav', order: 40, data: { path: '/jot', label: 'Jot · 随记', codicon: 'notebook' } },
      { id: 'notes', area: 'panes', title: 'Jot · 随记', data: { placement: 'right', width: '420px',
        hideOnly: true, tabLead: () => <JotIcon size={15} /> }, render: () => <SidePanel /> },
      { id: 'composer', area: 'composer.actions', order: 30, render: () => <ComposerButton /> },
      { id: 'slash', area: 'composer.middleware', data: { handler: async (draft: { text: string; attachments?: unknown[] }) => {
        const text = draft.text.trim()
        if (!/^\/jot(?:\s+(?:new|capture))?$/i.test(text)) return draft
        const owner = ownerNow()
        try {
          if (!(await ctx.rest<{ ready: boolean }>('/health')).ready) throw new Error('Jot needs a complete local build.')
        } catch {
          host.notifyError('Enable the Jot backend in Hermes Plugins, then try again. / 请先启用随记后端。')
          return null
        }
        if (ownerNow() !== owner) return null
        open(/\snew$/i.test(text) ? 'new' : /\scapture$/i.test(text) ? 'capture' : 'open', undefined, 'compact')
        // A draft carrying attachments is kept intact. For a bare command the
        // registered Python handler lets the host own normal draft consumption.
        return draft.attachments?.length ? null : draft
      } } },
    ])
    for (const item of JOT_COMMANDS) {
      const run = () => open(item.action, item.action === 'capture' ? readSelection() : undefined)
      ctx.register({ id: `palette-${item.action}`, area: 'palette', data: {
        id: item.id, action: item.id, label: `${item.en} / ${item.zh}`, keywords: ['jot', '随记', 'notes', '笔记'], run,
      } })
      ctx.register({ id: `key-${item.action}`, area: 'keybinds', data: {
        id: item.id, label: `${item.en} / ${item.zh}`, category: 'view', defaults: [], run,
      } satisfies KeybindContribution })
    }
    ctx.onDispose(() => { stopProfile(); stopConnection(); controls.dispose(); for (const api of apis) api.dispose(); apis.clear() })
  },
} satisfies HermesPlugin
