import type { Catalog, JotLocale, NamespaceCatalog } from '../i18n.js'
import app from './app.js'
import editor from './editor.js'
import ui from './ui.js'
import errors from './errors.js'
import host from './host.js'

/** Every namespace merged per locale. A source shared by two namespaces must translate the same way (tested). */
export const NAMESPACES: Readonly<Record<string, NamespaceCatalog>> = { app, editor, ui, errors, host }

export const CATALOGS: Partial<Record<JotLocale, Catalog>> = {}
for (const namespace of Object.values(NAMESPACES)) {
  for (const [locale, catalog] of Object.entries(namespace) as Array<[JotLocale, Catalog]>) {
    CATALOGS[locale] = { ...CATALOGS[locale], ...catalog }
  }
}
