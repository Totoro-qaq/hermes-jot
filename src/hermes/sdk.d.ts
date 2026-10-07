declare module '@hermes/plugin-sdk' {
  import type { ReactNode, ComponentType } from 'react'
  interface Atom<T> { get(): T; subscribe(listener: (value: T) => void): () => void }
  /** A gateway stream frame; plugin broadcasts arrive as `plugin.<id>.<event>`. */
  interface GatewayEvent { type: string; payload?: unknown; session_id?: string }
  type GatewayEventListener = (event: GatewayEvent) => void
  interface Contribution { id: string; area: string; title?: string; order?: number; data?: any; render?: (...args: any[]) => ReactNode }
  export interface PluginContext {
    register(item: Contribution): () => void
    registerMany(items: Contribution[]): () => void
    onDispose(fn: () => void): void
    /** Absent on older hosts. Retired with the plugin; returns a disposer. */
    onEvent?(type: string, listener: GatewayEventListener): () => void
    addEventListener(target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): () => void
    rest<T>(path: string, options?: { method?: string; body?: unknown; upload?: { filename: string; contentType?: string; bytes: ArrayBuffer }; timeoutMs?: number }): Promise<T>
    storage: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; remove(key: string): void }
    os: { writeClipboard(text: string): Promise<boolean>; openExternal(url: string): Promise<boolean> }
    /** Plugin-scoped strings resolved in the Hermes language. Absent on older hosts, and `t` and
     *  `onLocaleChange` arrived after `register`. `onLocaleChange` fires on a switch, not at start. */
    i18n?: {
      register?(bundles: Record<string, Record<string, string>>): () => void
      t?(key: string, ...args: unknown[]): string
      onLocaleChange?(listener: () => void): () => void
    }
  }
  export interface HermesPlugin { id: string; name: string; description?: string; defaultEnabled?: boolean; register(ctx: PluginContext): void }
  export interface KeybindContribution { id: string; label: string; category?: 'composer' | 'profiles' | 'session' | 'navigation' | 'view'; defaults?: readonly string[]; run(): void }
  export const host: {
    state: { profile: Atom<string>; connectionId: Atom<string | null>; activeSessionId: Atom<string | null>; gateway: Atom<string> }
    navigate(path: string): void
    revealPane(id: string): void
    paneVisibility(id: string): Atom<boolean>
    notify(message: string): void
    notifyError(message: string): void
    /** Absent on older hosts. Not retired with the plugin: dispose it yourself. */
    onEvent?(type: string, listener: GatewayEventListener): () => void
    /** Absent on older hosts. `null` addresses the composer the person last used. */
    composer?: {
      insertText(sessionId: string | null, text: string, options?: { mode?: 'block' | 'inline' | 'prefix' }): Promise<boolean>
    }
  }
  export function useValue<T>(atom: Atom<T>): T
  /** The Hermes interface language (a Hermes locale id such as `zh-hant`). Absent on older hosts. */
  export const useI18n: undefined | (() => { locale: string })
  export function captureGatewayFileDownload(): (path: string, suggestedName: string) => Promise<void>
  export const MessageTextContent: ComponentType<{ text: string; media?: boolean }>
  export const SandboxedFrame: ComponentType<{ src: string; title: string; style?: import('react').CSSProperties;
    onLoad?: () => void; ref?: import('react').Ref<HTMLIFrameElement> }>
  export function useTheme(): { resolvedMode: string; renderedMode?: string; themeName: string; theme: unknown }
}
