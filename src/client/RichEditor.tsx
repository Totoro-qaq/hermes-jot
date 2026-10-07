import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from './layers.js'
import { Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { closeHistory } from '@tiptap/pm/history'
import { columnResizingPluginKey } from '@tiptap/pm/tables'
import { findMatches, replaceAllMatches, replaceMatch } from './document-find.js'
import { highlightWindow } from './find-highlights.js'
import { editorShortcut, editorShortcutLabel, type EditorShortcut } from './editor-shortcuts.js'
import { createJotExtensions, managedAttachmentUrl, refreshLocalizedNodeLabels } from './editor-extensions.js'
import { syncEditorContent } from './editor-content.js'
import { insertManagedAttachment } from './editor-attachments.js'
import { appendEditorBlocks } from './editor-append.js'
import { JotActionIcon, type JotActionIconName } from './icons.js'
import { TableControls } from './TableControls.js'
import { HIGHLIGHT_COLORS, TEXT_COLORS } from '../model.js'
import { applySlashItem, filterSlashItems, slashLabel, slashMatch, type SlashItem, type SlashMatch } from './slash-menu.js'
import { ariaShortcut, shortcutLabel, SHORTCUTS, withShortcut, type ShortcutId } from './shortcut-labels.js'
import { jotStyles } from './styles.js'
import { translator } from './i18n.js'
import type { JotLocale, RichDoc, RichNode } from './types.js'

export interface RichEditorProps {
  value: RichDoc
  /** Resolve a delayed host update against edits made before this React effect. */
  resolveExternalValue?: () => RichDoc
  onChange: (content: RichDoc, editorRevision?: number) => void
  onBlur?: () => void
  readOnly?: boolean
  locale?: JotLocale
  onReady?: (actions: RichEditorActions | null) => void
  resolveAttachmentUrl?: (attachmentId: string) => string | Promise<string>
  /** Offered in the "/" menu; the host owns the file picker and upload. */
  onRequestAttachment?: () => void
}

interface SlashMenuState { match: SlashMatch; items: SlashItem[]; index: number; caret: { left: number; top: number; bottom: number } }

export interface RichEditorActions {
  /** Native bridges must pass the focused target; input fields never format or undo the body. */
  handleShortcut: (action: EditorShortcut, target?: EventTarget | null) => boolean
  insertImage: (attachmentId: string, alt?: string) => boolean | Promise<boolean>
  insertAttachment: (attachmentId: string, caption?: string) => boolean | Promise<boolean>
  /** Append another author's saved blocks at the end; true only once the document contains them. */
  appendBlocks?: (blocks: RichNode[]) => boolean | Promise<boolean>
  /** Move the caret into the body, for example after Enter in the title. */
  focus: () => void
}

function EditorControlIcon({ name }: { name: 'format' | 'chevron' | 'todo' | 'find' | 'previous' | 'next' | 'close' | 'table' }) {
  const names: Record<typeof name, JotActionIconName> = {
    format: 'format', chevron: 'chevron-down', todo: 'checklist', find: 'search',
    // Matches move up and down through the document, not back and forward.
    previous: 'chevron-up', next: 'chevron-down', close: 'close', table: 'table',
  }
  return <JotActionIcon name={names[name]} size={16} className={`jot-editor-control-icon jot-editor-control-icon--${name}`} />
}

export function RichEditor({ value, resolveExternalValue, onChange, onBlur, readOnly = false, locale = 'en', onReady, resolveAttachmentUrl, onRequestAttachment }: RichEditorProps) {
  const root = useRef<HTMLDivElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const instance = useRef<Editor | null>(null)
  const callbacks = useRef({ onChange, onBlur, onReady, resolveAttachmentUrl, readOnly, locale, onRequestAttachment })
  callbacks.current = { onChange, onBlur, onReady, resolveAttachmentUrl, readOnly, locale, onRequestAttachment }
  const shortcutHandler = useRef<RichEditorActions['handleShortcut']>(() => false)
  const composing = useRef(false)
  const lastInput = useRef(JSON.stringify(value))
  const initial = useRef(value)
  const [, render] = useState(0)
  const [formatOpen, setFormatOpen] = useState(false)
  const formatTrigger = useRef<HTMLButtonElement>(null)
  const formatPopover = useRef<HTMLDivElement>(null)
  const [paletteOpen, setPaletteOpen] = useState<'text' | 'highlight' | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const findInput = useRef<HTMLInputElement>(null)
  const findState = useRef({ query: '', active: 0 })
  findState.current = { query: findOpen ? query : '', active: activeMatch }
  const findKey = useRef(new PluginKey<DecorationSet>('jot-document-find'))
  const t = translator(locale)
  const [slash, setSlash] = useState<SlashMenuState | null>(null)
  const slashState = useRef<SlashMenuState | null>(null)
  slashState.current = slash
  /** The trigger position the user dismissed with Escape; it stays closed until that trigger is gone. */
  const slashDismissed = useRef<number | null>(null)
  const slashMenu = useRef<HTMLDivElement>(null)
  const [slashPlacement, setSlashPlacement] = useState<{ left: number; top: number } | null>(null)
  const slashId = useId()
  const refreshSlash = useRef(() => {})
  refreshSlash.current = () => {
    const current = instance.current
    // Input-method composition holds provisional text; decide again once it is committed.
    if (!current || current.view.composing) return
    const match = callbacks.current.readOnly || !current.isFocused ? null : slashMatch(current.state)
    if (!match) {
      slashDismissed.current = null
      if (slashState.current) setSlash(null)
      return
    }
    if (slashDismissed.current === match.from) return
    const items = filterSlashItems(match.query, { attachments: Boolean(callbacks.current.onRequestAttachment), locale: callbacks.current.locale })
    if (!items.length) { if (slashState.current) setSlash(null); return }
    const previous = slashState.current
    const index = previous?.match.from === match.from && previous.match.query === match.query ? Math.min(previous.index, items.length - 1) : 0
    const { left, top, bottom } = current.view.coordsAtPos(match.from)
    setSlash({ match, items, index, caret: { left, top, bottom } })
  }
  const chooseSlash = (item: SlashItem) => {
    const current = instance.current
    const menu = slashState.current
    if (!current || !menu || callbacks.current.readOnly) return
    setSlash(null)
    applySlashItem(current, menu.match, item.id, { requestAttachment: callbacks.current.onRequestAttachment })
  }
  const chooseSlashRef = useRef(chooseSlash)
  chooseSlashRef.current = chooseSlash

  useEffect(() => {
    if (!mount.current) return
    const editor = new Editor({
      element: mount.current,
      content: initial.current,
      editable: !readOnly,
      extensions: createJotExtensions({ resolveAttachmentUrl: id => callbacks.current.resolveAttachmentUrl?.(id) ?? managedAttachmentUrl(id),
        locale: () => callbacks.current.locale }),
      editorProps: {
        handleKeyDown: (_view, event) => {
          const menu = slashState.current
          if (menu && !event.isComposing && event.keyCode !== 229 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const step = event.key === 'ArrowDown' ? 1 : -1
              setSlash({ ...menu, index: (menu.index + step + menu.items.length) % menu.items.length })
              return true
            }
            if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
              chooseSlashRef.current(menu.items[menu.index]!)
              return true
            }
            if (event.key === 'Escape') {
              slashDismissed.current = menu.match.from
              setSlash(null)
              return true
            }
          }
          const action = editorShortcut(event)
          if (!action || !shortcutHandler.current(action, event.target)) return false
          event.preventDefault(); event.stopPropagation()
          return true
        },
        attributes: {
          role: 'textbox', 'aria-multiline': 'true',
          // A note takes the direction of its own text, not of the interface language.
          dir: 'auto',
          'aria-label': t('Note content'),
          'data-placeholder': t('Start writing…'),
        },
      },
      onUpdate: ({ editor: current, transaction }) => {
        // Plugin normalization appended to a selection or meta transaction, such as
        // Tiptap's trailing paragraph after a final list or table, is not an edit.
        // Emitting it would save and re-date a note merely because it was opened.
        if (!transaction.docChanged) return
        const content = current.getJSON() as RichDoc
        lastInput.current = JSON.stringify(content)
        current.view.dom.setAttribute('data-empty', current.getText().trim() ? 'false' : 'true')
        callbacks.current.onChange(content)
      },
      onTransaction: () => { render(version => version + 1); refreshSlash.current() },
      onFocus: () => refreshSlash.current(),
      onBlur: () => { callbacks.current.onBlur?.(); refreshSlash.current() },
    })
    editor.registerPlugin(new Plugin<DecorationSet>({
      key: findKey.current,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, previous) => {
          if (!transaction.docChanged && !transaction.getMeta(findKey.current)) return previous.map(transaction.mapping, transaction.doc)
          const matches = findMatches(transaction.doc, findState.current.query)
          const window = highlightWindow(matches, findState.current.active)
          return DecorationSet.create(transaction.doc, window.matches.map((match, index) => Decoration.inline(match.from, match.to, {
            class: `jot-document-find-hit${index + window.start === findState.current.active ? ' is-current' : ''}`,
            style: `background:${index + window.start === findState.current.active ? 'var(--jot-find-active,#f0bd55)' : 'var(--jot-find-highlight,#f6e5af)'};color:var(--jot-fg,inherit);border-radius:2px`,
          })))
        },
      },
      props: { decorations: state => findKey.current.getState(state) },
    }))
    instance.current = editor
    const insertAttachment = (type: 'image' | 'attachment', id: string, description = '') => {
      const current = instance.current
      if (!current || callbacks.current.readOnly || !/^[0-9a-f]{32}$/u.test(id) || description.length > 1_000) return false
      // An upload may finish while the user types in a modal; keep that focus.
      return insertManagedAttachment(current, type, id, description)
    }
    const appendBlocks = (blocks: RichNode[]) => {
      const target = instance.current
      if (!target || callbacks.current.readOnly || !Array.isArray(blocks)) return false
      if (!target.view.composing && !composing.current) return appendEditorBlocks(target, blocks)
      // Never disturb text inside an input method's composition; apply right after it ends.
      const deadline = Date.now() + 4000
      return new Promise<boolean>(resolve => {
        const wait = () => {
          if (instance.current !== target || callbacks.current.readOnly) resolve(false)
          else if (!target.view.composing && !composing.current) resolve(appendEditorBlocks(target, blocks))
          else if (Date.now() > deadline) resolve(false)
          else setTimeout(wait, 50)
        }
        setTimeout(wait, 50)
      })
    }
    callbacks.current.onReady?.({ handleShortcut: (action, target) => shortcutHandler.current(action, target),
      insertImage: (id, alt) => insertAttachment('image', id, alt),
      insertAttachment: (id, caption) => insertAttachment('attachment', id, caption),
      appendBlocks,
      focus: () => { instance.current?.commands.focus('start') } })
    editor.view.dom.setAttribute('data-empty', editor.getText().trim() ? 'false' : 'true')
    render(version => version + 1)
    return () => { callbacks.current.onReady?.(null); instance.current = null; editor.destroy() }
  }, [])

  useEffect(() => {
    const editor = instance.current
    const incoming = resolveExternalValue?.() ?? value
    const serialized = JSON.stringify(incoming)
    if (editor && serialized !== lastInput.current) {
      lastInput.current = serialized
      syncEditorContent(editor, incoming)
      editor.view.dom.setAttribute('data-empty', editor.getText().trim() ? 'false' : 'true')
    }
  }, [value, resolveExternalValue])

  useEffect(() => {
    const editor = instance.current
    if (!editor) return
    // Switching read-only state changes permissions, not the document.
    editor.setEditable(!readOnly, false)
    if (readOnly) editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1, setDragging: null }))
    editor.view.dom.setAttribute('aria-label', t('Note content'))
    editor.view.dom.setAttribute('data-placeholder', t('Start writing…'))
    refreshLocalizedNodeLabels(editor, locale)
  }, [readOnly, locale])

  const editor = instance.current
  const document = editor?.state.doc
  const matches = useMemo(() => document && findOpen ? findMatches(document, query) : [], [document, findOpen, query])
  const index = matches.length ? Math.min(activeMatch, matches.length - 1) : 0
  useEffect(() => {
    if (activeMatch !== index) setActiveMatch(index)
    instance.current?.view.dispatch(instance.current.state.tr.setMeta(findKey.current, true))
  }, [findOpen, query, activeMatch, matches.length])
  useEffect(() => { if (findOpen) { findInput.current?.focus(); findInput.current?.select() } }, [findOpen])
  // The style popover floats over the document and closes on an outside press.
  useEffect(() => {
    if (!formatOpen) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (formatPopover.current?.contains(target) || formatTrigger.current?.contains(target)) return
      setFormatOpen(false); setPaletteOpen(null)
    }
    const page = root.current?.ownerDocument ?? globalThis.document
    page.addEventListener('pointerdown', outside, true)
    return () => page.removeEventListener('pointerdown', outside, true)
  }, [formatOpen])

  // The "/" menu is measured after rendering, then placed under the caret or above it near the viewport edge.
  useLayoutEffect(() => {
    const element = slashMenu.current
    if (!slash || !element) { setSlashPlacement(null); return }
    const view = element.ownerDocument.defaultView
    if (!view) return
    const { width, height } = element.getBoundingClientRect()
    const below = slash.caret.bottom + 4
    const top = below + height <= view.innerHeight - 8 ? below : Math.max(8, slash.caret.top - 4 - height)
    const left = Math.min(Math.max(8, slash.caret.left), Math.max(8, view.innerWidth - width - 8))
    setSlashPlacement(previous => previous?.left === left && previous.top === top ? previous : { left, top })
  }, [slash])
  useEffect(() => {
    const dom = instance.current?.view.dom
    if (!dom) return
    // The body keeps its textbox role; these attributes tie it to the open list without changing that role.
    if (!slash) { for (const name of ['aria-controls', 'aria-activedescendant', 'aria-autocomplete']) dom.removeAttribute(name); return }
    dom.setAttribute('aria-autocomplete', 'list')
    dom.setAttribute('aria-controls', slashId)
    dom.setAttribute('aria-activedescendant', `${slashId}-${slash.items[slash.index]!.id}`)
  }, [slash, slashId])
  const slashOpen = slash !== null
  useEffect(() => {
    if (!slashOpen) return
    const page = root.current?.ownerDocument.defaultView
    const follow = () => refreshSlash.current()
    page?.addEventListener('scroll', follow, true)
    page?.addEventListener('resize', follow)
    return () => { page?.removeEventListener('scroll', follow, true); page?.removeEventListener('resize', follow) }
  }, [slashOpen])
  useEffect(() => { slashMenu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [slash?.index])

  const selectMatch = (next: number) => {
    if (!editor || !matches.length) return
    const active = (next + matches.length) % matches.length
    const match = matches[active]!
    findState.current.active = active
    setActiveMatch(active)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .setMeta(findKey.current, true).scrollIntoView())
  }
  const openFind = () => {
    setFindOpen(true)
    setFormatOpen(false)
    if (findOpen) { findInput.current?.focus(); findInput.current?.select() }
  }
  shortcutHandler.current = (action, target = globalThis.document?.activeElement) => {
    const current = instance.current
    if (!current || composing.current || current.view.composing || !target || typeof Node === 'undefined' || !(target instanceof Node)) return false
    if (action === 'find') {
      if (!root.current?.contains(target)) return false
      openFind()
      return true
    }
    if (readOnly || !mount.current?.contains(target)
      || target instanceof Element && target.closest('input,textarea,select,[data-jot-table-chrome]')) return false
    switch (action) {
      case 'bold': current.commands.toggleBold(); break
      case 'italic': current.commands.toggleItalic(); break
      case 'underline': current.commands.toggleUnderline(); break
      case 'undo': current.commands.undo(); break
      case 'redo': current.commands.redo(); break
    }
    return true
  }
  const closeFind = () => {
    setFindOpen(false)
    editor?.commands.focus()
  }
  const replace = (all: boolean) => {
    if (!editor || readOnly) return
    const current = findMatches(editor.state.doc, query)
    if (!current.length) return
    const match = current[Math.min(index, current.length - 1)]!
    const transaction = all ? replaceAllMatches(editor.state, current, replacement) : replaceMatch(editor.state, match, replacement)
    editor.view.dispatch(transaction)
    // Keep later typing out of the replacement's single undo group.
    editor.view.dispatch(closeHistory(editor.state.tr))
    const remaining = findMatches(editor.state.doc, query)
    const next = all ? 0 : Math.max(0, remaining.findIndex(item => item.from >= match.from + replacement.length))
    setActiveMatch(next)
    findState.current.active = next
    if (remaining.length) {
      const selected = remaining[next]!
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, selected.from, selected.to))
        .setMeta(findKey.current, true).scrollIntoView())
    }
  }
  const marks = [
    { id: 'bold', label: t('Bold'), text: 'B', active: editor?.isActive('bold'), run: () => editor?.chain().focus().toggleBold().run() },
    { id: 'italic', label: t('Italic'), text: 'I', active: editor?.isActive('italic'), run: () => editor?.chain().focus().toggleItalic().run() },
    { id: 'underline', label: t('Underline'), text: 'U', active: editor?.isActive('underline'), run: () => editor?.chain().focus().toggleUnderline().run() },
  ] as const
  const blocks = [
    { id: 'paragraph', label: t('Body text'), text: '¶', active: editor?.isActive('paragraph') && !editor?.isActive('blockquote'), run: () => editor?.chain().focus().setParagraph().run() },
    { id: 'heading1', label: t('Heading 1'), text: 'H1', active: editor?.isActive('heading', { level: 1 }), run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: 'heading2', label: t('Heading 2'), text: 'H2', active: editor?.isActive('heading', { level: 2 }), run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'heading3', label: t('Heading 3'), text: 'H3', active: editor?.isActive('heading', { level: 3 }), run: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: 'bulletList', label: t('Bullet list'), text: '•', active: editor?.isActive('bulletList'), run: () => editor?.chain().focus().toggleBulletList().run() },
    { id: 'orderedList', label: t('Numbered list'), text: '1.', active: editor?.isActive('orderedList'), run: () => editor?.chain().focus().toggleOrderedList().run() },
    { id: 'blockquote', label: t('Quote'), text: '❝', active: editor?.isActive('blockquote'), run: () => editor?.chain().focus().toggleBlockquote().run() },
    { id: 'codeBlock', label: t('Code block'), text: '{ }', active: editor?.isActive('codeBlock'), run: () => editor?.chain().focus().toggleCodeBlock().run() },
  ]
  const inline = [
    { id: 'strike', label: t('Strikethrough'), text: 'S', active: editor?.isActive('strike'), run: () => editor?.chain().focus().toggleStrike().run() },
    { id: 'code', label: t('Inline code'), text: '`', active: editor?.isActive('code'), run: () => editor?.chain().focus().toggleCode().run() },
    { id: 'horizontalRule', label: t('Divider'), text: '—', active: false, run: () => editor?.chain().focus().setHorizontalRule().run() },
    { id: 'clear', label: t('Clear formatting'), text: '⌫', active: false, run: () => editor?.chain().focus().unsetAllMarks().clearNodes().run() },
  ]
  /** Tool ids that have a key share the shortcut table's names. */
  const toolShortcut = (id: string): ShortcutId | undefined => Object.hasOwn(SHORTCUTS, id) ? id as ShortcutId : undefined
  const shortcutTitle = (label: string, id: string) => withShortcut(label, toolShortcut(id))
  const colorNames = [t('Gray'), t('Red'), t('Orange'), t('Green'), t('Blue'), t('Purple'), t('Pink')]
  const highlightNames = [t('Yellow'), t('Orange'), t('Green'), t('Blue'), t('Purple'), t('Pink')]
  const formatButton = (tool: { id: string; label: string; text: string; active?: boolean; run: () => unknown }, close = true) => {
    const shortcut = toolShortcut(tool.id)
    return <button key={tool.id} type="button" className={`jot-format jot-format-${tool.id}`}
      title={shortcutTitle(tool.label, tool.id)} aria-label={tool.label} aria-pressed={Boolean(tool.active)} disabled={readOnly || !editor}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => { tool.run(); if (close) setFormatOpen(false) }}>
      <span className="jot-format-glyph" aria-hidden="true">{tool.text}</span><span className="jot-format-label">{tool.label}</span>
      {shortcut && <kbd className="jot-keys" aria-hidden="true">{shortcutLabel(shortcut)}</kbd>}</button>
  }
  return (
    <div ref={root} className="jot-rich-editor" onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      const action = editorShortcut(event.nativeEvent)
      if (action && shortcutHandler.current(action, event.target)) {
        event.preventDefault(); event.stopPropagation()
      } else if (event.key === 'Escape' && (findOpen || formatOpen)) {
        event.preventDefault(); event.stopPropagation()
        if (formatOpen) { setFormatOpen(false); editor?.commands.focus() } else closeFind()
      }
    }}>
      <div className="jot-format-bar" role="toolbar" aria-label={t('Text formatting')}>
        <button ref={formatTrigger} type="button" className="jot-format jot-editor-control jot-format-menu" aria-expanded={formatOpen} aria-haspopup="true" disabled={readOnly || !editor}
          aria-label={t('Text styles')} title={t('Headings, lists, quotes, colors')}
          onMouseDown={event => event.preventDefault()} onClick={() => { setFormatOpen(open => !open); setPaletteOpen(null) }}>
          <EditorControlIcon name="format" /><span className="jot-editor-control-label">{t('Style')}</span><EditorControlIcon name="chevron" />
        </button>
        {marks.map(tool => <button key={tool.id} type="button" className={`jot-format jot-editor-control jot-editor-control-icon-only jot-format-${tool.id}`}
          aria-label={tool.label} title={shortcutTitle(tool.label, tool.id)} aria-pressed={Boolean(tool.active)} disabled={readOnly || !editor}
          aria-keyshortcuts={ariaShortcut(tool.id)} onMouseDown={event => event.preventDefault()} onClick={() => tool.run()}>{tool.text}</button>)}
        <button type="button" className="jot-format jot-editor-control jot-editor-control-icon-only jot-format-taskList" aria-label={t('To-do list')}
          title={withShortcut(t('To-do list'), 'taskList')} aria-keyshortcuts={ariaShortcut('taskList')}
          aria-pressed={Boolean(editor?.isActive('taskList'))} disabled={readOnly || !editor}
          onMouseDown={event => event.preventDefault()} onClick={() => editor?.chain().focus().toggleTaskList().run()}>
          <EditorControlIcon name="todo" />
        </button>
        <span className="jot-format-divider" aria-hidden="true" />
        <button type="button" className="jot-format jot-editor-control jot-find-open" aria-expanded={findOpen} disabled={!editor}
          aria-label={t('Find in this note')} title={`${t('Find in this note')} (${editorShortcutLabel('find')})`}
          onClick={openFind}><EditorControlIcon name="find" /><span className="jot-editor-control-label">{t('Find')}</span></button>
        <button type="button" className="jot-format jot-editor-control jot-table-insert" disabled={readOnly || !editor || editor.isActive('table')}
          aria-label={t('Insert table')} title={t('Insert table')} onMouseDown={event => event.preventDefault()}
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <EditorControlIcon name="table" /><span className="jot-editor-control-label">{t('Table')}</span>
        </button>
        {formatOpen && <div ref={formatPopover} className="jot-format-popover" role="group" aria-label={t('Text styles')}>
          <div className="jot-format-section" role="group" aria-label={t('Paragraph style')}>{blocks.map(tool => formatButton(tool))}</div>
          <div className="jot-format-section" role="group" aria-label={t('More formatting')}>{inline.map(tool => formatButton(tool))}</div>
          <div className="jot-format-section" role="group" aria-label={t('Color')}>
            <button type="button" className="jot-format" disabled={readOnly || !editor} aria-expanded={paletteOpen === 'text'}
              onMouseDown={event => event.preventDefault()} onClick={() => setPaletteOpen(value => value === 'text' ? null : 'text')}>
              <span className="jot-format-glyph jot-format-color-glyph" aria-hidden="true">A</span><span>{t('Text color')}</span></button>
            <button type="button" className="jot-format" disabled={readOnly || !editor} aria-expanded={paletteOpen === 'highlight'}
              onMouseDown={event => event.preventDefault()} onClick={() => setPaletteOpen(value => value === 'highlight' ? null : 'highlight')}>
              <span className="jot-format-glyph jot-format-highlight-glyph" aria-hidden="true">A</span><span>{t('Highlight')}</span></button>
          </div>
          {paletteOpen && <div className="jot-color-palette" role="group" aria-label={paletteOpen === 'text' ? t('Text color') : t('Highlight')}>
            {(paletteOpen === 'text' ? TEXT_COLORS : HIGHLIGHT_COLORS).map((color, index) => {
              const label = (paletteOpen === 'text' ? colorNames : highlightNames)[index]!
              const text = paletteOpen === 'text'
              return <button type="button" key={color} className={`jot-color-swatch${text ? '' : ' jot-highlight-swatch'}`} data-color={color}
                aria-label={label} title={label} aria-pressed={editor?.getAttributes(text ? 'textStyle' : 'highlight').color === color}
                disabled={readOnly || !editor} style={(text ? { '--jot-swatch-color': color } : { background: color, color: '#23262b' }) as CSSProperties}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  if (text) editor?.chain().focus().setColor(color).run()
                  else editor?.chain().focus().setHighlight({ color }).run()
                  setPaletteOpen(null); setFormatOpen(false)
                }}><span aria-hidden="true">A</span></button>
            })}
            <button type="button" className="jot-text-btn" disabled={readOnly || !editor} onMouseDown={event => event.preventDefault()} onClick={() => {
              if (paletteOpen === 'text') editor?.chain().focus().unsetColor().run()
              else editor?.chain().focus().unsetHighlight().run()
              setPaletteOpen(null); setFormatOpen(false)
            }}>{t('Remove color')}</button>
          </div>}
        </div>}
      </div>
      {findOpen && <div className="jot-document-find" role="search" aria-label={t('Find in this note')}
        style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0', borderBottom: '1px solid var(--jot-line)',
          position: 'sticky', top: 0, zIndex: 2, background: 'var(--jot-bg)' }}>
        <div className="jot-document-find-row" style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <input ref={findInput} className="jot-find-query" aria-label={t('Find text')} value={query}
            placeholder={t('Find in this note')} style={{ flex: '1 1 130px', minWidth: 0 }}
            onChange={event => {
              const nextQuery = event.target.value
              setQuery(nextQuery); setActiveMatch(0)
              findState.current = { query: nextQuery, active: 0 }
              if (!editor) return
              const first = findMatches(editor.state.doc, nextQuery)[0]
              let transaction = editor.state.tr.setMeta(findKey.current, true)
              if (first) transaction = transaction.setSelection(TextSelection.create(editor.state.doc, first.from, first.to)).scrollIntoView()
              editor.view.dispatch(transaction)
            }}
            onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.key === 'Enter') { event.preventDefault(); selectMatch(index + (event.shiftKey ? -1 : 1)) } }} />
          <span className="jot-find-count" role="status" aria-live="polite">{matches.length ? index + 1 : 0} / {matches.length}</span>
          <button type="button" className="jot-text-btn jot-editor-control jot-editor-control-icon-only" disabled={!matches.length} aria-label={t('Previous match')} onClick={() => selectMatch(index - 1)}><EditorControlIcon name="previous" /></button>
          <button type="button" className="jot-text-btn jot-editor-control jot-editor-control-icon-only" disabled={!matches.length} aria-label={t('Next match')} onClick={() => selectMatch(index + 1)}><EditorControlIcon name="next" /></button>
          <button type="button" className="jot-text-btn jot-editor-control" aria-expanded={replaceOpen} disabled={readOnly} onClick={() => setReplaceOpen(open => !open)}><span className="jot-editor-control-label">{t('Replace')}</span><EditorControlIcon name="chevron" /></button>
          <button type="button" className="jot-text-btn jot-editor-control jot-editor-control-icon-only" aria-label={t('Close find')} onClick={closeFind}><EditorControlIcon name="close" /></button>
        </div>
        {replaceOpen && <div className="jot-document-replace-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input className="jot-find-replacement" aria-label={t('Replacement text')} value={replacement} disabled={readOnly}
            placeholder={t('Replace with (empty deletes)')} style={{ flex: '1 1 130px', minWidth: 0 }}
            onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.key === 'Enter') { event.preventDefault(); replace(false) } }} />
          <button type="button" className="jot-text-btn jot-editor-control" disabled={readOnly || !matches.length} onClick={() => replace(false)}><span className="jot-editor-control-label">{t('Replace this match')}</span></button>
          <button type="button" className="jot-text-btn jot-editor-control" disabled={readOnly || !matches.length} onClick={() => replace(true)}><span className="jot-editor-control-label">{t('Replace all')}</span></button>
        </div>}
      </div>}
      <div className="jot-editor-mount" ref={mount} />
      {editor && <TableControls editor={editor} readOnly={readOnly} locale={locale} />}
      {slash && globalThis.document && createPortal(<div className="jot-overlay-root">
        <style>{jotStyles}</style>
        <div ref={slashMenu} id={slashId} role="listbox" aria-label={t('Insert')} className="jot-slash-menu"
          style={{ left: slashPlacement?.left ?? 0, top: slashPlacement?.top ?? 0, visibility: slashPlacement ? 'visible' : 'hidden' }}
          onMouseDown={event => event.preventDefault()}>
          {slash.items.map((item, index) => <div key={item.id} id={`${slashId}-${item.id}`} role="option" aria-selected={index === slash.index}
            className={`jot-slash-item${index === slash.index ? ' is-active' : ''}`}
            onMouseMove={() => { if (index !== slash.index) setSlash({ ...slash, index }) }} onClick={() => chooseSlash(item)}>
            <span className={`jot-format-glyph jot-slash-glyph-${item.id}`} aria-hidden="true">
              {item.icon ? <JotActionIcon name={item.icon} size={14} /> : item.glyph}</span>
            <span className="jot-slash-label">{slashLabel(item, locale)}</span>
            {item.shortcut && <kbd className="jot-keys" aria-hidden="true">{shortcutLabel(item.shortcut)}</kbd>}
          </div>)}
          <div className="jot-slash-hint" aria-hidden="true">{t('↑↓ choose · Enter insert · Esc close')}</div>
        </div>
      </div>, globalThis.document.body)}
    </div>
  )
}
