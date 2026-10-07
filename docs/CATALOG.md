# Catalog preparation

Repository: https://github.com/Totoro-qaq/hermes-jot. Catalog acceptance is separate from repository publication; the entry is submitted to NousResearch/hermes-agent for maintainer review.

The Hermes edition is English-first: `README.md`, catalog copy and primary screenshots use English; `README.zh-CN.md` and a Chinese UI option remain available. Demo note content is English and does not replace existing notes.

Local preparation includes the package, bilingual README/screenshots, `VALIDATION.md`, the entry template and [PR description draft](CATALOG_PR.md). The official policy was refreshed on 2026-10-07 (policy blob `ca23019381c59cdc5541f7004c42803cdd6bb321`); `jot.yaml` was absent at that check. Recheck availability when publishing.

Before submitting:

- Review the recorded validation scope and host limits in VALIDATION.md; rerun checks if code changes.
- Run all domain/integration checks and `hermes plugins validate . --install-deps --json` on the exact packaged tree.
- Verify no credentials, diagnostics, machine names, personal paths or real conversation content enter tracked files/screenshots.
- Commit the compiled `desktop/plugin.js`, `runtime/worker.cjs`, `runtime/editor.html`, schemas, font/license assets and Python adapter.
- Push the reviewed commit and substitute its full 40-character SHA in the catalog entry.
- The entry must disclose the Node subprocess, profile-owned local notes, explicit default-application file opening and opaque editor frame. No updater, model credentials or runtime core patching.
- Submit one catalog YAML PR to NousResearch/hermes-agent. A package passing validation is not proof of maintainer acceptance.

Expected category: desktop. Name: jot (check availability again before submission). Version: 0.2.0. License: MIT. Tool declarations must exactly match plugin.yaml and runtime/tools.json.
