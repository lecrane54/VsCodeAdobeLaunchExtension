# Launch Tags Editor for Adobe Experience Platform

Pull, edit, and push Adobe Launch (Reactor) properties as local JSON + JS files, directly from VS Code. No Python required.

📖 Full install + usage guide: [`docs/adobe-launch-vscode-guide.md`](docs/adobe-launch-vscode-guide.md)

## Features

- **Commands:** Pull property, Push, Preview push, Sign in / Sign out, Set active property
- **Sidebar tree:** Browse the active property's rules, data elements, and extensions
- **Status bar:** Shows the sync state — and clicking it does whatever comes next: pick a property, pull it, or open the Changes view
- **Autocomplete:** Type `_satellite.getVar("` or `_satellite.setVar("` in any JavaScript file and get a dropdown of all your data element names

## Setup

1. Install **Launch Tags Editor for Adobe Experience Platform** from the Extensions view (or `code --install-extension lecrane.launch-tags-editor`). Marketplace installs update automatically. Each release's `.vsix` is also attached to the [GitHub Releases](https://github.com/lecrane54/VsCodeAdobeLaunchExtension/releases) page.
2. Command Palette → **Launch Tags: Sign in to Adobe** — paste your Adobe IMS OAuth Server-to-Server Client ID and Secret. They're checked against Adobe before being saved, so a typo or a rotated secret is caught right there. Stored in VS Code's Secret Storage.
3. Command Palette → **Launch Tags: Set active property** — pick from the properties your credentials can see.
4. Command Palette → **Launch Tags: Pull property**.

Your Adobe credentials come from Adobe Developer Console → OAuth Server-to-Server. Each user should generate their own so Reactor's `updated_by_email` reflects the actual editor.

If something fails, the notification says what went wrong and offers the fix —
the common ones are a rotated secret, a project missing the Data Collection API,
or a credential that isn't in a product profile with Launch access. Full API
responses go to the **Launch Tags** output channel.

## Workflow

1. **Pull** — mirrors the property into `<workspace>/launch_property/<propertyId>/`.
2. **Edit** — open any `.js` or `.json` file. Custom code lives in `.js` files alongside the resource's `.json`.
3. **Preview push (dry run)** — reports which resources will PATCH, plus any that conflict. No writes.
4. **Push** — PATCHes changed resources into Reactor.

### Conflicts

Push compares each changed resource against its live state in Reactor before
writing. If someone edited the same rule, data element, or extension in the
Launch UI since you pulled, the push stops and shows you what changed and who
changed it. You choose:

- **Overwrite with my version** — your copy wins; their edit is lost.
- **Skip those, push the rest** — the conflicted resources stay unpushed.
- **Cancel** (closing the dialog) — nothing is pushed. This is the default, so a
  dismissed prompt never destroys someone's work.

To take their version instead, cancel, run **Re-pull property**, and
re-apply your edit on top. A resource deleted in Reactor is reported the same
way rather than being silently recreated.

Pushed changes become *unrevised head* edits on their rules/data elements — visible in the Launch UI as pending changes but not deployed until you revise the resource and add it to a library. Do that step in the Launch UI (or via the sibling `adobe-launch-mcp` for MCP-based deployment automation).

## Settings

- `adobeLaunch.mirrorPath` — Where mirrors live. Defaults to `<workspace>/launch_property`.
- `adobeLaunch.activePropertyId` — The property id commands operate on.
- `adobeLaunch.scopes` — IMS OAuth scopes.
- `adobeLaunch.pullConcurrency` — Concurrent rule-component fetches during pull.

## Development

    npm install
    npm run compile      # type-check + build to out/
    npm test             # conflict, retry, and error-translation suites
    npm run package      # build launch-tags-editor.vsix

Reactor calls retry throttled (429) and transient responses automatically with
exponential backoff, honoring `Retry-After`. Retries of non-idempotent calls
(POST, and the `revise` PATCH) are deliberately not replayed, so a flaky network
can't create duplicate rules or revisions. Retry notices go to the **Adobe
Launch** output channel.

The extension activates on its own views and commands, and on any workspace
holding a pulled mirror (`.launch-manifest.json`) — not on VS Code startup, so
it stays out of the way in unrelated projects.

## License

MIT — see [`LICENSE`](LICENSE).
