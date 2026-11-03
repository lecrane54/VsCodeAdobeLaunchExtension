## Edit, review, push

Edit any mirrored file and it appears under **Changes**, with a count badge on
the Adobe Launch icon in the Activity Bar.

For each change you can:

- **Show what changed** — diff your edit against what's live in Reactor
- **Revert to baseline** — throw the edit away
- **Push to active library** — send it up

Each change has a **checkbox**, ticked by default — untick anything you aren't
ready to ship and the push sends only the rest. The row pinned at the top of the
view is the push button: it reads `Push 3 changes → Your Library`, so the count
and the destination are visible before you click.

`Push (dry-run)` prints exactly what *would* be sent without sending it — the
ticked subset, same as a real push. Worth running the first few times.

### Libraries

The push button on the **Changes** toolbar always targets your **active
library**: it revises every changed resource — rules, data elements, and
extensions alike — and adds the new revision there. It
stays disabled until a library is active — set one with **Set active library**
in the same toolbar menu. The **Library** view then shows what that library
holds — every rule with its triggers, conditions, and actions — so you can
confirm the release contains what you expect before building it. The **Build**
button in that view's toolbar builds it and reports whether Reactor succeeded.

There is no bare "push to the property" any more. A push that isn't revised into
a library shows in the Launch UI as a pending change and never deploys, so every
push goes through the active library.
