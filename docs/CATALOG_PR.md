# Catalog PR description

Title: **plugin-catalog: update Jot to 0.3.1**

Substitute `@FULL_COMMIT_SHA@` with the reviewed release commit after checks pass. Use the same commit for image URLs.

---

## What does this PR do?

Updates `plugin-catalog/jot.yaml` from Jot 0.2.0 to 0.3.1, pinned to `@FULL_COMMIT_SHA@` in https://github.com/Totoro-qaq/hermes-jot.

- Adds user-typed `/jot ai on|off|status` and a note-library summary outside Desktop (introduced in 0.3.0).
- Includes complete notices for dependencies inlined in docx and the vendored SVG icon paths. Versioned license sources participate in the build fingerprint and package freshness check.
- Asks the agent to read the note fresh in each editing turn and adds explicit `needs_refresh` / `applied: false` information to rejected tool writes. The original HTTP-style 409 and error are retained, with guidance to read again and reconsider the edit before retrying. Existing hosts retain their existing error display.

The entry still points to the same repository and declares the same six tools. AI collaboration defaults to off. Notes remain profile-scoped; only users can enable collaboration and undo agent edits.

## Scope and validation

Only `plugin-catalog/jot.yaml` changes in this PR: version, exact commit and image references. The package includes its compiled Desktop/editor/engine assets and license texts.

Before publishing this template, record the completed release checks: Linux/macOS/Windows CI, type checking, core and Python/API tests, compiled Desktop-module loading, source and extracted-archive Hermes validation, isolated package checks, and the catalog validator. Detailed evidence and compatibility limits are in https://github.com/Totoro-qaq/hermes-jot/blob/@FULL_COMMIT_SHA@/docs/VALIDATION.md.

## Compatibility

Requires Hermes >=0.21.5 with the current SandboxedFrame and gateway download SDK, and Node.js 22.19+. The package uses fixed-argument local Node subprocesses and an isolated editor frame, with no model credentials, self-updater or telemetry. Word attachments download or open in the default application on the tested host.

Screenshot assets are the existing 0.2.0 native Hermes captures using synthetic notes; this patch release does not replace them.
