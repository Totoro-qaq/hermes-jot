# Local validation

Date: 2026-10-07, Asia/Shanghai. These are separate evidence levels, not a blanket completion claim.

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
| Catalog submission | Template/material preparation only; repository decision belongs to user | Not submitted |

This records local submission preparation, not public publication or catalog approval. Public repository selection, the exact published commit pin and maintainer review remain external steps. Native checks use the actual host, not standalone previews. Initial native loading exposed a bundled ReactDOM/CommonJS failure; the host list now uses virtual-core with the host React singleton, and a compiled ESM evaluation check covers registration. Native visual inspection also exposed missing isolated-editor styles; the editor now mounts its own stylesheet and defines its table-control gutter. Table chrome uses the isolated editor’s own ReactDOM portal into its table node view; it is not placed in the viewport-level menu overlay. Narrow tables anchor add-column/options to their visible right edge.

## Host

The repaired source-built Hermes Desktop is based on `cd94de7ea4` (displayed identity `0.21.5+8136.gcd94de7`, dated `2026.9.24`), macOS arm64. Node 22.23.1; managed Python 3.14.7.

Windows/Linux code paths and modifier conventions are included. A Linux/macOS/Windows CI matrix is prepared locally; no remote repository exists yet, so that matrix has not run. Native Windows/Linux application behavior has not been tested on physical hosts.

## Evidence handling

Raw local test/model logs stay in gitignored `artifacts/`. Public materials must contain only synthetic note content, concise outcomes and relevant version identifiers. Credentials, configuration files, private conversations, machine identifiers and personal filesystem paths must not enter the package or catalog submission.

## Scope limits

Profile routing was tested through real Hermes profile context plus delayed frontend upload/download/draft isolation tests; no additional personal profile or credential configuration was changed for a manual profile-switch test. The native screenshot conversations used the configured model, with no tool use requested. The three slash commands produced the host’s “no output” command notices, not model responses.

The host installation was source-built; Jot made no Hermes core changes. Older Desktop bundles without the SDK features named in the README fail with an upgrade message.
