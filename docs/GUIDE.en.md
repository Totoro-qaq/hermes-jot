# Guide and permissions

## Writing and organization

Open Jot through its Hermes navigation entry, side panel, composer icon or command palette. Write ordinary documents without learning Markdown. Folders are optional and named by you.

Recent shows pinned notes and a few recently edited notes; All scrolls continuously. Search covers titles and body text. Sort order, list width and layout preferences are local and separated by connection/profile.

To put the panel away, right-click its toolbar and choose the host’s **Minimize** action. The composer Jot button restores it. Hermes keeps the last tab in a zone visible, so its **Hide Jot** menu action may be refused when Jot is that zone’s only tab.

## Saving

Jot autosaves and supports ⌘S / Ctrl+S. Revision conflicts keep human drafts rather than overwrite newer server content. Expanding the side panel carries its current draft into the full workspace. Identical saves from those two views acknowledge the same committed value; genuinely different edits still keep their conflict protection.

This is shared human/agent note storage, not cloud sync or a multi-user live-editing service. Multiple windows still use revision checks.

Open Jot panels refresh when notes change: Hermes' plugin event bridge announces every saved change, including the agent's. A check every 30 seconds covers changes the bridge cannot announce, such as tools run from a messaging gateway; older Desktop builds without the bridge check every 3 seconds instead. An unchanged library is confirmed without starting the note engine.

## Attachments

Limits are 20 MiB per file, 20 files per gesture, and 500 MiB / 1,000 files per profile. Other file types are allowed; image/PDF classification checks actual bytes rather than trusting a filename.

PNG, JPEG, GIF and WebP display inline, with a 10,000-pixel edge / 40-million-pixel limit. Attachment contents are not indexed or OCR-processed.

Images display inline. Documents use the Hermes file-preview entry, download and default-application opening; Jot does not embed a second PDF reader. The tested Hermes build renders PDFs but shows a binary-file warning for Word (DOCX), so use Download or Open in default app for Word documents. Native opening uses a managed copy on the backend computer; external edits do not sync back into the note. Download instead on a headless host.

Removing a card does not immediately delete its file. Permanently deleting notes or emptying Trash removes only attachments no other note references.

## Import

**Sort and options → Import notes…** accepts `.md`, `.markdown`, `.txt` and `.zip` files; several files can be chosen at once. Notes go into the folder you are viewing, or stay unfiled.

- Markdown keeps headings, lists (including nested and numbered), checklists, quotes, code, rules, tables, bold, italic, strikethrough, code, links, underline and Jot's palette colors. A leading `# Title` becomes the note title; otherwise the file name does. Front matter is removed; wiki links and other unsupported syntax stay as text.
- In a ZIP, each top-level folder becomes a Jot folder (an existing folder with the same name is reused). Deeper folders join their top-level folder. Images and files that notes link to are imported as attachments; other files are listed as skipped.
- Jot's own Markdown library export imports back with its folders, images and file attachments. It does not carry pins, creation or edit times, Trash, AI-edit marks or undo history, or kept drafts; merged table cells come back as text.
- Limits: 100 MiB per import file, 2,000 notes and 1,000 attachments per ZIP, 4 MiB per note. Attachment and library limits still apply. Files that cannot be read are reported, and the rest are imported.

## Export

- Current note: TXT, Markdown, PDF or Word (DOCX). Markdown with attachments becomes a ZIP.
- Whole library/current folder: folder-organized ZIP, with Markdown, PDF or Word documents.
- PDFs embed offline Chinese fonts. PDF/Word embed PNG/JPEG; other files remain original attachments.
- A single export supports up to 100 attachments, with separate 50 MiB attachment/output limits.
- Library exports support up to 2,000 notes (500 for PDF) and a 200 MiB cumulative/output budget.
- PDF tables wider than eight columns become row/column-labeled text. Export is not a pixel-perfect editor replica.

Saving uses Hermes' native download API. Generated temporary files expire after one day and are cleaned during subsequent exports.

## Agent collaboration

The switch starts off and sits at the bottom of the note list. Six registered tools support search, read, create, update, task checking and soft deletion. They stay registered while the switch is off, so turning it on takes effect in conversations that are already open; until then every call is refused with a message that says where to turn it on. No tool can change the switch.

- **Reading.** The agent receives a note as Markdown, with its checklist items and current revision. The reply also says whether rewriting the whole note from that Markdown would keep everything.
- **Changing.** Precise edits replace exact visible text inside one paragraph, heading, list item, table cell or code block and leave all other formatting alone. Appending adds to the end, and new checklist items join a checklist that ends the note. Rewriting the whole note is refused when Markdown cannot represent all of it (for example images, files, colors, underline, resized table columns, nested lists or line breaks) unless the user agrees to lose that formatting. Every change requires the current revision.
- **Ask Hermes about this note** puts `Jot note “Title” (id: …)` into the message box beside the conversation, or copies it when no message box is open. Unsaved writing is saved first, so the agent reads what is on screen.
- **While you type.** If the agent appends to the note you are editing, its new blocks are added to your draft and saving continues. Any other change made elsewhere keeps your draft and asks you to choose, as before.

AI changes are marked in the list/editor. A human can restore an existing note to the complete version preceding the latest run of agent edits. Human edits clear the current AI attribution. Newly created AI notes have no pre-edit version.

Jot does not read model keys or make independent model requests. Hermes calls the model. Retrieved notes are user data, not instructions that override system constraints.

## Storage and removal

The active profile owns `plugin-data/jot/`, outside the plugin installation. Notes, backups, attachments and agent-undo records are separate. Removing the plugin does not automatically delete user data.

To move notes to another host or profile, export the library as Markdown and import the ZIP there (see Import for what an export does not carry). A complete copy of the data, including pins and AI history, still means copying `plugin-data/jot/` while nothing is writing; never overwrite an existing destination library blindly.

## Desktop containment

The editor runs inside Hermes' official opaque-origin sandbox without host storage, credentials, native bridge or networking. Its SDK parent mediates the permitted editing/file operations and profile scope. It does not inspect or patch Hermes' private UI.

A prebuilt Node engine handles storage, import and export through request-scoped subprocesses and no listening port; the export and import libraries load only for those requests. Node.js 22.19+ is required; the official Hermes PM prepares dependencies for a normal installation. Imports are staged in `plugin-data/jot/imports/` and removed after each request.

## Language and layout

Jot follows the Hermes interface language and switches with it, without reopening anything: English, Simplified and Traditional Chinese, Japanese, Arabic (right to left), Russian, French, German and Spanish; any other Hermes language shows English. Note text keeps its own language and direction, so a Chinese note stays left to right in the Arabic interface.

Jot's header rows, dividers and list follow Hermes' layout: the header line sits level with the sidebar's tab row and the side pane's header, the list and editor are separated by the same hairline Hermes uses inside panels, and the bottom row carries no extra rule.

## Themes

Jot follows Hermes’ semantic surface, text, border, accent, button, code and toast tokens. The same mapping is sent to the isolated editor after the host applies a theme, so switching palettes does not require reopening a note. The Jot brand icon retains its colors; user-selected text and highlight colors remain document content, with a dark-mode display treatment. Representative native checks cover Nous, Solarized, Catppuccin and Cyberpunk; third-party themes still determine the quality and contrast of their own tokens.
