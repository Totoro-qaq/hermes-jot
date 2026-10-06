# Catalog preparation

Nothing has been submitted or published. The user will decide whether to create a GitHub repository.

Before submitting:

- Finish every pending Desktop validation item in VALIDATION.md; fix any failures and rebuild.
- Run all domain/integration checks and `hermes plugins validate . --install-deps --json` on the exact packaged tree.
- Verify no credentials, diagnostics, machine names, personal paths or real conversation content enter tracked files/screenshots.
- Commit the compiled `desktop/plugin.js`, `runtime/worker.cjs`, `runtime/editor.html`, schemas, font/license assets and Python adapter.
- After the user authorizes a public repository, push the reviewed commit and substitute its real URL and full 40-character SHA in the catalog entry.
- The entry must disclose the Node subprocess, profile-owned local notes, explicit default-application file opening and opaque editor frame. No updater, model credentials or runtime core patching.
- Submit one catalog YAML PR to NousResearch/hermes-agent. A package passing validation is not proof of maintainer acceptance.

Expected category: desktop. Name: jot (check availability again before submission). Version: 0.1.0. License: MIT. Tool declarations must exactly match plugin.yaml and runtime/tools.json.
