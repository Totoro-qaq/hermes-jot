# Local validation — in progress

Date: 2026-10-07, Asia/Shanghai. These are separate evidence levels, not a blanket completion claim.

| Layer | Evidence | Status |
| --- | --- | --- |
| Shared note/editor domain tests | 184 Node test cases passed at the recorded run | Passed at the recorded run |
| Backend integration | Real FastAPI → Python → bundled Node engine; nine cases cover edits, revisions, undo, attachments, exports and managed native-open arguments | Passed, including real Hermes profile context; native application launch mocked |
| Real Hermes model | `mimo-v2.6-pro` observed access denied with collaboration off. A later run against the installed real-directory package exercised all six tools: create, search, read, append, check a task and soft-delete its own synthetic note; existing notes were unchanged | Passed |
| Rich-content preservation | Persisted pre-AI table matched the final table, including column widths; comparison uses the normalized document | Passed |
| Human undo | Backend user operation restored the complete pre-AI document after that real model run | Passed |
| Permissions cleanup | Restored AI collaboration to off after acceptance | Passed |
| Plugin admission validator | Manifest, capability probe, tool declarations, no core override, Desktop surface and security scan passed without warnings | Passed on the recorded source and extracted/installed package builds; recheck after edits |
| Real Desktop UI | Mac locked during first attempt | Pending — no UI acceptance claimed |
| Shortcuts, theme and tables in real host | Need actual Desktop interaction | Pending |
| Native attachment preview/download/open | API and argument handling tested; user gesture/application behavior requires Desktop | Pending |
| Screenshot assets | Chinese and English real-host images, sanitized | Pending |
| Catalog submission | Template/material preparation only; repository decision belongs to user | Not submitted |

The local candidate is not yet release-ready. The Mac lock is not a reason to substitute a standalone preview for native-host acceptance.

## Host

The repaired source-built Hermes Desktop is based on `cd94de7ea4` (displayed identity `0.21.5+8136.gcd94de7`, dated `2026.9.24`), macOS arm64. Node 22.23.1; managed Python 3.14.7.

Windows/Linux code paths and modifier conventions are included. A Linux/macOS/Windows CI matrix is prepared locally; no remote repository exists yet, so that matrix has not run. Native Windows/Linux application behavior has not been tested on physical hosts.

## Evidence handling

Raw local test/model logs stay in gitignored `artifacts/`. Public materials must contain only synthetic note content, concise outcomes and relevant version identifiers. Credentials, configuration files, real conversations, machine identifiers and personal filesystem paths must not enter the package or catalog submission.
