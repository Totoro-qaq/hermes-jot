import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import * as sdk from '@hermes/plugin-sdk'
import type { HermesPlugin, PluginContext, KeybindContribution } from '@hermes/plugin-sdk'
import { JotApp } from '../client/App.js'
import { JotIcon } from '../client/JotIcon.js'
import { readCommandSelection, JOT_COMMANDS } from '../client/commands.js'
import { createChangeEmitter } from '../client/live-refresh.js'
import { askAgentReference, deliverAskAgent, type AskAgentNote } from '../client/ask-agent.js'
import { createControllers } from './controllers.js'
import { createHermesApi } from './api.js'
import { createPersistence } from './persistence.js'
import { createHostLocale, hostLabels } from './host-locale.js'
import { normalizeLocale, type JotLocale } from '../client/i18n.js'
import { hostThemeCss } from './theme.js'

const { host, useValue, captureGatewayFileDownload, MessageTextContent } = sdk
/** Hermes' live interface language for React; absent on older hosts. */
const useHostI18n = typeof sdk.useI18n === 'function' ? sdk.useI18n : undefined

const theme = `
${hostThemeCss}
.jot-host{height:100%;min-height:0;min-width:0;overflow:hidden;display:flex;flex-direction:column;font:var(--dsw-font-s-14);color:var(--ui-text-primary)}
.jot-host>.jot-app{flex:1;min-height:0;height:100%;background:var(--ui-editor-surface-background,var(--ui-bg-editor))}
.jot-top-layer>.jot-overlay-root{pointer-events:auto}
.jot-top-layer::backdrop{background:transparent;pointer-events:none}
.jot-host .jot-app,.jot-top-layer .jot-overlay-root{color-scheme:inherit}
.jot-host .jot-entry-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:6px;background:transparent;color:inherit;padding:5px;cursor:pointer}
.jot-native-preview{width:100%;border:1px solid var(--ui-stroke-secondary);border-radius:8px;padding:8px 12px;background:var(--ui-bg-secondary)}
`

/** Broadcast by the Python side after every note mutation. */
const NOTES_CHANGED = 'plugin.jot.notes.changed'
const ownerNow = () => JSON.stringify([host.state.connectionId.get() ?? 'local', host.state.profile.get()])

export default {
  id: 'jot', name: 'Jot',
  description: 'Notes, checklists and documents, shared with your agent when you choose.',
  defaultEnabled: false,
  register(ctx: PluginContext) {
    // Jot follows the Hermes language and never changes it. React reads it live with
    // useI18n; text Hermes samples at registration is re-registered when it changes.
    const hostLocale = createHostLocale(ctx.i18n)
    if (typeof sdk.SandboxedFrame !== 'function' || typeof sdk.captureGatewayFileDownload !== 'function'
        || typeof sdk.useTheme !== 'function' || !host.state.connectionId || typeof host.revealPane !== 'function'
        || typeof host.paneVisibility !== 'function') {
      // Hermes shows this message to the person, so it is in their language.
      const message = hostLabels(hostLocale.getSnapshot()).outdated
      hostLocale.dispose()
      throw new Error(message)
    }
    function useJotLocale(): JotLocale {
      const registered = useSyncExternalStore(hostLocale.subscribe, hostLocale.getSnapshot, hostLocale.getSnapshot)
      const live = useHostI18n?.().locale
      return typeof live === 'string' ? normalizeLocale(live) : registered
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
    // One host subscription feeds every mounted panel. Hosts without the event
    // stream leave changeSignal undefined, and panels keep their short poll.
    const changes = createChangeEmitter()
    const notesChanged = () => changes.emit()
    const stopEvents = ctx.onEvent?.(NOTES_CHANGED, notesChanged) ?? host.onEvent?.(NOTES_CHANGED, notesChanged)
    const changeSignal = stopEvents ? changes : undefined
    const askAgent = (note: AskAgentNote) => {
      const composer = host.composer
      return deliverAskAgent(askAgentReference(note), {
        insert: typeof composer?.insertText === 'function' ? text => composer.insertText(null, text, { mode: 'block' }) : undefined,
        copy: text => ctx.os.writeClipboard(text),
      })
    }
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
      const locale = useJotLocale()
      const currentLocale = useRef(locale)
      currentLocale.current = locale
      const api = useMemo(() => {
        const value = createHermesApi(ctx, () => ownerNow() === owner, captureGatewayFileDownload, () => currentLocale.current)
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
      return <div className="jot-host"><style>{theme}</style><JotApp mode={mode} locale={locale}
        api={api} persistence={persistence} changeSignal={changeSignal}
        onAskAgent={note => ownerNow() === owner ? askAgent(note) : Promise.resolve('failed' as const)} onExpand={(...args) => { if (ownerNow() === owner) handoff.open(...args) }}
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
      const label = hostLabels(useJotLocale()).open
      return <button type="button" title={label} aria-label={label}
        style={{ border: 0, background: 'transparent', padding: 5, borderRadius: 6, cursor: 'pointer' }}
        onClick={() => open('open', undefined, 'compact')}><JotIcon size={19} /></button>
    }
    function PaneTitle() {
      return <>{hostLabels(useJotLocale()).name}</>
    }
    // Hermes mounts a contribution's render function as a component, so these stay the same
    // functions across registrations and an open page or side panel stays mounted.
    const renderPage = () => <Surface mode="wide" />
    const renderPane = () => <SidePanel />
    const paneLead = () => <JotIcon size={15} />
    const paneTitle = () => <PaneTitle />
    const paneTitleText = () => hostLabels(hostLocale.getSnapshot()).name
    const commands = JOT_COMMANDS.map(item => ({ item, run: () => open(item.action, item.action === 'capture' ? readSelection() : undefined) }))
    // Hermes samples these labels at registration, so they are registered again when the
    // language changes. The same ids replace the entries in place (nothing is removed first).
    // Hosts with data.tabTitle render the pane tab live; the rest read its static title.
    const registerLabels = (locale: JotLocale) => {
      const labels = hostLabels(locale)
      ctx.registerMany([
        { id: 'page', area: 'routes', title: labels.name, data: { path: '/jot' }, render: renderPage },
        { id: 'nav', area: 'sidebar.nav', order: 40, data: { path: '/jot', label: labels.name, codicon: 'notebook' } },
        { id: 'notes', area: 'panes', title: labels.name, data: { placement: 'right', width: '420px',
          hideOnly: true, tabLead: paneLead, tabTitle: paneTitle, tabTitleText: paneTitleText }, render: renderPane },
        ...commands.flatMap(({ item, run }) => [
          { id: `palette-${item.action}`, area: 'palette', data: {
            id: item.id, action: item.id, label: labels.commands[item.id], keywords: labels.keywords, run,
          } },
          { id: `key-${item.action}`, area: 'keybinds', data: {
            id: item.id, label: labels.commands[item.id], category: 'view', defaults: [], run,
          } satisfies KeybindContribution },
        ]),
      ])
    }
    registerLabels(hostLocale.getSnapshot())
    const stopLabels = hostLocale.subscribe(() => registerLabels(hostLocale.getSnapshot()))
    ctx.registerMany([
      { id: 'composer', area: 'composer.actions', order: 30, render: () => <ComposerButton /> },
      { id: 'slash', area: 'composer.middleware', data: { handler: async (draft: { text: string; attachments?: unknown[] }) => {
        const text = draft.text.trim()
        if (!/^\/jot(?:\s+(?:new|capture))?$/i.test(text)) return draft
        const owner = ownerNow()
        try {
          if (!(await ctx.rest<{ ready: boolean }>('/health')).ready) throw new Error('Jot needs a complete local build.')
        } catch {
          host.notifyError(hostLabels(hostLocale.getSnapshot()).backendOff)
          return null
        }
        if (ownerNow() !== owner) return null
        open(/\snew$/i.test(text) ? 'new' : /\scapture$/i.test(text) ? 'capture' : 'open', undefined, 'compact')
        // A draft carrying attachments is kept intact. For a bare command the
        // registered Python handler lets the host own normal draft consumption.
        return draft.attachments?.length ? null : draft
      } } },
    ])
    ctx.onDispose(() => { stopLabels(); hostLocale.dispose(); stopEvents?.(); stopProfile(); stopConnection(); controls.dispose(); for (const api of apis) api.dispose(); apis.clear() })
  },
} satisfies HermesPlugin
