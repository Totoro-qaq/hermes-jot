# Changelog

## 0.2.0

### Agent collaboration
- Agents read notes as Markdown. `jot_read` also reports `replaceKeepsFormatting`, and whole-note text replacement is refused whenever Markdown cannot reproduce the stored note, unless the user agreed to lose formatting. In 0.1.0 an agent that read a note and wrote it back flattened headings, lists, quotes, bold text and links into plain paragraphs.
- `jot_update` accepts `edits`: exact find-and-replace of visible text inside one paragraph, heading, list item, table cell or code block. Surrounding formatting, tables and attachments stay untouched, and the change is attributed and undoable like other agent edits.
- **Ask Hermes about this note** puts a reference to the open note into the conversation's message box, or copies it when none is open.
- When the agent appends to the note being edited, its new blocks join the open draft instead of raising a "Draft kept" conflict.
- With collaboration off, tool calls return a message that says where to turn it on. The tools stay registered, so turning collaboration on works in conversations that are already open. Tool schemas are shorter (about 3.1K characters, down from 3.9K).

### Language and layout
- Jot follows the Hermes interface language: English, Simplified and Traditional Chinese, Japanese, Arabic (right to left), Russian, French, German and Spanish. Jot's own language option is gone. Notes keep the direction of their own text.
- Header rows, dividers and the list follow Hermes' layout: header lines line up with the sidebar tab row and side-pane headers, the list/editor divider is back, and the bottom row has no extra rule.

### Notes
- Import Markdown, text and ZIP files, including Jot's own Markdown library export, with folders, images and file attachments.
- Open panels refresh through Hermes' plugin event bridge when notes change, instead of polling every 3 seconds; a 30-second check remains as a fallback.
- Fixed: a note containing a numbered list made in the editor could not be saved.
- Fixed: checklist items an agent appended to a note ending in a checklist started a second list.
- Fixed: a saved change arriving in the open note (for example an agent's edit) moved the caret to the end of the note.
- ZIP imports read file names the way macOS and Windows archive them, including Chinese names without the UTF-8 flag.

### Engine and packaging
- The export and import libraries load only for those requests, so ordinary requests start faster. Unchanged-library checks are answered without starting the engine.
- markdown-it 15.0.2 added for imports; fflate updated to 0.8.3 (malformed ZIP64 advisory).
- CI fails when the committed bundles do not match a fresh build.
- Catalog banner image added.

## 0.1.0

First Hermes edition: notes workspace and side panel, rich editor with tables and attachments, exports, six agent tools with revision checks and human undo of AI edits.
