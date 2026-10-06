# Guide and permissions

## Writing and organization

Open Jot through its Hermes navigation entry, side panel, composer icon or command palette. Write ordinary documents without learning Markdown. Folders are optional and named by you.

Recent shows pinned notes and a few recently edited notes; All scrolls continuously. Search covers titles and body text. Sort order, list width and layout preferences are local and separated by connection/profile.

## Saving

Jot autosaves and supports ⌘S / Ctrl+S. Revision conflicts keep human drafts rather than overwrite newer server content. Expanding the side panel should carry its current draft; native-host acceptance for this remains tracked in VALIDATION.md.

This is shared human/agent note storage, not cloud sync or a multi-user live-editing service. Multiple windows still use revision checks.

## Attachments

Limits are 20 MiB per file, 20 files per gesture, and 500 MiB / 1,000 files per profile. Other file types are allowed; image/PDF classification checks actual bytes rather than trusting a filename.

PNG, JPEG, GIF and WebP display inline, with a 10,000-pixel edge / 40-million-pixel limit. Attachment contents are not indexed or OCR-processed.

The attachment panel offers inline display, the Hermes file-preview entry, download and default-application opening. Native opening uses a managed copy on the backend computer; external edits do not sync back into the note. Download instead on a headless host.

Removing a card does not immediately delete its file. Permanently deleting notes or emptying Trash removes only attachments no other note references.

## Export

- Current note: TXT, Markdown, PDF or Word (DOCX). Markdown with attachments becomes a ZIP.
- Whole library/current folder: folder-organized ZIP, with Markdown, PDF or Word documents.
- PDFs embed offline Chinese fonts. PDF/Word embed PNG/JPEG; other files remain original attachments.
- A single export supports up to 100 attachments, with separate 50 MiB attachment/output limits.
- Library exports support up to 2,000 notes (500 for PDF) and a 200 MiB cumulative/output budget.
- PDF tables wider than eight columns become row/column-labeled text. Export is not a pixel-perfect editor replica.

Saving uses Hermes' native download API. Generated temporary files expire after one day and are cleaned during subsequent exports.

## Agent collaboration

The switch starts off. Six registered tools support search, read, create, update, task checking and soft deletion. Changes require current revisions. Replacing rich content needs explicit consent to lose formatting; appending and task updates preserve other structure.

AI changes are marked in the list/editor. A human can restore an existing note to the complete version preceding the latest run of agent edits. Human edits clear the current AI attribution. Newly created AI notes have no pre-edit version.

Jot does not read model keys or make independent model requests. Hermes calls the model. Retrieved notes are user data, not instructions that override system constraints.

## Storage and removal

The active profile owns `plugin-data/jot/`, outside the plugin installation. Notes, backups, attachments and agent-undo records are separate. Removing the plugin does not automatically delete user data.

There is no one-click cross-host migration or backup-restore flow yet. The document format is shared with Jot, but manual copying still requires stopping writers and backing up; never overwrite an existing destination library blindly.

## Desktop containment

The editor runs inside Hermes' official opaque-origin sandbox without host storage, credentials, native bridge or networking. Its SDK parent mediates the permitted editing/file operations and profile scope. It does not inspect or patch Hermes' private UI.

A prebuilt Node engine handles storage and export through request-scoped subprocesses and no listening port. Node.js 22.19+ is required; the official Hermes PM prepares dependencies for a normal installation.
