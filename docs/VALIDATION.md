# Local validation — in progress

Date: 2026-10-07, Asia/Shanghai. These are separate evidence levels, not a blanket completion claim.

| Layer | Evidence | Status |
| --- | --- | --- |
| Shared note/editor domain tests | 186 Node test cases passed at the recorded run | Passed at the recorded run |
| Backend integration | Real FastAPI → Python → bundled Node engine; nine cases cover edits, revisions, undo, attachments, exports and managed native-open arguments | Passed, including real Hermes profile context; native application launch mocked |
| Real Hermes model | `mimo-v2.6-pro` observed access denied with collaboration off. A later run against the installed real-directory package exercised all six tools: create, search, read, append, check a task and soft-delete its own synthetic note; existing notes were unchanged | Passed |
| Rich-content preservation | Persisted pre-AI table matched the final table, including column widths; comparison uses the normalized document | Passed |
| Human undo | Backend user operation restored the complete pre-AI document after that real model run | Passed |
| Permissions cleanup | Restored AI collaboration to off after acceptance | Passed |
| Plugin admission validator | Manifest, capability probe, tool declarations, no core override, Desktop surface and security scan passed without warnings | Passed on the recorded source and extracted/installed package builds; recheck after edits |
| Real Desktop UI | Local package loads in native Hermes; full page, English default, Chinese/English switching, note creation and save observed | Partial — remaining checks below |
| Shortcuts, theme and tables in real host | macOS select-all/cut/paste, bold/italic/underline, undo/redo and save observed; table insertion, append actions and auto-fit observed; selected-row/column indicators visually verified at the actual table after the portal fix | Passed on macOS; three commands were bound and triggered, then restored to their original unbound defaults, title capture appended selected text, find matched body/table text, sequential table-cell input stayed intact, column width changed from auto to 284px and persisted, dark theme inspected |
| Theme changes | Native Nous light/dark, Solarized light, Catppuccin dark and Cyberpunk dark inspected; editor colors and typography updated, Cyberpunk dialog and filled-button text remained readable | Passed on these representative built-in themes; arbitrary third-party palettes are not individually certified |
| Native attachment preview/download/open | Native picker uploaded PNG/PDF/DOCX/TXT; sequential inserts retained all four. Hermes rendered the PDF, macOS Preview opened its managed copy, downloaded bytes matched the original | Passed for these types/actions; Hermes does not render Word (DOCX), which offers a binary warning |
| Screenshot assets | English-first and separate Chinese real-host images, sanitized | Pending |
| Catalog submission | Template/material preparation only; repository decision belongs to user | Not submitted |

The local candidate is not yet release-ready. The remaining native checks are not replaced by standalone previews. Initial native loading exposed a bundled ReactDOM/CommonJS failure; the host list now uses virtual-core with the host React singleton, and a compiled ESM evaluation check covers registration. Native visual inspection also exposed missing isolated-editor styles; the editor now mounts its own stylesheet and defines its table-control gutter. Table chrome uses the isolated editor’s own ReactDOM portal into its table node view; it is not placed in the viewport-level menu overlay. Narrow tables anchor add-column/options to their visible right edge.

## Host

The repaired source-built Hermes Desktop is based on `cd94de7ea4` (displayed identity `0.21.5+8136.gcd94de7`, dated `2026.9.24`), macOS arm64. Node 22.23.1; managed Python 3.14.7.

Windows/Linux code paths and modifier conventions are included. A Linux/macOS/Windows CI matrix is prepared locally; no remote repository exists yet, so that matrix has not run. Native Windows/Linux application behavior has not been tested on physical hosts.

## Evidence handling

Raw local test/model logs stay in gitignored `artifacts/`. Public materials must contain only synthetic note content, concise outcomes and relevant version identifiers. Credentials, configuration files, real conversations, machine identifiers and personal filesystem paths must not enter the package or catalog submission.
