import { Node, type Editor, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import { HIGHLIGHT_COLORS, TEXT_COLORS, normalizePaletteColor } from '../model.js'
import { JotTable, JotTableView, PersistableTableWidths } from './table-view.js'
import { TABLE_CELL_MIN_WIDTH } from './table-actions.js'
import { JotHeadingKeys, JotListKeys } from './list-commands.js'
import { translator, type JotLocale } from './i18n.js'

export const managedAttachmentUrl = (id: string) => `/jot/api/attachments/${encodeURIComponent(id)}/content`
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)

export interface JotExtensionOptions {
  resolveAttachmentUrl?: (id: string) => string | Promise<string>
  /** Read on every render of a checkbox label, so a language change applies without a remount. */
  locale?: () => JotLocale
}

/** Screen readers announce the checked state themselves; the label names the to-do. */
export function taskCheckboxLabel(text: string, locale: JotLocale): string {
  const name = text.trim()
  const t = translator(locale)
  return name ? t('To-do: {name}', { name }) : t('Empty to-do')
}

/** A locale change retains NodeViews, so refresh their interface text without editing the document. */
export function refreshLocalizedNodeLabels(editor: Pick<Editor, 'state' | 'view'>, locale: JotLocale): void {
  const t = translator(locale)
  editor.state.doc.descendants((node, position) => {
    const type = node.type.name
    if (type !== 'taskItem' && type !== 'attachment' && type !== 'image') return
    const dom = editor.view.nodeDOM(position)
    if (!dom || dom.nodeType !== 1) return
    const element = dom as Element
    if (type === 'attachment') {
      if (!node.attrs.caption) element.textContent = t('Attachment')
      return false
    }
    if (type === 'image') {
      if (element.hasAttribute('data-jot-unavailable')) element.setAttribute('alt', t('Image unavailable'))
      return false
    }
    const label = taskCheckboxLabel(node.textContent, locale)
    element.querySelector(':scope > label > input[type="checkbox"]')?.setAttribute('aria-label', label)
    const hiddenLabel = element.querySelector(':scope > label > span')
    if (hiddenLabel) hiddenLabel.textContent = label
  })
}

const JotTaskItem = TaskItem.extend({
  addNodeView() {
    const parent = this.parent?.()
    if (!parent) return null
    return props => {
      const view = parent(props)
      // Tiptap repeats the checkbox's aria-label as visually hidden text; one announcement is enough.
      ;(view.dom as Partial<Element>).querySelector?.(':scope > label > span')?.setAttribute('aria-hidden', 'true')
      return view
    }
  },
})

/** Clipboard formatting can only introduce colors that persistence also accepts. */
const PaletteColor = Color.extend({
  addGlobalAttributes() {
    return [{ types: ['textStyle'], attributes: { color: {
      default: null,
      parseHTML: element => normalizePaletteColor(element.style.color, TEXT_COLORS),
      renderHTML: attributes => {
        const color = normalizePaletteColor(attributes.color, TEXT_COLORS)
        // The stored hex stays portable; data-jot-color lets dark themes remap it for contrast.
        return color ? { style: `color:${color}`, 'data-jot-color': color } : {}
      },
    } } }]
  },
  addCommands() {
    return {
      setColor: color => ({ chain }) => {
        const normalized = normalizePaletteColor(color, TEXT_COLORS)
        return normalized ? chain().setMark('textStyle', { color: normalized }).run() : false
      },
      unsetColor: () => ({ chain }) => chain().setMark('textStyle', { color: null }).removeEmptyTextStyle().run(),
    }
  },
})

const PaletteHighlight = Highlight.extend({
  addAttributes() {
    return { color: {
      default: null,
      parseHTML: element => normalizePaletteColor(element.getAttribute('data-color') || element.style.backgroundColor, HIGHLIGHT_COLORS),
      renderHTML: attributes => {
        const color = normalizePaletteColor(attributes.color, HIGHLIGHT_COLORS)
        return color ? { 'data-color': color, style: `background-color:${color};color:inherit` } : {}
      },
    } }
  },
  addCommands() {
    return {
      setHighlight: attributes => ({ commands }) => {
        const color = normalizePaletteColor(attributes?.color ?? HIGHLIGHT_COLORS[0], HIGHLIGHT_COLORS)
        return color ? commands.setMark(this.name, { color }) : false
      },
      toggleHighlight: attributes => ({ commands }) => {
        const color = normalizePaletteColor(attributes?.color ?? HIGHLIGHT_COLORS[0], HIGHLIGHT_COLORS)
        return color ? commands.toggleMark(this.name, { color }) : false
      },
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    }
  },
})

function managedNode(name: 'image' | 'attachment', resolve: (id: string) => string | Promise<string>, locale: () => JotLocale) {
  const description = name === 'image' ? 'alt' : 'caption'
  return Node.create({
    name, group: 'block', atom: true, draggable: true,
    addAttributes() { return { attachmentId: { default: null }, [description]: { default: '' } } },
    parseHTML() {
      return [{ tag: name === 'image' ? 'img[data-jot-attachment-id]' : 'a[data-type="jot-attachment"]', priority: 100,
        getAttrs: element => {
          const id = element.getAttribute('data-jot-attachment-id')
          if (!validId(id)) return false
          return { attachmentId: id, [description]: name === 'image' ? element.getAttribute('alt') ?? '' : element.textContent ?? '' }
        } }]
    },
    addNodeView() {
      return ({ node }) => {
        const id = String(node.attrs.attachmentId ?? '')
        const dom = document.createElement(name === 'image' ? 'img' : 'a')
        let alive = true
        let observer: IntersectionObserver | undefined
        let imageUrl = ''
        let loading = false
        dom.setAttribute('data-jot-attachment-id', id)
        if (name === 'image') {
          dom.className = 'jot-managed-image'
          dom.setAttribute('alt', String(node.attrs.alt ?? ''))
          dom.setAttribute('loading', 'lazy')
          dom.setAttribute('decoding', 'async')
          dom.style.minWidth = '24px'; dom.style.minHeight = '24px'
          dom.addEventListener('load', () => { dom.style.removeProperty('min-width'); dom.style.removeProperty('min-height') }, { once: true })
          const load = () => {
            if (loading || !alive) return
            loading = true
            observer?.disconnect()
            if (validId(id)) void Promise.resolve(resolve(id)).then(url => {
              imageUrl = url
              if (alive && url) dom.setAttribute('src', url)
              else if (url.startsWith('blob:')) URL.revokeObjectURL(url)
            }, () => {
              if (!alive) return
              // Marked so a language change can rewrite the fallback, never the note's own alt text.
              dom.setAttribute('data-jot-unavailable', '')
              const t = translator(locale())
              dom.setAttribute('alt', t('Image unavailable'))
            })
          }
          if (typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load() })
            observer.observe(dom)
          } else load()
        } else {
          dom.className = 'jot-attachment-card'
          dom.setAttribute('data-type', 'jot-attachment')
          dom.setAttribute('href', '#')
          const t = translator(locale())
          dom.textContent = String(node.attrs.caption || t('Attachment'))
        }
        return { dom, destroy() { alive = false; observer?.disconnect(); if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl) } }
      }
    },
    renderHTML({ node }) {
      const id: unknown = node.attrs.attachmentId
      if (!validId(id)) return ['span', { class: 'jot-attachment-unavailable' }, 'Attachment unavailable']
      const label = String(node.attrs[description] ?? '')
      // Serialization stores the managed identifier. Fetching belongs to the
      // visible node view, otherwise copy/export can eagerly load every image.
      const url = managedAttachmentUrl(id)
      if (name === 'image') return ['img', { 'data-jot-attachment-id': id, src: url, alt: label,
        class: 'jot-managed-image', loading: 'lazy', decoding: 'async' }]
      return ['a', { 'data-type': 'jot-attachment', 'data-jot-attachment-id': id,
        href: `${url}${url.includes('?') ? '&' : '?'}download=1`, class: 'jot-attachment-card', download: '', rel: 'noopener' }, label || 'Attachment']
    },
  })
}

/** Shared by the actual editor and headless schema/command regression tests. */
export function createJotExtensions(options: JotExtensionOptions = {}): Extensions {
  const resolve = options.resolveAttachmentUrl ?? managedAttachmentUrl
  const locale = options.locale ?? (() => 'zh' as const)
  return [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }), JotHeadingKeys, JotListKeys,
    TaskList, JotTaskItem.configure({ nested: true, a11y: { checkboxLabel: node => taskCheckboxLabel(node.textContent, locale()) } }),
    JotTable.configure({ resizable: true, renderWrapper: true, cellMinWidth: TABLE_CELL_MIN_WIDTH,
      handleWidth: 6, View: JotTableView }), TableRow, TableHeader, TableCell, PersistableTableWidths,
    TextStyle, PaletteColor, PaletteHighlight.configure({ multicolor: true }),
    managedNode('image', resolve, locale), managedNode('attachment', resolve, locale)]
}
