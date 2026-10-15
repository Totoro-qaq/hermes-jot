# Catalog PR description

Title: **plugin-catalog: update Jot to 0.4.1**

Substitute `@FULL_COMMIT_SHA@` with the reviewed release commit after checks pass. Use the same commit for image URLs.

---

## What changes

Updates `plugin-catalog/jot.yaml` from Jot 0.4.0 to 0.4.1, pinned to `@FULL_COMMIT_SHA@` in https://github.com/Totoro-qaq/hermes-jot. The three image references use that same commit.

Jot no longer imports the private Hermes language or session-context modules. Conflict copy reads language through public, profile-scoped APIs, including live configuration changes and existing language aliases. Its existing Desktop composer middleware forwards bare `/jot` as `/jot open`, so the Python handler no longer guesses the caller's surface. Attached/rejected drafts retain their contents.

The six tools, hooks/middleware declarations, default-off AI collaboration and note data format are unchanged. This adds no core override, network service, updater, telemetry or model credentials.

## Validation

Record the final release CI and exact pin checks before submitting: typecheck, 354 Node tests, compiled Desktop module, 39 Python/API cases (two real-Hermes cases skipped in standalone CI), isolated package verification, source/extracted-package Hermes validation and catalog schema validation. Real Hermes 0.22.1 checks exercised two profiles in both in-process and isolated plugin-host modes. The admission validator reports no private-import warnings and a safe security scan.

Detailed evidence and limits: https://github.com/Totoro-qaq/hermes-jot/blob/@FULL_COMMIT_SHA@/docs/VALIDATION.md

## Compatibility

Requires Hermes >=0.21.5 with SandboxedFrame and gateway file-download SDK support, and Node.js 22.19+. The plugin uses fixed-argument local Node subprocesses and a sandboxed editor. Word attachments download or open in the default application on the tested host.

Stock Hermes 0.22.1 Desktop rejects plugin slash execution with `unsupported_command`; the original Jot 0.4.0 reproduces the same result. The Jot button and collaboration switch remain available. Hermes main already has the generic host fix in 84662a1 and the profile-routing follow-up ff5a49a. This plugin patch does not claim to fix that host limitation.

Screenshot assets remain the existing native captures of synthetic notes.
