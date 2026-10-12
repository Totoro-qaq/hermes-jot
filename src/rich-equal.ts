/**
 * 这些默认值来自编辑器 schema（链接 target/rel、有序列表 start、标题级别等）。
 * null 和缺省相同。非空默认值、键顺序和标记顺序也不算用户改过，避免一打开笔记就保存。
 * 真值和编辑器 getJSON() 是否一致，由测试对着 schema 核对。
 */
const SCHEMA_DEFAULTS: Record<string, Record<string, unknown>> = {
  codeBlock: { language: null },
  heading: { level: 1 },
  orderedList: { start: 1, type: null },
  taskItem: { checked: false },
  tableHeader: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  tableCell: { colspan: 1, rowspan: 1, colwidth: null, align: null },
  image: { attachmentId: null, alt: '' },
  attachment: { attachmentId: null, caption: '' },
  link: { href: null, target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null },
  textStyle: { color: null },
  highlight: { color: null },
}

function isSchemaDefault(type: string | undefined, key: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (!type) return false
  const defaults = SCHEMA_DEFAULTS[type]
  return Boolean(defaults && Object.hasOwn(defaults, key) && Object.is(defaults[key], value))
}

function normalizeRich(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRich)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (key === 'attrs' && record.attrs && typeof record.attrs === 'object' && !Array.isArray(record.attrs)) {
      const attrs: Record<string, unknown> = {}
      for (const attr of Object.keys(record.attrs as Record<string, unknown>).sort()) {
        const attrValue = (record.attrs as Record<string, unknown>)[attr]
        if (isSchemaDefault(type, attr, attrValue)) continue
        attrs[attr] = normalizeRich(attrValue)
      }
      if (Object.keys(attrs).length) result.attrs = attrs
      continue
    }
    if (key === 'marks' && Array.isArray(record.marks)) {
      const marks = record.marks.map(normalizeRich)
      marks.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      if (marks.length) result.marks = marks
      continue
    }
    const child = normalizeRich(record[key])
    if (child !== undefined) result[key] = child
  }
  return result
}

export function sameEditorDocument(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeRich(left)) === JSON.stringify(normalizeRich(right))
}
