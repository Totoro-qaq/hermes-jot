/**
 * Jot follows the Hermes interface language. Catalogs are keyed by the English
 * source text, so a call site reads as English (the key is "Move to Trash"). Values may
 * use {name} placeholders and plural forms chosen with Intl.PluralRules.
 * The editor frame has its own React root, so the locale is passed to it.
 */
import { CATALOGS } from './locales/index.js'

export const JOT_LOCALES = ['en', 'zh', 'zh-hant', 'ja', 'ar', 'ru', 'fr', 'de', 'es'] as const
export type JotLocale = typeof JOT_LOCALES[number]
export type PluralForms = { [form in Intl.LDMLPluralRule]?: string } & { other: string }
export type Catalog = Record<string, string | PluralForms>
/** One namespace of translations; `en` holds only plural forms of English sources. */
export type NamespaceCatalog = { [locale in JotLocale]?: Catalog }
export type Params = Record<string, string | number>
export type Translate = (source: string, params?: Params) => string

const KNOWN = new Set<string>(JOT_LOCALES)

/** Map a Hermes locale (or any BCP 47 tag) to the closest language Jot ships; unknown → English. */
export function normalizeLocale(value: unknown): JotLocale {
  if (typeof value !== 'string') return 'en'
  const tag = value.trim().toLowerCase().replace(/_/gu, '-')
  if (KNOWN.has(tag)) return tag as JotLocale
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/u.test(tag)) return 'zh-hant'
  const base = tag.split('-')[0]!
  return KNOWN.has(base) ? base as JotLocale : 'en'
}

export const isRtlLocale = (locale: JotLocale): boolean => locale === 'ar'
/** The tag for Intl formatters and the lang attribute. */
export const intlLocale = (locale: JotLocale): string => locale === 'zh' ? 'zh-CN' : locale === 'zh-hant' ? 'zh-TW' : locale
export const isChineseLocale = (locale: JotLocale): boolean => locale === 'zh' || locale === 'zh-hant'

function interpolate(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/gu, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match)
}

function pick(entry: string | PluralForms, locale: JotLocale, params?: Params): string {
  if (typeof entry === 'string') return entry
  const count = typeof params?.count === 'number' ? params.count : Number.NaN
  const rule = Number.isFinite(count) ? new Intl.PluralRules(intlLocale(locale)).select(count) : 'other'
  return entry[rule] ?? entry.other
}

const translators = new Map<JotLocale, Translate>()

/** A translator for one locale: the locale's text, else English plural forms, else the source itself. */
export function translator(locale: JotLocale): Translate {
  const existing = translators.get(locale)
  if (existing) return existing
  const own = CATALOGS[locale] ?? {}
  const english = CATALOGS.en ?? {}
  const translate: Translate = (source, params) => {
    const entry = Object.hasOwn(own, source) ? own[source]! : Object.hasOwn(english, source) ? english[source]! : source
    return interpolate(pick(entry, Object.hasOwn(own, source) ? locale : 'en', params), params)
  }
  translators.set(locale, translate)
  return translate
}
