# Local validation

These are separate evidence levels, not a blanket completion claim.

## 0.4.1

Date: 2026-10-15, Asia/Shanghai. This patch removes private Hermes language/session imports and keeps the six tools, collaboration default and stored note format unchanged.

- Type checking, 354 Node tests, the full build and the compiled Desktop-module probe passed. The probe checks bare `/jot` forwarding, explicit open/new/capture, attachment retention, failed health checks and profile/connection changes.
- All 39 Python/API tests passed in the isolated Hermes 0.22.1 PM environment. Standalone CI skips the two cases that require real Hermes profile APIs.
- Two real profiles passed eight checks each in `in_process` and `plugins.isolation: host` modes, including separate plugin child processes, profile language overrides, live configuration changes, revision-conflict preservation, command handlers and isolated note data. These handler checks do not claim to test the Desktop gateway's slash dispatcher.
- The Hermes 0.22.1 admission validator passed with a safe security scan and no private-import warnings. The package freshness gate includes the changed Python adapter and rebuilt Desktop bundle.
- Native macOS Desktop opened Jot and consumed the rewritten `/jot open` draft. Its 0.22.1 canonical gateway then returned `unsupported_command`; an exact original Jot 0.4.0 bundle reproduced the same error for bare `/jot`. The generic host fix is [84662a1](https://github.com/NousResearch/hermes-agent/commit/84662a1c2d74307588c8bee5be5ae8ad263aff33), with [ff5a49a](https://github.com/NousResearch/hermes-agent/commit/ff5a49a89e7e95ea590fcd4f9562244f3b759063) correcting profile-specific routing. Stock 0.22.1 native slash execution is not marked passed.

No model request or credential was needed for this patch's checks. The earlier 0.4.0 note-editing and real-model acceptance remains separate evidence. Native checks used a local build of the official Hermes 0.22.1 source (`297552a9d646119871391d202509822cd86330df`), not a signed-installation upgrade or a Windows/Linux Desktop run. Hosted CI and the exact release assets are linked from the release; catalog merge remains maintainer-controlled.

## 0.4.0

Date: 2026-10-12, Asia/Shanghai. This release adds link editing, checklist tidy and editor keyboard access. It does not change the six agent tools or the collaboration default.

- TypeScript, all 354 Node tests, the full build, and the compiled Desktop-module check passed. All 32 Python/API tests passed (one real-host case skipped outside Hermes).
- The isolated archive passed Chinese rich-note persistence, TXT/Markdown/PDF/DOCX exports, Markdown/ZIP imports, and packaged-documentation link checks. Linux, macOS and Windows CI on the release commit is the remaining hosted gate.
- Credential links already stored in a note stay in the document, render without an href, and exports omit the username and password. `javascript:` links stay rejected.

These are local automated checks, not a new Hermes admission run or native Desktop acceptance. Earlier native checks below retain their recorded version and scope. Catalog acceptance stays a separate maintainer review.

## 0.3.1

Date: 2026-10-11, Asia/Shanghai. This patch release completes bundled license notices and gives the agent explicit recovery guidance for rejected stale-revision writes.

- TypeScript, all 327 Node tests, the full build, and the compiled Desktop-module check passed. All 32 Python/API tests passed through the installed Hermes runtime, with isolated temporary note directories.
- The regression covers a human checklist change after the agent's read: the stale write preserves the complete saved state, returns the original 409/error with `applied: false`, and directs a new read. A reconsidered retry preserves the human change, and undo removes only that retry while retaining the earlier collaboration. No automatic retry is implemented.
- The regenerated inventory contains 120 license files, including Lucide's ISC and Feather's MIT notices. The versioned license source participates in the build fingerprint and package freshness checks; rebuilding recreates the generated notice.
- Hermes admission validation passed on the source tree and extracted archive: security scan `safe`, capability declarations matched, and no warnings.
- The isolated archive passed Chinese rich-note persistence, TXT/Markdown/PDF/DOCX exports, Markdown/ZIP imports, and packaged-documentation link checks.

These are local automated and Hermes-runtime checks, not a new provider-account or native Desktop acceptance run. Existing hosts keep their current tool-error display. The plugin does not require a host patch; hosted CI, publication, and catalog acceptance remain separate gates.

## 0.3.0

Date: 2026-10-11, Asia/Shanghai. This release adds user-typed `/jot ai on|off|status` commands and a library summary outside Desktop.

- `python3 scripts/check.py --package` passed: TypeScript, 321 Node tests, full build, compiled Desktop module check and all 32 Python/API tests through the Hermes runtime.
- Command tests cover on/off/status, invalid arguments, shared Desktop settings, CLI/TUI/gateway context detection, unchanged Desktop pane-opening behavior and the boundary that agent tools cannot enable collaboration.
- Hermes admission validation passed on both the source tree and the extracted archive: security scan `safe`, capability declarations matched, no warnings.
- The isolated archive passed Chinese rich-note persistence, TXT/Markdown/PDF/DOCX exports, Markdown/ZIP imports and packaged-documentation link checks.

These are local automated and Hermes-runtime checks. This release does not add a new native Desktop or provider-account model run; earlier native checks below retain their recorded version and scope. Hosted CI and catalog acceptance are separate gates.

## 0.2.0

Date: 2026-10-07, Asia/Shanghai. Same macOS host as 0.1.0 (below).

| Layer | Evidence | Status |
| --- | --- | --- |
| Automated checks | 321 Node tests (including a check that every interface string is translated into all eight other languages with matching placeholders), 29 Python/API tests (one real-host case skipped outside Hermes), TypeScript, compiled Desktop module check, rebuilt bundles identical to the committed ones | Passed at the recorded run |
| Hermes admission validator | Source tree and extracted package: tools/hooks/middleware match, security scan `safe`, no core override, Desktop surface inside the SDK, no warnings | Passed |
| Packaged engine | Isolated archive: TXT/Markdown/PDF/DOCX exports and Markdown/ZIP imports through `runtime/worker.cjs` and the lazily loaded `runtime/library.cjs` | Passed |
| Independent review | Six review dimensions over the full 0.2 diff; 15 findings confirmed by at least two of three independent skeptics, all fixed and re-verified. Each non-English catalog was reviewed separately for natural wording and consistent terms | Fixed |
| Real Desktop: import | Native file picker imported a Markdown file (front matter, bold, link, strikethrough, numbered list, checklist, table) and a ZIP made by macOS `ditto` with UTF-8 names and no UTF-8 flag: Chinese folder, title and image restored | Passed |
| Real Desktop: numbered lists | A numbered-list edit in the editor saved (it failed with `Unsupported ordered list attrs field: type` in 0.1.0) | Passed |
| Real Desktop: agent | **Ask Hermes about this note** put the note reference into the conversation's message box. `MiMo V2.6 Pro` found the tools through Hermes tool search, read the note and appended checklist items with `jot_update`; the note showed **AI edited** and kept attribution and undo | Passed |
| Real Desktop: live updates | Turning collaboration off in the workspace changed the switch in the side panel within about two seconds (change event); an agent edit appeared in the side panel without reopening the note; an edit written outside Hermes appeared through the 30-second fallback check | Passed |
| Concurrent typing | While text was being typed into the same note, the agent's stale-revision writes were refused and retried; the saved document kept every typed word and both agent items. The append-merge path itself was not reached in this run (the agent's write landed after an autosave), and is covered by automated tests with a real TipTap editor | Partly native |
| Caret on external change | Found during this run: a saved change arriving in the open note moved the caret to the end. Fixed (only the changed range is replaced); natively, text typed after an outside change stayed at the caret | Fixed and passed |
| Real Desktop: language | Switching the Hermes interface language (Settings or `display.language`, then reload) switched Jot's page, side panel, menus, dialogs and sidebar label: Simplified and Traditional Chinese, Japanese, Arabic, Russian, French, German and Spanish inspected. Arabic lays Jot out right to left while Chinese and English notes keep their own direction. Found and fixed during this run: German list controls overlapped in a narrow list, and a localized export's attachment folder was not recognized on import | Passed after fixes |
| Real Desktop: layout | Page header and side-pane header lines sit level with the sidebar's tab-row line; the list/editor divider is present; the bottom row has no rule; checked in the full page and the conversation side pane | Passed |
| Screenshots | New English and Chinese workspace and side-pane captures in `assets/readme/` from the 0.2.0 build: synthetic demo notes; in the side pane, **Ask Hermes about this note** put the note into the message box and `MiMo V2.6 Pro` appended two checklist items through `jot_read`/`jot_update`, shown with **AI edited**. Captured in full screen; no personal folders or conversations are visible | Captured and inspected |
| Cleanup | Collaboration switched back off, test notes moved to Trash, test folder removed; the existing notes were not modified | Done |

Not covered natively for 0.2.0: Windows and Linux Desktop.

## 0.1.0

Date: 2026-10-07, Asia/Shanghai.

| Layer | Evidence | Status |
| --- | --- | --- |
| Shared note/editor domain tests | 188 Node test cases passed at the recorded run | Passed at the recorded run |
| Backend integration | Real FastAPI → Python → bundled Node engine; nine cases cover edits, revisions, undo, attachments, exports and managed native-open arguments | Passed, including real Hermes profile context; native application launch mocked |
| Real Hermes model | `mimo-v2.6-pro` observed access denied with collaboration off. A later run against the installed real-directory package exercised all six tools: create, search, read, append, check a task and soft-delete its own synthetic note; existing notes were unchanged | Passed |
| Rich-content preservation | Persisted pre-AI table matched the final table, including column widths; comparison uses the normalized document | Passed |
| Human undo | Backend user operation restored the complete pre-AI document after that real model run | Passed |
| Permissions cleanup | Restored AI collaboration to off after acceptance | Passed |
| Plugin admission validator | Manifest, capability probe, tool declarations, no core override, Desktop surface and security scan passed without warnings | Passed on the recorded source and extracted/installed package builds; recheck after edits |
| Real Desktop UI | Native full page and side pane, English default and Chinese switching, create/save, `/jot`, `/jot new`, `/jot capture`, minimize/reopen, and dirty-draft expansion observed | Passed on the macOS host below |
| Input and handoff regression | Before the fix, 118 native input characters reached the editor but only 94 remained. Version checks now run when React applies the host update; the same input persisted all 118 characters. Dirty expansion retained exact text and both panes settled to Saved | Passed; regression tests cover delayed application and identical concurrent store saves |
| Shortcuts, theme and tables in real host | macOS select-all/cut/paste, bold/italic/underline, undo/redo and save observed; table insertion, append actions and auto-fit observed; selected-row/column indicators visually verified at the actual table after the portal fix | Passed on macOS; three commands were bound and triggered, then restored to their original unbound defaults, title capture appended selected text, find matched body/table text, sequential table-cell input stayed intact, column width changed from auto to 284px and persisted, dark theme inspected |
| Theme changes | Native Nous light/dark, Solarized light, Catppuccin dark and Cyberpunk dark inspected; editor colors and typography updated, Cyberpunk dialog and filled-button text remained readable | Passed on these representative built-in themes; arbitrary third-party palettes are not individually certified |
| Native attachment preview/download/open | Native picker uploaded PNG/PDF/DOCX/TXT; sequential inserts retained all four. Hermes rendered the PDF, macOS Preview opened its managed copy, downloaded bytes matched the original | Passed for these types/actions; Hermes does not render Word (DOCX), which offers a binary warning |
| Screenshot assets | Separate English and Chinese workspace/side-pane JPEGs in `assets/readme/`; native screenshots include real model responses to synthetic demo prompts. Personal directory/status details hidden for capture | Completed and visually inspected |
| Catalog submission | Public repository and entry materials prepared; a separate upstream PR pins the reviewed commit | Maintainer acceptance is separate from publication |

Native checks use the actual host, not standalone previews. Catalog acceptance is determined by upstream maintainer review. Initial native loading exposed a bundled ReactDOM/CommonJS failure; the host list now uses virtual-core with the host React singleton, and a compiled ESM evaluation check covers registration. Native visual inspection also exposed missing isolated-editor styles; the editor now mounts its own stylesheet and defines its table-control gutter. Table chrome uses the isolated editor’s own ReactDOM portal into its table node view; it is not placed in the viewport-level menu overlay. Narrow tables anchor add-column/options to their visible right edge.

## Host

The repaired source-built Hermes Desktop is based on `cd94de7ea4` (displayed identity `0.21.5+8136.gcd94de7`, dated `2026.9.24`), macOS arm64. Node 22.23.1; managed Python 3.14.7.

The [hosted CI matrix](https://github.com/Totoro-qaq/hermes-jot/actions/workflows/ci.yml) runs on Linux, macOS and Windows. Each platform checks types, core tests, the compiled Desktop module, Python/API integration, packaging and independent package exports. The Hermes profile-context test requires the real host environment: it passed locally and is explicitly skipped in standalone CI. The required `CI` gate passes only when every platform passes. Native Windows/Linux Desktop application behavior remains untested on physical hosts.

The first Windows CI run found a verification-script encoding error while reading Chinese engine output. The scripts now explicitly decode subprocess text as UTF-8; the production bridge already handles the engine protocol as UTF-8 bytes.

## Evidence handling

Raw local test/model logs stay in gitignored `artifacts/`. Public materials must contain only synthetic note content, concise outcomes and relevant version identifiers. Credentials, configuration files, private conversations, machine identifiers and personal filesystem paths must not enter the package or catalog submission.

## Scope limits

Profile routing was tested through real Hermes profile context plus delayed frontend upload/download/draft isolation tests; no additional personal profile or credential configuration was changed for a manual profile-switch test. The native screenshot conversations used the configured model, with no tool use requested. The three slash commands produced the host’s “no output” command notices, not model responses.

The host installation was source-built; Jot made no Hermes core changes. Older Desktop bundles without the SDK features named in the README fail with an upgrade message.
