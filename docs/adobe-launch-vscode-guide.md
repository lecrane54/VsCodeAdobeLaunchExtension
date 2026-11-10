# Launch Tags Editor for Adobe Experience Platform — Install & User Guide

**Extension:** `lecrane.launch-tags-editor` · **Requires:** VS Code 1.85 or newer

This extension mirrors an Adobe Launch (Reactor) property onto disk as plain JSON + JavaScript
files, lets you edit them with the full editor — search, diff, autocomplete — and pushes the
changed resources back to Reactor. Everything happens against the Reactor API directly; there is
no Python or CLI dependency.

---

## 1. Before you install

You need an **Adobe IMS OAuth Server-to-Server** credential that can see your Launch company.

1. Go to [developer.adobe.com/console](https://developer.adobe.com/console) → your project.
2. Add (or open) the **OAuth Server-to-Server** credential.
3. Copy the **Client ID** and **Client Secret**.
4. Make sure the credential's product profile grants access to Adobe Experience Platform
   Launch/Data Collection for the company whose property you want to edit. If it doesn't, sign-in
   succeeds but no companies come back.

Generate your **own** credential rather than sharing one — Reactor stamps `updated_by_email` from
the credential, so a shared key makes every edit look like it came from the same person.

---

## 2. Install it in VS Code

The simplest way is the **VS Code Marketplace**: open the Extensions view, search for
**Launch Tags Editor**, and click **Install** — or run
`code --install-extension lecrane.launch-tags-editor`. Marketplace installs update automatically.
Cursor, VSCodium and other editors that use Open VSX can install it the same way from there.

To install a specific version instead, download its `launch-tags-editor-v<version>.vsix` from the
[GitHub Releases](https://github.com/lecrane54/VsCodeAdobeLaunchExtension/releases) page and use
one of the methods below. A `.vsix` install does **not** update automatically.

Everything below works the same in VS Code Insiders, Cursor, VSCodium, and Windsurf — each keeps its
own extension list, so installing in one does **not** install it in the others.

### Method A — Extensions view (recommended)

1. Open VS Code.
2. Open the **Extensions** view: <kbd>⇧⌘X</kbd> (macOS) / <kbd>Ctrl+Shift+X</kbd> (Windows/Linux),
   or the squares icon in the Activity Bar.
3. Click the **`…`** (Views and More Actions) button at the top-right of the Extensions panel.
4. Choose **Install from VSIX…**.
5. In the file dialog, select the downloaded `.vsix`.
6. Wait for the "Completed installing Launch Tags Editor for Adobe Experience Platform extension from VSIX" notification. If VS Code
   offers **Reload Window** (or **Restart Extensions**), accept it.

### Method B — Drag and drop

Open the Extensions view and drag the `.vsix` from Finder/Explorer straight onto the
extensions list. Same result as Method A, fewer clicks.

### Method C — Command line

```bash
code --install-extension /path/to/launch-tags-editor-v<version>.vsix
```

**The `code` command isn't on your PATH right now.** Two ways to fix that:

- *Add it once:* in VS Code, Command Palette (<kbd>⇧⌘P</kbd>) →
  **Shell Command: Install 'code' command in PATH**. Open a new terminal afterwards.
- *Or skip it and use the full path:*

  ```bash
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    --install-extension "$(pwd)/launch-tags-editor-v<version>.vsix"
  ```

Useful CLI companions: `code --list-extensions --show-versions | grep launch-tags` to confirm the version,
and `code --uninstall-extension lecrane.launch-tags-editor` to remove it.

### Verify the install took

- The Extensions view, filtered with `@installed launch tags`, shows **Launch Tags Editor for
  Adobe Experience Platform** from the **lecrane** publisher.
- A rocket-ish **Launch Tags** icon appears in the Activity Bar (left rail).
- Command Palette → type `Launch Tags` → you see the full command list (Sign in, Pull property, …).
- View → Output → pick **Launch Tags** from the dropdown → the channel ends with
  `Launch Tags extension activated.`

The extension activates on `onStartupFinished`, so it comes up on its own with every window — you
don't need to open a Launch file to wake it.


### Where it lives on disk

| OS | Path |
| --- | --- |
| macOS / Linux | `~/.vscode/extensions/lecrane.launch-tags-editor-<version>/` |
| Windows | `%USERPROFILE%\.vscode\extensions\lecrane.launch-tags-editor-<version>\` |

VS Code Insiders uses `~/.vscode-insiders/extensions/`; Cursor uses `~/.cursor/extensions/`.
Deleting the folder by hand also uninstalls it, though the Extensions view is the cleaner route.

### Updating to a new build

Because it isn't on the Marketplace, **it will never auto-update**. To move to a newer build, install
the new `.vsix` exactly the same way — VS Code replaces the old version in place. If the version
number in `package.json` didn't change, uninstall first, then install, so VS Code doesn't keep the
cached copy. Reload the window afterwards.

### Disable or uninstall

Extensions view → **Launch Tags** → gear icon:

- **Disable** turns it off everywhere; **Disable (Workspace)** turns it off only for the current
  project — handy when a repo has nothing to do with Launch.
- **Uninstall** removes it. Your credentials in Secret Storage and any pulled
  `launch_property/` mirrors are left alone; delete those separately if you want a clean slate.

### Remote SSH, WSL, Dev Containers, Codespaces

The extension reads and writes the mirror in your workspace folder, so it must be installed on the
side where that folder lives — the **remote/container**, not your local machine. Open the remote
window first, then run the install there (the Extensions view has an
**Install in SSH: …** / **Install in WSL: …** button, and `code --install-extension` run inside a
remote terminal installs remotely). Credentials go into that host's Secret Storage, so you sign in
once per remote.

### Handing it to a teammate

Point them at the Marketplace listing, or send them a `.vsix` from GitHub Releases — that's the whole distribution. They follow Method A,
then sign in with **their own** Adobe credential (see §1). Nothing else needs to be shared, and no
credential ever travels inside the VSIX.

### Building the VSIX from source

```bash
cd vscode_extension
npm install
npm run compile        # tsc -p ./   → out/
npm run package        # vsce package --no-dependencies -o launch-tags-editor.vsix
```

`npm run watch` recompiles on save. To debug the extension itself, open `vscode_extension/` in VS
Code and press <kbd>F5</kbd> — that launches an Extension Development Host window running your
working copy, with breakpoints in `src/`. That path needs no VSIX install at all, and it's the right
way to test a change before packaging it.

### Install problems

| Symptom | Cause / fix |
| --- | --- |
| "Unable to install extension … it is not compatible with VS Code 1.8x" | The extension requires **VS Code 1.85+**. Update VS Code (Code → Check for Updates), or lower `engines.vscode` in `package.json` and repackage |
| `code: command not found` | The CLI shim isn't installed — see Method C above |
| **Install from VSIX…** missing from the `…` menu | You're looking at the wrong `…` — it has to be the one in the Extensions panel header, not the window title bar |
| Installed, but no Launch Tags icon in the Activity Bar | Reload the window (Command Palette → **Developer: Reload Window**). If it's still missing, check the icon isn't hidden: right-click the Activity Bar and re-tick **Launch Tags** |
| Commands appear but every one errors immediately | Check View → Output → **Launch Tags** and the Command Palette → **Developer: Toggle Developer Tools** console for the real error |
| Installed in the wrong editor | Cursor/Insiders/VSCodium keep separate extension lists — install into each one you actually use |

---

## 3. First run

The extension activates on startup and adds an **Launch Tags** icon to the Activity Bar. Setup is
four steps; the sidebar walks you through them and each view shows the button for whichever step
you're on. You can reopen the guided version any time with **Launch Tags: Open setup walkthrough**.

**Open a folder first.** The mirror lives inside your workspace, so pull needs a workspace root
unless you set an absolute `adobeLaunch.mirrorPath`.

### Step 1 — Sign in

Command Palette → **Launch Tags: Sign in (set credentials)**. Paste the Client ID and Client
Secret into the form. They go into VS Code **Secret Storage** (macOS Keychain / Windows Credential
Manager) — never into your workspace or git.

*Alternative:* if a `.env` file at the workspace root already defines `ADOBE_CLIENT_ID` and
`ADOBE_CLIENT_SECRET` (optionally `ADOBE_SCOPES`), the extension picks those up automatically and
you can skip signing in. Secret Storage wins when both are present.

**Launch Tags: Sign out (clear credentials)** removes the stored pair. It does not touch `.env`.

### Step 2 — Choose a property

**Launch Tags: Set active property**. The picker lists every property your credential can see —
filter by name, platform, id, or domain. If your credential sees multiple companies, you pick the
company first.

The choice is saved to **workspace** settings as `adobeLaunch.activePropertyId`, so different
projects can point at different properties. Switching property clears the active library, since
libraries belong to a property.

### Step 3 — Pull

**Launch Tags: Pull property**. This writes the mirror under
`<workspace>/launch_property/<propertyId>/`:

```
launch_property/PR8fb5…/
├── property.json
├── .launch-manifest.json          ← id → path + content hash, drives change detection
├── .baseline/                     ← shadow copy of the last pulled/pushed state (diff source)
├── rules/
│   └── Page Load__RL1a2b…/
│       ├── rule.json
│       └── components/
│           ├── 000-events-Library Loaded.json
│           ├── 001-conditions-Path Check.json
│           └── 002-actions-Custom Code.json  + .js   ← the JavaScript, as a real file
├── data_elements/
│   └── Page Name__DE9c8d…/
│       ├── data_element.json
│       └── settings.js            ← present when the data element holds custom code
└── extensions/
    └── Adobe Analytics__EX4f5e…/
        ├── extension.json
        └── settings.js
```

Folder names are `<slugged name>__<resourceId>`, so renames in Launch show up as new folders on the
next pull. Custom code is split out of `settings` into a `.js` sidecar and merged back on push —
that's what gives you syntax highlighting, search, and completion.

Pull is safe to re-run; it refreshes in place. **Pull property (fresh)** wipes the property's mirror
folder first and re-downloads everything (asks for confirmation) — use it to reset a clean baseline.

`launch_property/` is already in the repo's `.gitignore`. Mirrors are per-user snapshots; keep them
out of source control.

### Step 4 — Edit, review, push

Covered in the next section.

---

## 4. The daily workflow

### Editing

Open any mirrored `.js` or `.json` file and edit it like normal code. Two shortcuts to get around:

- **Go to resource…** (<kbd>⌘⌥L</kbd> / <kbd>Ctrl+Alt+L</kbd>) — quick-pick over every rule, data
  element, and extension by name.
- **Search rules & code…** — content-aware search across component names, settings JSON, and custom
  code. Supports filters: `kind:events|conditions|actions` and `delegate:<substring>`.
  Examples: `checkout`, `kind:events click`, `delegate:custom-code`. Matches inside code open the
  `.js`; other matches open the `.json`.

Config-only components (no custom code) open in a **settings form** instead of raw JSON — the tree
click and the **Edit config…** context action both go there. **Open raw JSON** is the escape hatch.

### Seeing what changed

Change detection is a content hash against `.launch-manifest.json`, so it notices edits made by any
tool, not just this extension.

- The **Changes** view lists every unpushed edit, grouped under its parent rule, with data elements
  and extensions in their own sections.
- The Activity Bar icon carries a **count badge**, like Source Control.
- The **status bar** shows `N unpushed changes`; clicking it focuses the Changes view.
- Changed files get an **`M` badge** in the tree and File Explorer; a changed component propagates
  the badge up to its rule folder.
- **Show what changed** (the diff icon on a change row) diffs your file against `.baseline/` — the
  last pulled or pushed content. Fully local, no round-trip, and free of server-metadata noise.
- **Revert to baseline** throws one edit away; **Revert all changes** does the lot. For a
  locally-created resource that was never pushed, reverting deletes its files.

### Pushing

1. **Push (dry-run)** — lists exactly what would be sent, writes nothing. The detail lands in the
   **Launch Tags** output channel. Worth running the first few times.
2. **Push** — confirms with a summary, then PATCHes each changed resource. Successful pushes update
   both the manifest hash and the baseline, so the change disappears from the Changes view.

Only whitelisted fields are sent, so server-managed metadata never gets clobbered:

| Resource | Fields pushed |
| --- | --- |
| Rule | `name`, `enabled` |
| Rule component | `name`, `settings`, `order`, `negate`, `rule_order` |
| Data element | `name`, `settings`, `default_value`, `force_lower_case`, `clean_text`, `storage_duration` |
| Extension | `settings` |

**What a push means in Launch.** A plain push edits the resource's *unrevised head* — it shows in
the Launch UI as a pending change but is not deployed. To actually release it, the resource has to
be revised and added to a library.

### Push to active library

**Push to active library** — the action row pinned at the top of the **Changes** view, reading
`Push 3 changes → Your Library` — does that release step for you:

1. PATCHes all local changes onto the property head.
2. Revises each affected rule, data element, and extension — a changed trigger/condition/action
   bubbles up to its parent rule — and adds the new revision to the **active development library**.
3. Offers to **build** the library immediately.

**Pushing only some of your changes.** Every change in the **Changes** view has a checkbox, ticked by
default. Untick what you aren't ready to ship and the push — and the dry run — send only what's left;
the rest stay as local changes for next time. Ticking a rule's row covers all of its
triggers/conditions/actions at once, and **Select all changes** / **Deselect all changes** in the
toolbar overflow handle the extremes. The view header shows `3 of 7 → My Library` so you can see what
is about to go where before you click.

One case is decided for you: a brand-new trigger/condition/action can't be created before the rule it
hangs off exists on Reactor, so ticking a new component silently includes its new parent rule. The
confirmation says when this happened.

It always targets `adobeLaunch.activeLibraryId` and never falls back to a bare property push. With
no active library set, the row reads **Set an active library to push** and clicking it opens the
picker, which lists existing development libraries or creates a new one. The command is also in the
Changes toolbar overflow menu, where it is greyed out until a library is active.

There is no bare push-to-property command any more. Step 1 still PATCHes the property head — that is
unavoidable, it is how Reactor works — but it is always followed by the revise-and-add step, so a
change can't be left sitting unrevised on the head where it will never deploy. The old
`adobeLaunch.push` id still resolves, and now forwards here.

The **Library** view then shows what that library actually holds, fetched from Reactor: state and
build-required status, then rules expanding into their triggers, conditions, and actions, plus data
elements and extensions with revision numbers. Use it to confirm a release contains what you expect
before building.

Extensions are revised and added just like rules and data elements — an extension settings change
that never made it into the library would be silently dropped by the build, which is exactly the
bug this flow exists to prevent.

---

## 5. Creating new resources

- **New rule…** — creates a development-state rule locally with a placeholder id. It's unpushed
  until you push it; the real Reactor id is filled in and the folder renamed automatically on the
  first successful push.
- **Add a trigger / condition / action** — every rule shows three rows in the Property tree:
  **Triggers**, **Conditions**, **Actions**. Right-click the one you want (or use its inline `+`)
  and you get a single menu item for that kind — **Add trigger…**, **Add condition (custom code)**,
  **Add action (custom code)**. The rows are always present, including when empty, so adding a
  rule's first condition is one right-click.

  **Triggers** then offer a delegate from the Core catalog (Click, Direct Call, DOM Ready, Window
  Loaded…), or **Enter delegate id…** for any `<namespace>::<kind>::<name>` id. Custom-code triggers
  open a `.js` file; configured ones open the settings form.

  **Conditions and actions are custom code only.** There's no delegate step — you name it and a
  `.js` file opens. If you need a configured condition such as Value Comparison or Domain, add it in
  the Launch UI and pull; this extension will edit it fine, it just won't create one.

- **Add trigger/condition/action…** — the `+` on the rule row itself, or the Command Palette, still
  asks which kind first (and which rule, from the Palette). Same rules apply once you pick.

Push applies creates in dependency order — new rules first, then their new components, then plain
modifications.

> Creating is supported for rules and rule components. Creating data elements or extensions, and
> deleting anything, still happens in the Launch UI.

---

## 6. JavaScript help

Inside any `.js`/`.ts` file:

- **Data element completion** — type `_satellite.getVar("` or `_satellite.setVar("` and you get a
  dropdown of every data element name in the pulled property.
- **Unknown-reference diagnostics** — a warning on `_satellite.getVar('Name')` when no data element
  with that name exists in the mirror. Deliberately conservative: it stays quiet when there's no
  mirror, and skips names containing `%` tokens or escapes. Turn it off with
  `adobeLaunch.validateDataElementRefs: false`.

Both read from the pulled mirror, so pull again after someone else adds data elements.

---

## 7. Command reference

All of these live under the **Launch Tags:** prefix in the Command Palette.

| Command | What it does |
| --- | --- |
| Sign in (set credentials) | Store Client ID + Secret in Secret Storage |
| Sign out (clear credentials) | Delete the stored credentials |
| Set active property | Pick the property all other commands act on |
| Set active library | Pick/create the development library `Push to active library` targets |
| Pull property | Mirror the property to disk (refresh in place) |
| Pull property (fresh) | Wipe the mirror folder and re-pull — destructive, confirms first |
| Push (dry-run) | Report what would be pushed; writes nothing |
| Push to active library | Push, revise, add to the active library, optionally build — disabled with no active library |
| Build active library | Build the active library and wait for the result — disabled with no active library |
| Select all changes | Tick every change in the Changes view |
| Deselect all changes | Untick every change |
| Go to resource… | Quick-pick any rule / data element / extension (<kbd>⌘⌥L</kbd>) |
| Search rules & code… | Content search with `kind:` / `delegate:` filters |
| New rule… | Create a rule locally |
| Add trigger/condition/action… | Add a component to a rule (asks which kind) |
| Add trigger… | Add a trigger to the right-clicked rule's Triggers row |
| Add condition (custom code) | Add a custom-code condition |
| Add action (custom code) | Add a custom-code action |
| Show unpushed changes | Quick-pick of changes; opens the one you choose |
| Open setup walkthrough | Reopen the four-step getting-started walkthrough |

Context-menu-only actions (right-click in the sidebar): Copy resource id, Reveal in Finder, Edit
config…, Open raw JSON, Show what changed, Revert to baseline, Revert all changes, Refresh.

---

## 8. Settings

Set these in workspace or user settings (`adobeLaunch.*`):

| Setting | Default | Purpose |
| --- | --- | --- |
| `mirrorPath` | `""` | Directory holding mirrors, one folder per property. Empty = `<workspace>/launch_property` |
| `activePropertyId` | `""` | The property id commands operate on (`PR…`). Written by *Set active property* |
| `activeLibraryId` | `""` | Development library that *Push to active library* targets; required for it. Written by *Set active library* |
| `activeLibraryName` | `""` | Cached display name for the sidebar — managed automatically |
| `scopes` | `openid,AdobeID,read_organizations,…` | IMS OAuth scopes; must match what the credential was granted |
| `pullConcurrency` | `12` | Concurrent `rule_components` fetches during pull. Lower it if Reactor rate-limits you |
| `validateDataElementRefs` | `true` | Warn on `_satellite.getVar()` names that don't exist in the mirror |

> The file watcher that auto-updates the badge and Changes view watches `**/launch_property/**`
> inside the workspace. If you point `mirrorPath` somewhere else, edits still push correctly but the
> sidebar won't refresh on its own — hit **Refresh** in the view title.

---

## 9. Troubleshooting

**"no companies visible with these credentials"** — the credential's product profile in Adobe
Developer Console has no access to a Launch company. Fix it in the console, then retry; no re-signin
needed.

**"IMS token request failed (HTTP 400): invalid_client"** — wrong Client ID/Secret, or the secret
was rotated. Sign in again with the current values.

**IMS token failure mentioning scope** — the credential wasn't granted the scopes in
`adobeLaunch.scopes`. Match the setting to what the console shows for that credential.

**"Open a folder or workspace before pulling."** — no workspace root. Open a folder, or set
`adobeLaunch.mirrorPath` to an absolute path.

**"Manifest is for PRxxx, not PRyyy. Pull first."** — the mirror folder belongs to a different
property. Pull the property you actually want.

**"no local mirror at …. Pull first."** — the active property has never been pulled in this
workspace.

**Changes view is empty but you edited a file** — the edit has to be inside the *active* property's
mirror, and detection is per-resource-hash. Cosmetic whitespace inside a JSON file still counts as a
change; reformatting won't. If you edited outside `launch_property/`, click **Refresh**.

**A push failed partway** — the output channel logs each resource as `pushed` or `FAILED` with the
Reactor error. Resources that succeeded are already reconciled; fix the failing one and push again.

**Everything looks stale** — **Refresh** in a view title re-reads disk and re-fetches the library
from Reactor. Detailed logs for every pull/push are in the **Launch Tags** output channel
(View → Output → *Launch Tags*).

---

## 10. Known limits

- Create is supported for rules and rule components only; data elements and extensions must be
  created in the Launch UI.
- Deleting a Launch resource is not supported — reverting only removes locally-created files.
- Custom code is split out of `settings.source` (and `customCode` for the Web SDK "Update Variable"
  action). Delegates that store JavaScript under some other key keep it inline in the JSON.
- The mirror is a snapshot, not a live sync. If a teammate edits in the Launch UI, pull again before
  you push, or you'll overwrite their change on the fields you send.
