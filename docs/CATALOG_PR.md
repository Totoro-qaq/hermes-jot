# Catalog PR draft — not submitted

Title: **Add Jot: editable notes for Hermes Desktop**

Replace the exact commit in `catalog-entry.yaml.in` after its checks pass on the public repository. Use that same immutable commit for screenshot URLs. Recheck the catalog name before submission.

---

Jot adds a full notes workspace and a pane beside Hermes conversations. People can edit rich text, checklists, tables and attachments directly; optional agent collaboration provides six revision-checked note tools and a human undo action for AI edits. English is the default, with a Chinese UI option and separate documentation/screenshots.

This is the Hermes integration of my MIT-licensed [DSH Jot](https://github.com/Totoro-qaq/dsh-jot), reusing the document/storage/export core with a Python tool/API adapter and a Desktop SDK interface. It is not a fork of a bundled Hermes plugin. Provenance is recorded in `UPSTREAM.json`.

## Disclosure

- Uses Hermes' authenticated, profile-scoped plugin API and `plugin_data_dir`. Notes and attachments are local to that profile; they are not stored in the plugin installation directory.
- Runs a bundled Node.js engine as a short-lived child process with fixed arguments and JSON over stdin/stdout. It opens no additional listening port and does not pass model credentials to the child.
- Uploads are explicit user actions. Preview/download copies are managed by Jot. “Open in default app” invokes `open`, `xdg-open` or `os.startfile` on a verified managed copy, only after the user clicks it; no corresponding agent tool is exposed.
- The host-facing module uses the public SDK and host React. The rich editor runs in the SDK's opaque `SandboxedFrame` with its own bundled runtime and restrictive CSP; it receives only note editing messages, theme values and explicitly requested attachment data.
- No telemetry, updater, independent model/network service, credential-store access, shell command evaluation or runtime core override. AI collaboration starts off and the tools cannot enable it. The tool switch is not an operating-system filesystem sandbox.

## Validation

- TypeScript check, 188 Node tests, nine Python/API integration tests and compiled Desktop ESM registration check passed locally.
- Hermes validation passed, including dependency installation checks, matching capabilities, security scan and Desktop surface checks. The final extracted package is checked separately from the development tree.
- A real configured Hermes model exercised all six tools; access was denied with collaboration off. Appending and task changes retained the original rich content, and human undo restored it.
- Native macOS Desktop checks covered entry points, three rebindable commands, slash commands, editing/shortcuts, tables/column resizing, themes, attachments, native PDF preview/download/default-app opening, and dirty-draft expansion. README screenshots are from that host with synthetic demo content.

## Compatibility limits

- Tested Desktop baseline: source build `cd94de7ea4`, reported as `0.21.5+8136.gcd94de7`, macOS arm64. Requires current SDK support for `SandboxedFrame`, pane visibility/reveal and gateway file downloads, plus Node.js 22.19+.
- Hosted CI covers Linux, macOS and Windows, including independent package exports. Native Windows/Linux UI behavior has not been exercised on physical hosts; the real Hermes profile-context integration was validated locally and is skipped in standalone CI.
- The tested host renders PDF but not DOCX; Word attachments use download or the configured default application. External edits do not sync back into the note.
- No separate Web Dashboard UI, cloud sync, OCR, handwriting canvas or multi-user live editing.

See `docs/VALIDATION.md` for the evidence boundaries. Publication and catalog approval are not claimed by these local checks.
