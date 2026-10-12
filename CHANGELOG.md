# Changelog

## Unreleased

- The editor can add, edit, open, and remove a link from the toolbar or with Ctrl/⌘K. Addresses can be a web page, email, or phone number, and the popover works from the keyboard.
- “Tidy completed items” moves checked to-dos to the bottom of each checklist, keeps their relative order, and can be undone.
- The style menu moves with the arrow keys. A note’s menu opens from the keyboard with Shift+F10 or the Context Menu key. The title and the note body show a focus ring.
- If the editor fails to load, Retry tries again. Switching notes reuses the editor frame instead of reloading it.
- When an AI edit is rejected because the note changed, the tool card explains that in the interface language. The result still includes the error code, the revision detail, and recovery instructions.
- Refresh, under the note list, loads notes changed in a chat or on another device without waiting for the fallback check.
- Switching notes keeps the last keystrokes on the note they were typed in, including when another note is opened before that edit arrives. A later visit’s edits are not replaced by an echo from the earlier visit. A selection that still belongs to the previous note is dropped, and the host clears the selection it was holding. A late edit is kept even when that note is already in a conflict. A new note is not deleted as empty while its last keystrokes are still on the way; those keystrokes keep the note. Opening a note does not save it just because the editor filled in default link attributes, list numbering, or mark order. A guest and host that disagree on the editor protocol drop the edit and record a debug log.
- Adding a link keeps the selected words, including spaces and mixed formatting. A selection that is only partly linked is linked all the way through.
- Tidying completed items is its own undo step, including keystrokes typed immediately afterward, and leaves the cursor in the same item.
- Web addresses that include a username or password are refused when they are created or opened. A library that already contains one still opens and keeps the link. Exports leave the username and password out.
- The style menu takes focus when it is opened from the keyboard, including Enter and Space. Arrow keys do not swallow a later screen-reader click. Escape returns focus to the Style button. A mouse click opens it without moving focus. In right-to-left text, the left and right arrow keys follow the reading direction.
- Removing a link compares the address and the words from when the popover opened, so changing the address in the field still removes the original link. A stored web address that includes a username or password is shown without an href, and a click or middle-click does not follow it. The boundary between two links uses the link on the right. Inserting a link at the caret keeps marks such as bold. Checking a link before applying it uses the same length check as applying it. An ordinary notice does not restart its timer when another action starts or finishes.
- Reopening a note accepts edits from the new editor, and an echo from the previous editor is still ignored. A new note is not deleted when it is opened again before the last save from the previous visit arrives. Saving or removing a link asks you to open the link again when the note changed after the popover opened. Enter or Space on the Style button no longer blocks a later screen-reader click. The column-width control ignores arrow keys that include Shift, Alt, Ctrl, or Command, and announces the width about once a second.
- A middle-click on a link opens it once through Hermes, the same as a click. Saving a link over a selection that mixes links and plain text checks each stretch's address from when the popover opened, so a link changed in the meantime is not overwritten. Leaving a table drops a column-width announcement that has not been spoken yet.
- Changing the address of a link that spans a line break keeps the break and links the text on both sides, instead of refusing the change.

## 0.3.1

- Bundled third-party notices now include docx's prebuilt dependencies and the vendored Lucide SVG paths, with the ISC and Feather MIT copyright and license texts. Versioned license sources are fingerprinted, and packaging refuses sources changed after the last build.
- Tool descriptions ask the agent to read the current note again before each editing turn. Rejected revision-conflict writes retain their original 409 / `REVISION_CONFLICT` error and add `applied: false` plus recovery instructions to read and reconsider the changes before retrying. No automatic overwrite or retry is performed.
- Existing Hermes versions continue to receive the original error; this release does not change the host's tool-result display.

## 0.3.0

- `/jot ai on`, `/jot ai off` and `/jot ai status` let users control AI collaboration from CLI, TUI and gateway chats. They share the same profile setting as the Desktop switch.
- Outside Desktop, `/jot` reports the collaboration state, note count and up to five recent note titles. Desktop's `/jot`, `/jot new` and `/jot capture` keep their existing pane-opening behavior.
- Disabled-tool messages explain both ways to enable collaboration: the Desktop switch or `/jot ai on`.
- Collaboration still defaults to off. The commands are user-typed; none of the six agent tools can change the switch.

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
