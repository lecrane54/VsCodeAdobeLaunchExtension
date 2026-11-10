/** Push conflict detection and partial-push recovery. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const OUT = path.join(__dirname, '..', 'out');
const push = require(path.join(OUT, 'local/push.js'));
const { Manifest } = require(path.join(OUT, 'local/manifest.js'));
const { ReactorError } = require(path.join(OUT, 'reactor/client.js'));
const { canonicalJson } = require(path.join(OUT, 'local/layout.js'));

const { check, section, done } = require('./harness');

const PID = 'PR' + 'a'.repeat(32);

/** Build a mirror with N modified rules, each with a recorded server timestamp. */
function makeMirror(n, serverUpdatedAt) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-verify-'));
  const root = path.join(base, PID);
  const manifest = new Manifest({ property_id: PID, resources: {} });
  for (let i = 0; i < n; i++) {
    const id = 'RL' + String(i).repeat(32).slice(0, 32);
    const dir = path.join(root, 'rules', `rule-${i}__${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const json = canonicalJson({
      id, type: 'rules',
      attributes: { name: `Rule ${i}`, enabled: true, updated_at: '2020-01-01T00:00:00Z' },
    });
    fs.writeFileSync(path.join(dir, 'rule.json'), json);
    manifest.set(`rules/${id}`, {
      id, kind: 'rule', path: path.relative(root, dir),
      sha256: 'stale-hash-so-this-counts-as-modified',
      ...(serverUpdatedAt === undefined ? {} : { server_updated_at: serverUpdatedAt }),
    });
  }
  manifest.save(root);
  return { base, root, ids: Object.values(manifest.data.resources).map((e) => e.id) };
}

/** Fake Reactor. `serverTimes` maps resource id → updated_at (null = 404). */
function fakeClient(serverTimes, failPatchFor) {
  const calls = { get: [], patch: [] };
  return {
    calls,
    async get(p) {
      calls.get.push(p);
      const id = p.split('/').pop();
      const t = serverTimes[id];
      if (t === null) throw new ReactorError(404, { errors: [{ detail: 'not found' }] });
      return { data: { id, attributes: { updated_at: t, name: 'Server Name', updated_by_email: 'someone@example.com' } } };
    },
    async patch(p, body) {
      calls.patch.push(p);
      const id = p.split('/').pop();
      if (failPatchFor && failPatchFor.has(id)) throw new ReactorError(422, { errors: [{ detail: 'nope' }] });
      return { data: { id, attributes: { updated_at: '2026-06-06T06:06:06Z' } } };
    },
    async post() { throw new Error('unexpected post'); },
  };
}

(async () => {
section('1. clean push (server matches recorded timestamp)');
{
  const { base, root, ids } = makeMirror(2, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: '2020-01-01T00:00:00Z', [ids[1]]: '2020-01-01T00:00:00Z' });
  const r = await push.pushProperty(c, PID, base, {});
  check('no conflicts', r.conflicts.length === 0, r.conflicts.map(push.formatConflict));
  check('both applied', r.applied === 2, r);
  const m = Manifest.load(root);
  check('manifest records new server_updated_at',
    m.get(`rules/${ids[0]}`).server_updated_at === '2026-06-06T06:06:06Z',
    m.get(`rules/${ids[0]}`));
  check('re-push sees no changes', push.detectChanges(root, m).length === 0);
}

section('2. conflict: resource changed in Reactor');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: '2026-05-05T05:05:05Z' });
  const r = await push.pushProperty(c, PID, base, { onConflicts: async () => 'cancel' });
  check('conflict detected', r.conflicts.length === 1, r.conflicts);
  check('reason is modified-remotely', r.conflicts[0]?.reason === 'modified-remotely');
  check('cancelled', r.cancelled === true && r.applied === 0);
  check('no PATCH was sent', c.calls.patch.length === 0, c.calls.patch);
  console.log('       message: ' + push.formatConflict(r.conflicts[0]));
}

section('3. default (no prompt handler) refuses to overwrite');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: '2026-05-05T05:05:05Z' });
  const r = await push.pushProperty(c, PID, base, {});
  check('cancelled by default', r.cancelled === true && c.calls.patch.length === 0);
}

section('4. skip conflicted, push the rest');
{
  const { base, ids } = makeMirror(3, '2020-01-01T00:00:00Z');
  const c = fakeClient({
    [ids[0]]: '2026-05-05T05:05:05Z', [ids[1]]: '2020-01-01T00:00:00Z', [ids[2]]: '2020-01-01T00:00:00Z',
  });
  const r = await push.pushProperty(c, PID, base, { onConflicts: async () => 'skip' });
  check('1 skipped, 2 applied', r.skipped === 1 && r.applied === 2, r);
  check('conflicted resource never PATCHed', !c.calls.patch.some((p) => p.endsWith(ids[0])), c.calls.patch);
}

section('5. explicit overwrite');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: '2026-05-05T05:05:05Z' });
  const r = await push.pushProperty(c, PID, base, { onConflicts: async () => 'overwrite' });
  check('applied', r.applied === 1 && c.calls.patch.length === 1, r);
}

section('6. deleted in Reactor → conflict, not a blind PATCH');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: null });
  const r = await push.pushProperty(c, PID, base, { onConflicts: async () => 'skip' });
  check('deleted-remotely', r.conflicts[0]?.reason === 'deleted-remotely', r.conflicts);
  check('nothing pushed', c.calls.patch.length === 0);
  console.log('       message: ' + push.formatConflict(r.conflicts[0]));
}

section('7. old mirror with no recorded timestamp falls back to the working JSON');
{
  const { base, ids } = makeMirror(1, undefined); // no server_updated_at in manifest
  const c = fakeClient({ [ids[0]]: '2026-05-05T05:05:05Z' }); // file says 2020-01-01
  const r = await push.pushProperty(c, PID, base, { onConflicts: async () => 'cancel' });
  check('still catches the drift', r.conflicts.length === 1, r.conflicts);
}

section('8. dry run reports conflicts and touches nothing');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({ [ids[0]]: '2026-05-05T05:05:05Z' });
  const r = await push.pushProperty(c, PID, base, { dryRun: true });
  check('conflict reported', r.conflicts.length === 1 && r.applied === 0);
  check('no PATCH', c.calls.patch.length === 0);
}

section('9. THE PARTIAL-PUSH FIX: ReactorError mid-run still saves the manifest');
{
  const { base, root, ids } = makeMirror(3, '2020-01-01T00:00:00Z');
  const times = {}; ids.forEach((id) => (times[id] = '2020-01-01T00:00:00Z'));
  const c = fakeClient(times, new Set([ids[1]]));  // second PATCH blows up
  let threw = false;
  try { await push.pushProperty(c, PID, base, {}); } catch (e) { threw = e instanceof ReactorError; }
  check('error propagates to the user', threw);
  const m = Manifest.load(root);
  const first = m.get(`rules/${ids[0]}`);
  check('successful resource persisted to disk', first.server_updated_at === '2026-06-06T06:06:06Z', first);
  const remaining = push.detectChanges(root, m);
  check('only the un-pushed resources are still pending', remaining.length === 2, remaining.map((x) => x.resourceId));
}

section('10. verification failure (500) does not block the push');
{
  const { base, ids } = makeMirror(1, '2020-01-01T00:00:00Z');
  const c = fakeClient({});
  c.get = async () => { throw new ReactorError(500, 'boom'); };
  const r = await push.pushProperty(c, PID, base, {});
  check('pushed anyway, PATCH surfaces real errors', r.applied === 1 && r.conflicts.length === 0, r);
}

done();
})();
