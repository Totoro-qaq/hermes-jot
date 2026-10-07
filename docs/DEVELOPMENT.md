# Developing Jot

This page is for people working on Jot itself. For what Jot does and how to install it, see the [README](../README.md). What has been tested, on which host and at which level, is recorded in [VALIDATION.md](VALIDATION.md).

## Repository layout

Jot is one Hermes plugin with two halves that Hermes enables separately: an agent half in Python, registered with the Hermes agent, and a Desktop half, a compiled ES module loaded by Hermes Desktop. In **Capabilities → Plugins** they are the **Agent** and **Desktop** switches in Jot's row. Jot's own **Allow AI collaboration** switch controls its note tools while keeping human editing available.

| Path | Contents |
| --- | --- |
| `plugin.yaml` | Plugin manifest: version, `requires_hermes`, the six declared tools |
| `__init__.py` | Registers the six `jot_*` tools (toolset `jot`) and the `/jot` command |
| `backend.py` | Profile-scoped bridge from Python to the bundled Node engine |
| `dashboard/plugin_api.py`, `dashboard/manifest.json` | The Desktop API, mounted inside Hermes' own authenticated server under `/api/plugins/jot`; the manifest declares only `api`, no dashboard tab |
| `native_open.py` | Opens a managed copy of an attachment in its default app, only on an explicit Desktop gesture, never from an agent tool |
| `src/` | TypeScript sources: document model, store, agent tools and edits, import and export, the engine worker, and the Desktop client (`src/client`, `src/hermes`) |
| `desktop/plugin.js` | Compiled Desktop module (committed) |
| `runtime/` | Compiled engine `worker.cjs`, the lazily loaded `library.cjs`, the sandboxed `editor.html`, `tools.json` schemas, `build-info.json` and `data/` (PDFKit font metrics), all committed |
| `tests/`, `tests_py/` | Node tests, and Python/API integration tests |
| `scripts/` | Build, check, package and local-install scripts |
| `dev/` | Sources for the icon and banner artwork |
| `docs/` | User guides, the validation record and catalog material |

The repository includes the compiled UI and engine files, so end users do not run `npm install` or need an npm package. CI rebuilds them and fails when the result differs from what is committed, so run `npm run build` and commit the output whenever you change `src/`.

## Requirements

- Node.js 22.19 or later (`engines` in `package.json`).
- The Hermes CLI (Hermes 0.21.5 or later), for the Python tests through `hermes --run-module` and for the plugin validator.
- To run the Python tests outside Hermes, as CI does: Python with `requirements-test.txt` installed.

## Checks

```sh
npm ci
npm run check
hermes --run-module unittest discover -s tests_py -v
hermes plugins validate . --json
```

`npm run check` runs the TypeScript typecheck, the Node tests, the build, and a check that the compiled Desktop module evaluates. The catalog CI gate runs the validator with dependency installation: `hermes plugins validate . --install-deps --json`.

Run `python3 scripts/check.py --package` for the complete local checks and archive. It runs the typecheck, core tests, build, Desktop module check, Python integration tests and the validator with `--install-deps`, writes a log for each step to `artifacts/`, and stops at the first failure. With `--package` it then builds the archive (`scripts/package.py`) and smoke-tests it outside the checkout (`scripts/check_package.py --hermes`). It never calls a model.

CI (`.github/workflows/ci.yml`) runs on Ubuntu, macOS and Windows: `npm ci`, `npm run check`, a check that the committed bundles match a fresh build, the Python tests, packaging and the package check. The required `CI` job passes only when every platform passes.

## Installing a local build

Install the archive with:

```sh
python3 scripts/install_local.py --home /path/to/hermes-home --replace
```

`--home` is the target Hermes data directory. Without `--replace` the script stops if Jot is already installed; with it, the existing local package is backed up first. Note data stays in place. The script verifies the archive against `artifacts/package-manifest.json`, so build it first with `scripts/check.py --package` or `scripts/package.py`.

Use a real directory: Desktop unified-package discovery does not follow development symlinks.

After installing, turn on **Desktop** in Jot's row under **Capabilities → Plugins** (click **Rescan** if the row says *copying…*), and turn on the agent half there or with `hermes plugins enable jot`. Jot overrides no core tools, so no tool-override flag is needed. The CLI change takes effect in the next session; an already-running backend may need a restart or plugin reload.

## How it fits together

### Desktop registration

The page, side panel and composer button register through the Hermes SDK in `src/hermes/entry.tsx`: a full page at route `/jot` with a sidebar entry, a 420px right-hand pane, a composer button, and three palette commands that can also be bound to keys (Open Jot, New note, Capture selected text, with no default keys). Palette and keyboard commands open the side panel when a conversation is active and the full page otherwise. The Desktop half ships with `defaultEnabled: false`.

At load, Jot checks for the SDK features it needs (`SandboxedFrame`, gateway file download, the theme hook, pane visibility and `revealPane`) and otherwise shows “Jot requires a recent Hermes Desktop SDK with SandboxedFrame and gateway file downloads.”

`/jot`, `/jot new` and `/jot capture` are handled by Desktop composer middleware, which opens the side panel. The same command is registered on the Python side so Hermes consumes it without a model turn; any other argument returns a one-line help text.

### Note engine and IPC

The document model, persistence, revision protection, attachments and exports reuse [dsh-jot](https://github.com/Totoro-qaq/dsh-jot) (commit and version in [UPSTREAM.json](../UPSTREAM.json)). A Python adapter (`backend.py`) connects Hermes authentication, profile routing and tool registration to the bundled Node engine over standard input and output. It opens no additional server port.

- Each request starts `node runtime/worker.cjs <data directory>`, writes one JSON request to its stdin and reads one JSON response from stdout. The timeout is 90 seconds, or 300 seconds for imports.
- The engine process gets only `PATH`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `LC_ALL`: no shell and no credentials.
- `node` is the first one on `PATH`. On a normal install, Hermes' package manager puts its own Node first. If none is found, Jot reports that Node.js is required and points to `hermes pm install`.
- The data directory comes from Hermes' `plugin_data_dir("jot")`, resolved on every call so it follows the active profile.
- The export and import libraries (`runtime/library.cjs`) load only for those requests, and unchanged-library checks are answered without starting the engine.
- After each successful agent write, and after writes from the Desktop UI, Python broadcasts `notes.changed` through Hermes' plugin event bridge, and open Jot panels re-read. A 30-second check covers changes the bridge cannot announce, such as tools run from a messaging gateway; Desktop builds without the bridge poll every 3 seconds instead.

### Data layout

Everything lives in `plugin-data/jot/` under the active profile's Hermes home, never in the plugin folder, and uninstalling leaves it in place:

- `jot.json` and its backup `jot.json.bak`
- `jot.activity.json`, which records AI attribution
- `jot.agent-undo/`, the pre-AI versions kept for undo
- `attachments/`
- `imports/`, staging for imports, cleaned after each request

Directories are created with mode 0700 and files with 0600.

### Agent tools

| Tool | What it does |
| --- | --- |
| `jot_list` | Searches notes outside Trash by title or text, optionally within a folder |
| `jot_read` | Reads one note as Markdown, with its checklist items, current revision, and whether a whole-note rewrite from that Markdown would keep everything |
| `jot_create` | Creates a note from Markdown or plain text, optionally in a folder |
| `jot_update` | Exactly one of `edits` (exact find and replace inside one paragraph, heading, list item, table cell or code block), `appendText`, or `text` (a whole-note rewrite, refused when it would lose formatting unless `allowFormattingLoss` is set); can also rename or move the note. Requires the current revision |
| `jot_set_task` | Checks or unchecks one checklist item. Requires the current revision |
| `jot_delete` | Moves a note to Trash. Requires the current revision |

The tools stay registered while AI collaboration is off. Every agent call is checked under the store lock and fails with `AGENT_DISABLED` while the switch is off. The store refuses an agent that tries to change the switch, undo agent edits or permanently delete notes (`HUMAN_ONLY`), and imports always run as the user. No tool reads Trash, sets pins or reads attachment contents.

### Editor sandbox

The rich editor runs inside the official opaque-origin `SandboxedFrame`. The surrounding note workspace and host actions use the SDK. The editor is static packaged HTML (`runtime/editor.html`) with a content security policy of `default-src 'none'` and `connect-src 'none'` and a single hashed inline script. It has no host credentials, native filesystem bridge or network access, and it exchanges a bounded set of editing messages only with its owning parent component.

## Out of scope

There is no separate Web Dashboard UI, cloud synchronization, OCR, multi-user live editing or handwriting canvas. See the [guide](GUIDE.en.md) for user-facing limits.

## Documentation and the catalog

- Jot's entry in the Hermes plugin catalog pins a commit. The catalog page shows the README from that commit, so README changes appear there only after a pull request to the catalog bumps the pinned SHA; GitHub shows them as soon as they reach `main`. Users then update with `hermes plugins update jot` or from the app.
- The catalog page renders `README.md` through an allowlist. Raw HTML is dropped, relative links and images resolve against the repository at the pinned commit, and headings get no anchors, so in-page `#` links do not work there (a link into another file with a fragment, such as `docs/GUIDE.en.md#import`, opens on GitHub and works). GitHub alert syntax shows up as plain text. Keep README images relative and in `assets/readme/`.
- The catalog page already shows `assets/readme/banner.png` as its hero image and the two English screenshots as its gallery.
- The entry template and submission checklist are in [catalog-entry.yaml.in](catalog-entry.yaml.in) and [CATALOG.md](CATALOG.md).
- `scripts/package.py` ships documentation from an explicit list; add a new doc there if it should be in the archive.

## License

MIT. Provenance of the original Jot code and artwork is in [UPSTREAM.json](../UPSTREAM.json). The offline Chinese PDF fonts include their license ([OFL.txt](../assets/fonts/OFL.txt)), and bundled dependency licenses are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [LICENSES](../LICENSES).
