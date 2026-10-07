import { intlLocale, JOT_LOCALES, normalizeLocale, translator, type JotLocale } from '../client/i18n.js'
import type { JOT_COMMANDS } from '../client/commands.js'

/** The parts of Hermes' plugin i18n door (`ctx.i18n`) Jot uses; older hosts lack some or all of them. */
export interface HostI18n {
  register?(bundles: Record<string, Record<string, string>>): () => void
  t?(key: string): string
  onLocaleChange?(listener: () => void): () => void
}

export interface HostLocale {
  getSnapshot(): JotLocale
  subscribe(listener: () => void): () => void
  dispose(): void
}

const PROBE = 'jot-locale'

/**
 * The Hermes interface language outside React. Hermes has no plain getter for it, so Jot
 * registers a one-key bundle in which every language names itself, and `ctx.i18n.t` reads
 * the active one back (a language Jot does not ship falls back to Hermes' English bundle).
 * Listeners run only when the language Jot shows changes. Hosts without `ctx.i18n` stay English.
 */
export function createHostLocale(i18n: HostI18n | undefined): HostLocale {
  const translate = typeof i18n?.register === 'function' && typeof i18n.t === 'function' ? i18n.t : undefined
  if (translate) i18n!.register!(Object.fromEntries(JOT_LOCALES.map(locale => [locale, { [PROBE]: locale }])))
  const read = (): JotLocale => {
    try { return translate ? normalizeLocale(translate(PROBE)) : 'en' } catch { return 'en' }
  }
  const listeners = new Set<() => void>()
  let current = read()
  const stop = translate && typeof i18n?.onLocaleChange === 'function' ? i18n.onLocaleChange(() => {
    const next = read()
    if (next === current) return
    current = next
    for (const listener of [...listeners]) listener()
  }) : undefined
  return {
    // Without change events, read at call time so handlers still use the language on screen.
    getSnapshot: () => stop ? current : read(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() { stop?.(); listeners.clear() },
  }
}

type CommandId = typeof JOT_COMMANDS[number]['id']

/** Text Hermes samples when Jot registers: route, sidebar, pane tab, palette and keybinds, and host notices. */
export function hostLabels(locale: JotLocale) {
  const t = translator(locale)
  const lower = (text: string) => text.toLocaleLowerCase(intlLocale(locale))
  const name = t('Jot')
  const commands: Record<CommandId, string> = {
    'jot.open': t('Jot: Open Jot'),
    'jot.new-note': t('Jot: New note'),
    'jot.capture': t('Jot: Capture selected text'),
  }
  return {
    name,
    open: t('Open Jot'),
    commands,
    /** English words keep working in every language. */
    keywords: [...new Set(['jot', 'notes', lower(name), lower(t('Notes'))])],
    backendOff: t('Enable the Jot backend in Hermes Plugins, then try again.'),
    /** Thrown from register() on a host without the SDK features Jot needs; Hermes shows it. */
    outdated: t('Jot requires a recent Hermes Desktop SDK with SandboxedFrame and gateway file downloads. Update Hermes Desktop, then enable Jot again.'),
  }
}
