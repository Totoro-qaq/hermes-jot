# Local validation

These are separate evidence levels, not a blanket completion claim.

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
| Cleanup | Collaboration switched back off, test notes moved to Trash, test folder removed; the existing notes were not modified | Done |

Not covered natively for 0.2.0: Windows and Linux Desktop, and new screenshots. The README screenshots are from 0.1.0 and the side-panel image shows three `/jot · (no output)` host notices.

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
