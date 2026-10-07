# Catalog PR description

Title: **feat(catalog): add Jot notes for Hermes Desktop**

Substitute the exact commit for `@FULL_COMMIT_SHA@` after its checks pass on the public repository, and use the same commit for image URLs.

---

## What does this PR do?

Adds **Jot** to the Desktop plugin catalog: notes, checklists and documents beside Hermes that the agent can read and update safely. People edit rich text, checklists, tables and attachments in a full workspace or in a pane beside a conversation. An optional switch lets the agent use six revision-checked `jot_*` tools; every AI change is marked and can be undone in one click.

Plugin repository: https://github.com/Totoro-qaq/hermes-jot
Pinned commit: `@FULL_COMMIT_SHA@` · version `0.2.0` · MIT

This is my Hermes integration of [DSH Jot](https://github.com/Totoro-qaq/dsh-jot). The shared document/storage/export core and asset provenance are recorded in `UPSTREAM.json`. It is not derived from a bundled Hermes plugin or an existing catalog entry.

## Changes made

Only `plugin-catalog/jot.yaml`: repository and exact commit pin, Desktop category, English description, banner and screenshots, six declared tools and compatibility notes. No core, installer or validation changes.

## Disclosure

- Notes and attachments live in Hermes' profile-scoped `plugin_data_dir("jot")`, outside the plugin installation. AI collaboration is off by default; the tools stay registered but refuse every call until the user turns it on, and no tool can turn it on.
- Uses the authenticated plugin API and a bundled Node.js engine. Each request runs a short-lived fixed-argument subprocess with JSON stdin/stdout; no shell evaluation, extra listening port or model credentials are forwarded. Imports are staged in `plugin-data/jot/imports/` and deleted after the request.
- After a note changes, the backend calls `hermes_cli.plugin_events.broadcast_plugin_event("jot", "notes.changed", {})` so open Jot panels refresh; the payload is empty. Unchanged-library checks are answered from the files' hashes without starting Node (POSIX only).
- The host-facing Desktop module uses the public SDK and host React (`host.onEvent`, `host.composer.insertText` for "Ask Hermes about this note", clipboard fallback). The rich editor runs in the SDK's opaque `SandboxedFrame` with bundled dependencies and restrictive CSP. No internal host-store/markup access or runtime core overrides.
- Uploads, imports and opening attachments in another application require a user action. `open`, `xdg-open` or `os.startfile` receives only a verified managed attachment copy. No agent tool opens applications.
- No independent model calls, credential-store reads, self-updater or telemetry. The AI switch governs the registered tools, not operating-system filesystem access.

## Validation

- Public repository CI on Linux, macOS and Windows: types, Node tests, compiled Desktop module check, a check that the committed bundles match a fresh build, Python/API integration, packaging and isolated exports and imports.
- `hermes plugins validate --install-deps` passes on the source and the extracted package: capabilities match, security scan `safe`, no warnings.
- Official catalog schema validation passes for this entry.
- Native macOS Hermes Desktop: import (including a Finder/`ditto` ZIP with Chinese names), editing, Ask Hermes, live updates between panes, and a real configured model using the tools through Hermes tool search with revision checks, AI marks and undo. Details and limits: [VALIDATION.md](https://github.com/Totoro-qaq/hermes-jot/blob/@FULL_COMMIT_SHA@/docs/VALIDATION.md).

### Compatibility limits

Tested host: source build `cd94de7ea4`, displayed as `0.21.5+8136.gcd94de7`, macOS arm64. Requires current Desktop SDK support for SandboxedFrame, pane reveal/visibility and gateway downloads, and Node.js 22.19+.

Windows/Linux run the automated CI suite, but native Desktop interaction has not been tested on physical hosts. The tested Hermes host renders PDF but not DOCX; Word files can be downloaded or opened in the default application. No separate Web Dashboard UI or multi-user/cloud sync.

## How to test

```sh
hermes plugins install https://github.com/Totoro-qaq/hermes-jot --ref @FULL_COMMIT_SHA@
```

Enable the backend and Desktop component, open Jot, create a note with a table, then turn on AI collaboration and use **Ask Hermes about this note** beside a conversation.

## Screenshots

Real Hermes Desktop captures using synthetic demo notes and conversations; English-first, with separate Chinese material in the repository.

![Jot](https://raw.githubusercontent.com/Totoro-qaq/hermes-jot/@FULL_COMMIT_SHA@/assets/readme/banner.png)
![Workspace](https://raw.githubusercontent.com/Totoro-qaq/hermes-jot/@FULL_COMMIT_SHA@/assets/readme/workspace.en.jpg)
![Conversation pane](https://raw.githubusercontent.com/Totoro-qaq/hermes-jot/@FULL_COMMIT_SHA@/assets/readme/sidebar.en.jpg)

## Checklist

- [x] Read the contributing guide and catalog admission rules; searched existing catalog entries, open/closed PRs and issues for Jot.
- [x] Only catalog metadata changes; conventional commit; exact immutable SHA.
- [x] Plugin validation and catalog schema pass; screenshots and behavior disclosures included.
- [x] Platform limits, tool permissions and compatibility requirements documented.
- Hermes core tests, config examples, architecture changes and new core tests: N/A for a single catalog-entry addition. The plugin tests and catalog-specific validators above cover this change.
