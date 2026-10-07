import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Editor } from '@tiptap/core'
import { createJotExtensions } from '../src/client/editor-extensions.js'
import { agentMarkdownRoundTrips, docToAgentMarkdown, plainTextRoundTrips } from '../src/agent-markdown.js'
import { docFromMarkdown, docFromText, validateRichDoc, type RichDoc, type RichMark, type RichNode } from '../src/model.js'

const text = (value: string, ...marks: RichMark[]): RichNode => marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value }
const p = (...content: RichNode[]): RichNode => content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
const doc = (...content: RichNode[]): RichDoc => validateRichDoc({ type: 'doc', content })
const item = (...content: RichNode[]): RichNode => ({ type: 'listItem', content })
const cellAttrs = { colspan: 1, rowspan: 1, colwidth: null, align: null }
const cell = (type: 'tableHeader' | 'tableCell', ...content: RichNode[]): RichNode => ({ type, attrs: cellAttrs, content: [p(...content)] })
const editorLink = (href: string): RichMark => ({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } })
const attachmentId = 'b'.repeat(32)

const MARKDOWN_CORPUS = [
  '# Launch plan\n\n## Goals\n\n- Ship **v1**\n- Write [docs](https://example.com)\n\n1. First\n2. Second\n\n> Keep it simple',
  '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six',
  '**bold** and *italic* and `code` and ~~strike~~ and [mail](mailto:team@example.com)',
  'Mid*word* stays literal, as do a_b_c and 2 * 3 * 4',
  '7. seven\n8. eight\n9. nine',
  '- [ ] open\n- [x] done\n- [X] also done',
  '> first\n> second\n>\n> after an empty line',
  '> one quote\n\n> another quote',
  '```ts\nconst a = 1\n\n\nconst b = 2\n```',
  '```\n```',
  '```c++\n  indented\n```',
  'before\n\n---\n\nafter',
  '| Name | Done |\n| --- | --- |\n| **Ship** |  |\n|  | [x](https://x.test) |',
  '| Only |\n| --- |',
  '# C#\n\nC# is literal',
  '中文段落 **加粗** 和 *斜体*\n\n- 列表 🙂',
  '- \n\n1. ',
  '   leading spaces stay literal',
]

test('agent Markdown reproduces every document docFromMarkdown can produce', () => {
  for (const source of MARKDOWN_CORPUS) {
    const parsed = docFromMarkdown(source)
    const markdown = docToAgentMarkdown(parsed)
    assert.deepEqual(docFromMarkdown(markdown), parsed, source)
    assert.equal(agentMarkdownRoundTrips(parsed), true, source)
  }
})

test('the serializer writes blocks one blank line apart, quotes as consecutive lines and ordered lists from start', () => {
  const parsed = docFromMarkdown('# T\n\n4. a\n5. b\n\n> x\n> y\n\n| A | B |\n| --- | --- |\n| 1 |  |')
  assert.equal(docToAgentMarkdown(parsed), '# T\n\n4. a\n5. b\n\n> x\n> y\n\n| A | B |\n| --- | --- |\n| 1 |  |')
  assert.equal(docToAgentMarkdown(doc(p(text('lit **x**')))), 'lit **x**', 'no backslash escaping')
  assert.equal(agentMarkdownRoundTrips(doc(p(text('2 ** 3')))), true, 'a lone marker is still literal')
  const touching = doc(p(text('b', { type: 'bold' }), text('i', { type: 'italic' }), text(' a*b', { type: 'bold' })))
  assert.equal(docToAgentMarkdown(touching), '__b__*i*__ a*b__', 'underscore forms keep runs next to a * apart')
  assert.equal(agentMarkdownRoundTrips(touching), true)
})

test('editor-shaped documents round trip despite editor defaults and spacing paragraphs', () => {
  const editorDoc = doc(
    p(),
    { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
    p(),
    p(text('See '), text('docs', editorLink('https://example.com/a?b=c')), text(' and '), text('bold', { type: 'bold' })),
    p(text('quiet', { type: 'textStyle', attrs: { color: null } })),
    p(text('   ')),
    { type: 'orderedList', content: [item(p(text('no start attr')))] },
    { type: 'codeBlock', content: [text('a\n\nb')] },
    { type: 'codeBlock', attrs: { language: '' }, content: [text('empty language')] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(text('todo'))] }] },
    { type: 'blockquote', content: [p(text('q1')), p(), p(text('q2'))] },
    { type: 'table', content: [
      { type: 'tableRow', content: [cell('tableHeader', text('H1')), cell('tableHeader', text('H2'))] },
      { type: 'tableRow', content: [cell('tableCell'), cell('tableCell', text('v', { type: 'italic' }))] },
    ] },
    { type: 'horizontalRule' },
    { type: 'bulletList', content: [item(p())] },
    p(),
  )
  assert.equal(agentMarkdownRoundTrips(editorDoc), true, docToAgentMarkdown(editorDoc))
})

test('documents saved by the real editor round trip', t => {
  const source = docFromMarkdown('# Title\n\n- Ship **v1**\n- Write [docs](https://example.com)\n\n- [x] done\n\n> quote\n\n```js\nx\n```\n\n| A |\n| --- |\n| 1 |\n\n---')
  const editor = new Editor({ element: null, extensions: createJotExtensions(), content: source })
  t.after(() => editor.destroy())
  const saved = validateRichDoc(editor.getJSON())
  assert.notDeepEqual(saved, source, 'the editor adds link defaults')
  assert.equal(agentMarkdownRoundTrips(saved), true)
})

test('content the Markdown subset cannot express is readable but never claims a faithful round trip', () => {
  const cases: Array<[string, RichDoc, string]> = [
    ['hard break', doc(p(text('a'), { type: 'hardBreak' }, text('b'))), 'a\nb'],
    ['nested list', doc({ type: 'bulletList', content: [item(p(text('outer')), { type: 'bulletList', content: [item(p(text('inner')))] })] }), '- outer\n  - inner'],
    ['second paragraph in item', doc({ type: 'bulletList', content: [item(p(text('one')), p(text('two')))] }), '- one\n  two'],
    ['column width', doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { ...cellAttrs, colwidth: [180] }, content: [p(text('A'))] }] }] }), '| A |\n| --- |'],
    ['merged cell', doc({ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { ...cellAttrs, colspan: 2 }, content: [p(text('wide'))] }] },
      { type: 'tableRow', content: [cell('tableCell', text('a')), cell('tableCell', text('b'))] },
    ] }), '| wide |  |\n| --- | --- |\n| a | b |'],
    ['body cell in first row', doc({ type: 'table', content: [{ type: 'tableRow', content: [cell('tableCell', text('A'))] }] }), '| A |\n| --- |'],
    ['image', doc({ type: 'image', attrs: { attachmentId, alt: 'Diagram' } }), '[image: Diagram]'],
    ['image without alt', doc({ type: 'image', attrs: { attachmentId, alt: '' } }), '[image]'],
    ['file', doc({ type: 'attachment', attrs: { attachmentId, caption: 'spec.pdf' } }), '[file: spec.pdf]'],
    ['text color', doc(p(text('red', { type: 'textStyle', attrs: { color: '#dc2626' } }))), 'red'],
    ['underline', doc(p(text('under', { type: 'underline' }))), 'under'],
    ['highlight', doc(p(text('mark', { type: 'highlight', attrs: { color: '#fef08a' } }))), 'mark'],
    ['bold italic', doc(p(text('both', { type: 'bold' }, { type: 'italic' }))), '__*both*__'],
    ['bold link', doc(p(text('go', { type: 'bold' }, { type: 'link', attrs: { href: 'https://x.test' } }))), '**[go](https://x.test)**'],
    ['heading syntax in a paragraph', doc(p(text('# not a heading'))), '# not a heading'],
    ['list syntax in a paragraph', doc(p(text('- not a list'))), '- not a list'],
    ['task syntax in a paragraph', doc(p(text('[x] not a task'))), '[x] not a task'],
    ['literal bold markers', doc(p(text('a **literal** b'))), 'a **literal** b'],
    ['literal pipes in a cell', doc({ type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', text('a|b'))] }] }), '| a|b |\n| --- |'],
    ['italic touching a word', doc(p(text('x'), text('y', { type: 'italic' }))), 'x*y*'],
    ['unsafe link', doc(p(text('call', { type: 'link', attrs: { href: 'tel:123' } }))), '[call](tel:123)'],
    ['adjacent lists merge', doc({ type: 'bulletList', content: [item(p(text('a')))] }, p(), { type: 'bulletList', content: [item(p(text('b')))] }), '- a\n\n- b'],
    ['code fence inside code', doc({ type: 'codeBlock', attrs: { language: null }, content: [text('a\n```\nb')] }), '```\na\n```\nb\n```'],
    ['quote holding a list', doc({ type: 'blockquote', content: [{ type: 'bulletList', content: [item(p(text('x')))] }] }), '> - x'],
  ]
  for (const [name, value, expected] of cases) {
    assert.equal(docToAgentMarkdown(value), expected, name)
    assert.equal(agentMarkdownRoundTrips(value), false, name)
  }
})

test('plain-text replacement keeps formatting only for unformatted paragraphs', () => {
  assert.equal(plainTextRoundTrips(docFromText('a\n\n# literal')), true)
  assert.equal(plainTextRoundTrips(docFromMarkdown('# Heading')), false)
  assert.equal(plainTextRoundTrips(doc(p(text('b', { type: 'bold' })))), false)
  assert.equal(plainTextRoundTrips(doc(p(text('a'), { type: 'hardBreak' }, text('b')))), false)
})
