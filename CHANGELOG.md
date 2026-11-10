# Changelog

All notable changes to Launch Tags Editor for Adobe Experience Platform.

## [Unreleased]

### Fixed

- Choosing a property or library with no folder open no longer fails with
  "Unable to write to Workspace Settings because no workspace is opened". The
  choice is saved to user settings instead, and still saved per workspace when
  a folder is open. Pulling still needs a folder, or `adobeLaunch.mirrorPath`.

## [0.13.0] — 2026-11-10

### Added

- **Mobile properties.** Mobile (and edge) properties now pull, edit and push
  on their own terms instead of being treated as web:
  - The sidebar names the platform next to the property (`My App · mobile`).
  - Adding a condition or action no longer forces Core custom code, which
    mobile rules can't run. Every kind goes through a picker of the delegates
    the property's rules already use (e.g. Mobile Core's *Lifecycle Launch*),
    or a delegate id typed by hand. The Conditions / Actions rows show
    **Add condition…** / **Add action…** in place of the custom-code entries.
  - Data element references in mobile JSON use `{%%name%%}`: names complete
    after `{%%`, and a warning flags a token naming no data element, or a
    web-style `%name%` that won't resolve on mobile. Controlled by
    `adobeLaunch.validateDataElementRefs`, like the `_satellite` checks.
  - New command **Launch Tags: Copy App ID / embed code…** reads the
    property's environments and copies the mobile App ID, a ready-to-paste
    `MobileCore.configureWith(appId:)` line for Swift or Kotlin, or, for a
    web property, its embed code.

- **Pull AEP schemas, Data Prep mappings and CJA components.** New command
  **Adobe Launch: Pull AEP schemas, mappings & CJA components** writes a
  read-only snapshot to `adobe_platform/` (next to the Launch mirror, never
  pushed): fully resolved XDM schemas and Data Prep mapping sets for each
  sandbox, and every CJA data view with its dimensions and metrics. The same
  OAuth credential is used; the IMS org is read from Reactor. Each section
  lands or fails on its own, so a credential without CJA access still gets its
  schemas, with a notification naming the Developer Console fix. Generated
  ad-hoc schemas (thousands, in a busy org) are skipped unless
  `adobeLaunch.platformIncludeAdhocSchemas` is on; `adobeLaunch.platformSandboxes`
  narrows the sandboxes and `adobeLaunch.platformMirrorPath` moves the folder.
  Usage counters are dropped and unordered id lists sorted, so an unchanged
  org re-pulls byte-identical and diffs show only real changes. Datastream
  configs aren't included: Adobe doesn't open that API to server-to-server
  credentials.

### Changed

- **Renamed to Launch Tags Editor for Adobe Experience Platform**, published as
  `lecrane.launch-tags-editor` on the VS Code Marketplace and Open VSX, so
  installs update automatically. Commands, the sidebar, settings section and
  output channel now say **Launch Tags**. Settings keep their `adobeLaunch.*`
  keys, so existing settings carry over. Because the extension id changed,
  uninstall the old `.vsix` build and sign in once more after installing.
- MIT licensed.

### Fixed

- Restored TypeScript sources missing from the repository (`auth/ims`,
  `reactor/*`, `local/layout`, `local/manifest`, `status/changeCounter`) and
  the tests `npm test` expected. Rebuilt from the 0.12.0 package; the compiled
  output matches it.

## [0.12.0] — 2026-09-22

### Added

- **Edit a library's resources from the Library view.** The pane listed what a
  library contained and stopped there — every row was a dead end, even though
  the resource each revision was cut from was sitting in the mirror. Rules, data
  elements and extensions now open their local working copy on click, and carry
  the same **Open raw JSON** / **Reveal in Finder** / **Copy resource id**
  actions the Property view has. Rows whose resource isn't in the mirror say so
  in the tooltip instead of doing nothing. Revisions themselves stay read-only,
  because they're frozen on Reactor: edit the working copy, push, then revise it
  into the library.

### Fixed

- **A pull no longer reports failure after it has already succeeded.** The diff
  baseline is written as the last step of a pull, after every resource and the
  manifest are safely on disk. If that snapshot failed, the whole pull was
  reported as failed — sending people back to re-run a pull that had in fact
  worked. On Windows it failed routinely: clearing the previous snapshot is a
  recursive delete, and OneDrive (or an on-access virus scanner) still holds the
  tree the pull just wrote, so the delete returns `EPERM`. A mirror under a
  synced Desktop hit this on **every** re-pull. The delete now retries and
  tolerates a lock, and a snapshot that still can't be written costs "show what
  changed" for that pull — reported as a warning in the output channel — instead
  of the pull itself.

- **The Changes view keeps updating when the mirror is moved.** The file watcher
  matched a workspace-relative `launch_property/**`, so pointing
  `adobeLaunch.mirrorPath` at a directory outside the workspace — the fix for a
  mirror stuck inside OneDrive, or under a too-long Windows path — silently
  stopped it firing. Edits still landed on disk but the Changes view and the
  modified badges went stale with nothing to indicate why. The watcher now
  follows the configured mirror and re-arms when the setting moves it or the
  first pull creates it.

## [0.11.0] — 2026-09-16

### Added

- **A real push button, not a 12-pixel icon.** The Changes view now pins an
  action row above the change list that reads `Push 3 changes → Sprint 42` — it
  states the count and the destination library instead of making you hover an
  icon to find out. With a subset ticked it reads `Push 2 of 4 changes`; with
  nothing ticked it says so and stays inert rather than pretending to be a
  button; with no active library it becomes `Set an active library to push` and
  clicking it opens the picker. Push has moved out of the view's icon row into
  the overflow menu, so it's still there if you want it.

- **Right-click a rule's Triggers / Conditions / Actions row to add one.** Each
  rule now shows all three rows in the Property tree — including empty ones, so
  a rule's first condition is one right-click rather than unreachable — and each
  row offers exactly one menu item for its own kind, inline `+` included.
  **Conditions and actions skip the delegate picker entirely** and go straight to
  naming, since they're always hand-written JavaScript here; triggers keep the
  full Core catalog. The rule-level "Add trigger/condition/action…" is unchanged
  and still asks which kind. Read-only rows in the Library view get no add menu.

- **Build the active library from the extension.** Building used to be reachable
  only through the "Build library now" button on the notification that appears
  after a push — and VS Code notifications dismiss themselves. Look away, or
  click "Later", and the only way to ship was the Launch UI, even though the
  Library view was already showing a "build required" warning it gave you no way
  to act on. There's now a **Build** button in the Library view toolbar. It
  confirms first, then waits for Reactor and reports whether the build actually
  succeeded rather than just saying it was triggered.
- **Push only some of your changes.** Every row in the Changes view now has a
  checkbox, ticked by default. Untick what isn't ready and the push — and the dry
  run — send only the rest; the others stay as local changes. A rule's row
  toggles all its components at once, and Select/Deselect all are in the toolbar
  overflow. Ticking a brand-new component silently includes its new parent rule,
  because a component can't be created before the rule it hangs off; the
  confirmation says when that happened.
- **The Changes view says where a push is going.** The header now reads
  `3 of 7 → My Library`, and when no library is active it says so in place of
  leaving the disabled Push button unexplained.

### Fixed

- **Commands no longer hang forever when Adobe goes quiet.** Nothing in the
  extension put a ceiling on an outbound request, and Node's `fetch` has no
  default one — a connection that opened and then stalled (VPN drop, corporate
  proxy holding the socket) left the promise pending for good. Sign in was the
  worst case: the button sat on "Verifying with Adobe…" with no error, no
  retry, and no way back. Every Reactor and IMS request now runs under a
  deadline that covers reading the response body as well, so a stall becomes a
  readable error instead of a spinner. A timed-out `GET` retries; a timed-out
  `POST`/`PATCH` does not, so a push can't be silently duplicated. The ceiling
  is `adobeLaunch.requestTimeoutSeconds` (default 30).

## [0.10.0]

### Changed

- **The sidebar names what you're working on.** The Property view row and header
  now show the property's real name ("My Property") instead of the word
  "Property" and a 34-character hex id; the id, platform, and domains moved to
  the tooltip. The Library view header shows the active library. The name is read
  from the mirror's own `property.json`, so no extra setting is stored.
- **The status bar leads somewhere at every stage.** It previously always opened
  the Changes view, which before setup only says "finish setting up first".
  Clicking now picks a property, pulls it, or opens Changes, matching what the
  item says. In-sync state gets a check icon instead of a cloud.
- **Changes and Library views are hidden until they can hold anything.** First
  run shows one view with a sign-in button instead of three, two of them
  explaining they aren't usable yet.
- **The command palette only offers commands that can work.** Push, search, new
  rule, and the rest appear once a property is pulled; sign-out and property
  commands once you're signed in.
- **Clearer command names:** "Sign in (set credentials)" → "Sign in to Adobe",
  "Push (dry-run)" → "Preview push (dry run)", and "Pull property (fresh)" →
  "Re-pull property (discards local changes)", which is what it actually does.
- **The re-pull confirmation names the property and counts the damage** — "Wipe
  the local mirror of "My Property"… 3 unpushed changes will be lost
  permanently" — rather than naming a hex id and nothing else.
- **The property picker marks the property you're already on** with a check and
  sorts it first.

## [0.9.0]

### Added

- **Push conflict detection.** Pull records each resource's Reactor `updated_at`;
  push compares it before writing. When someone else edited the same rule, data
  element, or extension in the Launch UI, the push stops and shows what changed
  and who changed it, offering *overwrite*, *skip those and push the rest*, or
  *cancel*. Cancel is the default, so a dismissed prompt never discards their
  work. Resources deleted in Reactor are reported the same way.
- **Automatic retries.** Throttled (429) and transient responses back off
  exponentially and honor `Retry-After`. Non-idempotent calls (POST, and the
  `revise` PATCH) are deliberately never replayed, so a flaky connection can't
  create duplicate rules or revisions. Retry notices go to the output channel.
- **Sign-in verification.** Credentials are exchanged for a token before they're
  stored, so a typo or a rotated secret fails in the sign-in form with a reason
  instead of surfacing later as an unrelated command failure.
- **Readable errors.** IMS and Reactor failures are translated into a sentence
  and a fix, with buttons to sign in, open the setup walkthrough, or open
  settings. Raw API text moves to the **Adobe Launch** output channel.
- Test suites for push conflicts and retry policy: `npm test`.

### Fixed

- **Partial pushes no longer orphan created resources.** A Reactor error partway
  through a push aborted before the manifest was written, so rules that had
  already been created kept their local placeholder ids — and the next push
  created them a second time. The manifest is now always persisted.
- **Extension changes pushed to a library are called out.** They save to the
  property head but are not revised into the library, so a build would have
  shipped the old settings silently. The push now warns, naming the extensions.
- `Retry-After: 0` and past `Retry-After` dates are respected instead of falling
  back to a full backoff delay.

### Changed

- The extension no longer activates on startup in every window. It activates on
  its views, its commands, and workspaces that contain a pulled mirror.
