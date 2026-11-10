/**
 * A locked `.baseline/` must not fail the snapshot — or the pull.
 *
 * On Windows the recursive delete of the previous snapshot fails with EPERM
 * whenever something still holds a child: OneDrive syncing the tree the pull
 * just wrote, or an on-access virus scanner. That is unreproducible on this
 * machine, so the lock is simulated by making `fs.rmSync` throw.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { writeBaselineSnapshot, baselineRoot, baselinePathFor } = require(path.join(OUT, 'local/baseline.js'));

const { check, section, done } = require('./harness');

/** A mirror with one rule, one component, and a previous snapshot to clear. */
function makeMirror() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-baseline-'));
  const ruleDir = path.join(root, 'rules', 'My-Rule__RL1');
  fs.mkdirSync(path.join(ruleDir, 'components'), { recursive: true });
  fs.writeFileSync(path.join(ruleDir, 'rule.json'), '{"id":"RL1"}', 'utf-8');
  fs.writeFileSync(path.join(ruleDir, 'components', '000-actions-Code.json'), '{"id":"RC1"}', 'utf-8');
  fs.writeFileSync(path.join(root, 'property.json'), '{"id":"PR1"}', 'utf-8');
  // A previous snapshot, including a resource since deleted from the property.
  fs.mkdirSync(path.join(baselineRoot(root), 'rules', 'Gone__RL9'), { recursive: true });
  fs.writeFileSync(path.join(baselineRoot(root), 'rules', 'Gone__RL9', 'rule.json'), '{"id":"RL9"}', 'utf-8');
  return root;
}

const EPERM = Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });

section('1. the previous snapshot is cleared when nothing holds it');
{
  const root = makeMirror();
  writeBaselineSnapshot(root);
  check(
    'the stale resource is gone from the baseline',
    !fs.existsSync(path.join(baselineRoot(root), 'rules', 'Gone__RL9')),
    fs.readdirSync(path.join(baselineRoot(root), 'rules'))
  );
  check(
    'the current rule was snapshotted',
    fs.existsSync(baselinePathFor(root, path.join(root, 'rules', 'My-Rule__RL1', 'rule.json')))
  );
  fs.rmSync(root, { recursive: true, force: true });
}

section('2. a locked baseline does not throw, and still snapshots');
{
  const root = makeMirror();
  const realRm = fs.rmSync;
  let attempted = false;
  fs.rmSync = (target, opts) => {
    if (String(target).endsWith('.baseline')) {
      attempted = true;
      // Node retries EPERM internally; this stands for the case that outlasts it.
      throw EPERM;
    }
    return realRm(target, opts);
  };

  let threw;
  try {
    writeBaselineSnapshot(root);
  } catch (err) {
    threw = err;
  } finally {
    fs.rmSync = realRm;
  }

  check('the delete was attempted', attempted);
  check('writeBaselineSnapshot did not throw', threw === undefined, threw && threw.message);
  check(
    'the current rule was still snapshotted',
    fs.existsSync(baselinePathFor(root, path.join(root, 'rules', 'My-Rule__RL1', 'rule.json')))
  );
  check(
    'its component was still snapshotted',
    fs.existsSync(
      baselinePathFor(root, path.join(root, 'rules', 'My-Rule__RL1', 'components', '000-actions-Code.json'))
    )
  );
  check(
    'property.json was still snapshotted',
    fs.existsSync(baselinePathFor(root, path.join(root, 'property.json')))
  );
  // The documented cost of not clearing: the since-deleted resource lingers.
  check(
    'the stale entry is the only thing lost to the lock',
    fs.existsSync(path.join(baselineRoot(root), 'rules', 'Gone__RL9', 'rule.json'))
  );
  realRm(root, { recursive: true, force: true });
}

section('3. the retry options Windows needs are actually passed');
{
  const root = makeMirror();
  const realRm = fs.rmSync;
  let opts;
  fs.rmSync = (target, o) => {
    if (String(target).endsWith('.baseline')) opts = o;
    return realRm(target, o);
  };
  try {
    writeBaselineSnapshot(root);
  } finally {
    fs.rmSync = realRm;
  }
  check('maxRetries is set', (opts || {}).maxRetries > 0, opts);
  check('retryDelay is set', (opts || {}).retryDelay > 0, opts);
  check('force is still set', (opts || {}).force === true, opts);
  realRm(root, { recursive: true, force: true });
}

done();
