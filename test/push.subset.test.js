/** Pushing a subset: the `only` filter, the selection model, and parent closure. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const OUT = path.join(__dirname, '..', 'out');
const push = require(path.join(OUT, 'local/push.js'));
const { Manifest } = require(path.join(OUT, 'local/manifest.js'));
const { canonicalJson } = require(path.join(OUT, 'local/layout.js'));
const { ChangeSelection } = require(path.join(OUT, 'views/changeSelection.js'));

const { check, section, done } = require('./harness');

const PID = 'PR' + 'a'.repeat(32);

/** A mirror with N modified rules. Mirrors push.conflicts.test.js's shape. */
function makeMirror(n) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-subset-'));
  const root = path.join(base, PID);
  const manifest = new Manifest({ property_id: PID, resources: {} });
  for (let i = 0; i < n; i++) {
    const id = 'RL' + String(i).repeat(32).slice(0, 32);
    const dir = path.join(root, 'rules', `rule-${i}__${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rule.json'),
      canonicalJson({
        id, type: 'rules',
        attributes: { name: `Rule ${i}`, enabled: true, updated_at: '2020-01-01T00:00:00Z' },
      })
    );
    manifest.set(`rules/${id}`, {
      id, kind: 'rule', path: path.relative(root, dir),
      sha256: 'stale-hash-so-this-counts-as-modified',
      server_updated_at: '2020-01-01T00:00:00Z',
    });
  }
  manifest.save(root);
  return { base, root };
}

function fakeClient() {
  const calls = { get: [], patch: [] };
  return {
    calls,
    async get(p) {
      calls.get.push(p);
      const id = p.split('/').pop();
      return { data: { id, attributes: { updated_at: '2020-01-01T00:00:00Z', name: 'Server' } } };
    },
    async patch(p) {
      calls.patch.push(p);
      const id = p.split('/').pop();
      return { data: { id, attributes: { updated_at: '2030-01-01T00:00:00Z' } } };
    },
    async post(p) { return { data: { id: 'NEW', attributes: {} } }; },
    async paged() { return []; },
  };
}

(async () => {
section('1. `only` pushes just the named changes');
{
  const { base, root } = makeMirror(4);
  const manifest = Manifest.load(root);
  const all = push.detectChanges(root, manifest);
  check('four changes detected', all.length === 4, all.length);

  const client = fakeClient();
  const only = new Set([all[0].key, all[2].key]);
  const result = await push.pushProperty(client, PID, path.dirname(root), { only });

  check('applied exactly two', result.applied === 2, result);
  check('PATCHed exactly two', client.calls.patch.length === 2, client.calls.patch);
  const touched = client.calls.patch.map((p) => p.split('/').pop()).sort();
  const wanted = [all[0].resourceId, all[2].resourceId].sort();
  check('PATCHed the selected ones', JSON.stringify(touched) === JSON.stringify(wanted), { touched, wanted });
  fs.rmSync(base, { recursive: true, force: true });
}

section('2. unselected changes stay unpushed — they are still there next time');
{
  const { base, root } = makeMirror(3);
  const all = push.detectChanges(root, Manifest.load(root));
  const only = new Set([all[0].key]);
  await push.pushProperty(fakeClient(), PID, path.dirname(root), { only });

  const after = push.detectChanges(root, Manifest.load(root));
  check('two changes remain', after.length === 2, after.map((c) => c.resourceId));
  check('the pushed one is gone', !after.some((c) => c.key === all[0].key), after.map((c) => c.key));
  fs.rmSync(base, { recursive: true, force: true });
}

section('3. no `only` still pushes everything');
{
  const { base, root } = makeMirror(3);
  const client = fakeClient();
  const result = await push.pushProperty(client, PID, path.dirname(root), {});
  check('all three applied', result.applied === 3, result);
  fs.rmSync(base, { recursive: true, force: true });
}

section('4. an empty `only` pushes nothing at all');
{
  const { base, root } = makeMirror(3);
  const client = fakeClient();
  const result = await push.pushProperty(client, PID, path.dirname(root), { only: new Set() });
  check('nothing applied', result.applied === 0, result);
  check('no PATCH issued', client.calls.patch.length === 0, client.calls.patch);
  fs.rmSync(base, { recursive: true, force: true });
}

section('5. a new component drags in the new rule it belongs to');
{
  // A created component whose parent rule is itself a pending create: pushing
  // the component alone would POST to the placeholder rule id.
  const all = [
    { key: 'rules/newRule1', kind: 'rule', resourceId: 'newRule1', reason: 'created', parentRuleId: null },
    { key: 'comp1', kind: 'rule_component', resourceId: 'newComp1', reason: 'created', parentRuleId: 'newRule1' },
    { key: 'rules/RL9', kind: 'rule', resourceId: 'RL9', reason: 'modified', parentRuleId: null },
  ];
  const { keys, added } = push.withRequiredParents(all, new Set(['comp1']));
  check('parent rule pulled in', keys.has('rules/newRule1'), [...keys]);
  check('reported what it added', added.length === 1 && added[0].key === 'rules/newRule1', added);
  check('unrelated rule left out', !keys.has('rules/RL9'), [...keys]);
}

section('6. closure leaves ordinary selections alone');
{
  const all = [
    { key: 'rules/RL1', kind: 'rule', resourceId: 'RL1', reason: 'modified', parentRuleId: null },
    { key: 'comp1', kind: 'rule_component', resourceId: 'RC1', reason: 'modified', parentRuleId: 'RL1' },
  ];
  // A *modified* component's parent already exists on Reactor — no need to drag it in.
  const { keys, added } = push.withRequiredParents(all, new Set(['comp1']));
  check('nothing added', added.length === 0, added);
  check('selection unchanged', keys.size === 1 && keys.has('comp1'), [...keys]);
}

section('7. selection defaults to everything ticked');
{
  const sel = new ChangeSelection();
  const changes = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  check('all selected up front', sel.filter(changes).length === 3);
  check('no exclusions', sel.hasExclusions === false);
  check('group reads as all-checked', sel.allSelected(['a', 'b', 'c']) === true);
}

section('8. unticking narrows, reticking restores');
{
  const sel = new ChangeSelection();
  const changes = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  sel.setSelected(['b'], false);
  check('b dropped', sel.filter(changes).map((c) => c.key).join(',') === 'a,c');
  check('group no longer all-checked', sel.allSelected(['a', 'b', 'c']) === false);
  sel.setSelected(['b'], true);
  check('b back', sel.filter(changes).length === 3);
}

section('9. a group toggle covers its descendants');
{
  const sel = new ChangeSelection();
  const changes = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  sel.setSelected(['a', 'b'], false);
  check('both dropped', sel.filter(changes).map((c) => c.key).join(',') === 'c');
  check('group unchecked', sel.allSelected(['a', 'b']) === false);
}

section('10. a NEW change arrives ticked, not silently left behind');
{
  const sel = new ChangeSelection();
  sel.setSelected(['a'], false);
  const changes = [{ key: 'a' }, { key: 'b' }, { key: 'brand-new' }];
  check('new key is selected', sel.isSelected('brand-new') === true);
  check('old exclusion still honored', sel.filter(changes).map((c) => c.key).join(',') === 'b,brand-new');
}

section('11. pruning forgets exclusions for changes that no longer exist');
{
  const sel = new ChangeSelection();
  sel.setSelected(['gone'], false);
  check('excluded while it existed', sel.isSelected('gone') === false);
  sel.prune([{ key: 'a' }]);
  check('exclusion dropped after prune', sel.isSelected('gone') === true);
  check('back to clean', sel.hasExclusions === false);
}

section('12. select-all and select-none');
{
  const sel = new ChangeSelection();
  const changes = [{ key: 'a' }, { key: 'b' }];
  sel.selectNone(changes);
  check('nothing selected', sel.filter(changes).length === 0);
  sel.selectAll();
  check('everything selected', sel.filter(changes).length === 2);
}

done();
})();
