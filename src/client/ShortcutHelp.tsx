import { shortcutHelpSections } from './shortcut-labels.js'
import type { JotLocale } from './types.js'

/** The keyboard reference opened with "?" or from the list options; it describes, it does not rebind. */
export function ShortcutHelp({ locale }: { locale: JotLocale }) {
  const en = locale === 'en'
  return <div className="jot-shortcut-help">
    <div className="jot-shortcut-grid">
      {shortcutHelpSections(locale).map(section => <section key={section.title} className="jot-shortcut-section" aria-label={section.title}>
        <h3>{section.title}</h3>
        <dl>{section.rows.map(row => <div key={row.label} className="jot-shortcut-row">
          <dt>{row.label}</dt>
          <dd>{row.keys.map((key, index) => <kbd key={index}>{key}</kbd>)}</dd>
        </div>)}</dl>
      </section>)}
    </div>
    <p className="jot-shortcut-note">{en
      ? '“Open Jot”, “New note” and “Capture selected text” have no default keys. Search for “Jot” in Hermes keyboard shortcut settings to bind them.'
      : '「打开随记」「新建笔记」「摘录选中的文字」默认不占用按键，可以在 Hermes 设置的键盘快捷键里搜索「随记」绑定。'}</p>
  </div>
}

export default ShortcutHelp
