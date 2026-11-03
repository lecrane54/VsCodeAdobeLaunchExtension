/** The pinned push row at the top of the Changes view. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Stub `vscode` before loading the tree, which imports it at module scope.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req !== 'vscode') return origLoad.call(this, req, ...rest);
  return {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    MarkdownString: class {
      constructor(v) { this.value = v || ''; }
      appendMarkdown(v) { this.value += v; return this; }
    },
  };
};

const OUT = path.join(__dirname, '..', 'out');
const { ChangesTreeProvider } = require(path.join(OUT, 'views/propertyTree.js'));
const { ChangeSelection } = require(path.join(OUT, 'views/changeSelection.js'));
const { Manifest } = require(path.join(OUT, 'local/manifest.js'));
const { canonicalJson } = require(path.join(OUT, 'local/layout.js'));
const { detectChanges } = require(path.join(OUT, 'local/push.js'));

const { check, section, done } = require('./harness');

const PID = 'PR' + 'a'.repeat(32);

function makeMirror(n) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-pushrow-'));
  const root = path.join(base, PID);
  const manifest = new Manifest({ property_id: PID, resources: {} });
  for (let i = 0; i < n; i++) {
    const id = 'RL' + String(i).repeat(32).slice(0, 32);
    const dir = path.join(root, 'rules', `rule-${i}__${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rule.json'),
      canonicalJson({ id, type: 'rules', attributes: { name: `Rule ${i}`, enabled: true } })
    );
    manifest.set(`rules/${id}`, {
      id, kind: 'rule', path: path.relative(root, dir), sha256: 'stale-so-this-is-modified',
    });
  }
  manifest.save(root);
  return { base, root };
}

function providerFor(base, library) {
  const sel = new ChangeSelection();
  const config = {
    activePropertyId: () => PID,
    mirrorRoot: () => base,
    activeLibraryId: () => (library ? 'LB1' : ''),
    activeLibraryName: () => library || '',
  };
  return { provider: new ChangesTreeProvider(config, sel), sel, root: path.join(base, PID) };
}

(async () => {
section('1. with a library and everything ticked, the row is the push button');
{
  const { base } = makeMirror(3);
  const { provider } = providerFor(base, 'Sprint 42');
  const row = provider.pushActionNode();
  check('says what it will do', row.label === 'Push 3 changes', row.label);
  check('names the destination', row.description === '→ Sprint 42', row.description);
  check('clicking pushes', row.command?.command === 'adobeLaunch.pushToLibrary', row.command);
  check('upload icon', row.icon === 'cloud-upload', row.icon);
  fs.rmSync(base, { recursive: true, force: true });
}

section('2. it sits above the changes, exactly once');
{
  const { base } = makeMirror(2);
  const { provider } = providerFor(base, 'Sprint 42');
  const roots = await provider.getChildren();
  check('first row is the action', roots[0]?.contextValue === 'adobeLaunch.pushAction', roots[0]?.label);
  check('the changes follow it', roots.length === 3, roots.map((r) => r.label));
  check(
    'only one action row',
    roots.filter((r) => r.contextValue === 'adobeLaunch.pushAction').length === 1
  );
  // It is an action, not a change — a checkbox on it would be meaningless.
  check('no checkbox', !roots[0].changeKeys, roots[0].changeKeys);
  fs.rmSync(base, { recursive: true, force: true });
}

section('3. singular reads correctly');
{
  const { base } = makeMirror(1);
  const { provider } = providerFor(base, 'Sprint 42');
  check('one change, not "1 changes"', provider.pushActionNode().label === 'Push 1 change', provider.pushActionNode().label);
  fs.rmSync(base, { recursive: true, force: true });
}

section('4. a partial selection is stated up front');
{
  const { base } = makeMirror(4);
  const { provider, sel, root } = providerFor(base, 'Sprint 42');
  const all = detectChanges(root, Manifest.load(root));
  sel.setSelected([all[0].key, all[1].key], false);
  const row = provider.pushActionNode();
  check('counts both sides', row.label === 'Push 2 of 4 changes', row.label);
  check('still pushes', row.command?.command === 'adobeLaunch.pushToLibrary', row.command);
  fs.rmSync(base, { recursive: true, force: true });
}

section('5. with nothing ticked it does not pretend to be a button');
{
  const { base } = makeMirror(3);
  const { provider, sel, root } = providerFor(base, 'Sprint 42');
  sel.selectNone(detectChanges(root, Manifest.load(root)));
  const row = provider.pushActionNode();
  check('says so', row.label === 'Nothing ticked to push', row.label);
  check('no command — clicking it would do nothing useful', row.command === undefined, row.command);
  check('still reports the total', row.description === '3 changes below', row.description);
  fs.rmSync(base, { recursive: true, force: true });
}

section('6. with no active library it becomes the fix, not a dead end');
{
  const { base } = makeMirror(2);
  const { provider } = providerFor(base, '');
  const row = provider.pushActionNode();
  check('names the blocker', row.label === 'Set an active library to push', row.label);
  check('clicking sets one', row.command?.command === 'adobeLaunch.setLibrary', row.command);
  check('warns rather than invites', row.icon === 'warning', row.icon);
  fs.rmSync(base, { recursive: true, force: true });
}

section('7. no changes, no action row — the welcome view takes over');
{
  const { base } = makeMirror(0);
  const { provider } = providerFor(base, 'Sprint 42');
  const roots = await provider.getChildren();
  check('tree is empty', roots.length === 0, roots.map((r) => r.label));
  fs.rmSync(base, { recursive: true, force: true });
}

section('8. push is no longer a tiny icon in the view toolbar');
{
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const entry = pkg.contributes.menus['view/title'].find(
    (m) => m.command === 'adobeLaunch.pushToLibrary' && m.when.includes('adobeLaunchChanges')
  );
  check('still reachable from the overflow menu', !!entry, entry);
  check('but out of the icon row', entry && !entry.group.startsWith('navigation'), entry && entry.group);
}

done();
})();
