## Your property, as files

**Pull** mirrors the property into `launch_property/<propertyId>/`:

```
launch_property/PR8fb…/
├── rules/
│   └── Page Load__RL1a2b…/
│       ├── rule.json
│       └── components/
│           ├── 0-events-Library Loaded.json
│           └── 1-actions-Custom Code.js   ← real JavaScript
├── data_elements/
└── extensions/
```

Custom-code actions land as `.js`, so you get syntax highlighting, search, and
`_satellite.getVar()` completion across the whole property.

Everything you'd normally click through in the Launch UI is now greppable.

> Pull is safe to re-run — it refreshes the mirror in place. **Pull property
> (fresh)** wipes it first and starts over.
