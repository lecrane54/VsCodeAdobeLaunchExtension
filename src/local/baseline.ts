/**
 * Local baseline snapshot: a `.baseline/` shadow tree under the property mirror
 * holding the last pulled/pushed content of every resource. It's the "before"
 * side of the "show what changed" diff — fully local, no Reactor round-trip.
 *
 * Maintained precisely by pull (full snapshot) and push (per-resource update),
 * so a snapshot always reflects the server state at that moment; diffing a
 * working file against it shows exactly the unpushed edits with no metadata
 * noise. For mirrors that predate baseline tracking, `ensureBaseline` seeds a
 * snapshot from the current working files — skipping already-changed resources
 * so their pre-edit state isn't lost to a same-as-working baseline.
 */

import * as fs from 'fs';
import * as path from 'path';

const RESOURCE_DIRS = ['rules', 'data_elements', 'extensions'];
const LOOSE_FILES = ['property.json', '.launch-manifest.json'];

export function baselineRoot(root: string): string {
  return path.join(root, '.baseline');
}

/** The baseline copy location for a working file under the mirror root. */
export function baselinePathFor(root: string, workingAbs: string): string {
  return path.join(baselineRoot(root), path.relative(root, workingAbs));
}

/** Copy a working file into the baseline tree (used by push after a resource syncs). */
export function updateBaselineFile(root: string, workingAbs: string): void {
  if (!fs.existsSync(workingAbs)) return;
  const dst = baselinePathFor(root, workingAbs);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(workingAbs, dst);
}

/**
 * Restore a resource's working file(s) from the baseline snapshot, discarding
 * local edits. Returns false when there is no baseline to revert to (a mirror
 * that predates baseline tracking) — the caller should surface that.
 *
 * The `.json` must have a baseline. For the optional `.js`: restore it if the
 * baseline has one, otherwise remove the working file (the resource had no
 * custom code at baseline, so the code was added locally and is being undone).
 */
export function revertToBaseline(root: string, jsonPath: string, jsPath?: string | null): boolean {
  const jsonBase = baselinePathFor(root, jsonPath);
  if (!fs.existsSync(jsonBase)) return false;
  fs.copyFileSync(jsonBase, jsonPath);
  if (jsPath) {
    const jsBase = baselinePathFor(root, jsPath);
    if (fs.existsSync(jsBase)) fs.copyFileSync(jsBase, jsPath);
    else if (fs.existsSync(jsPath)) fs.rmSync(jsPath);
  }
  return true;
}

/**
 * Write a full snapshot of the resource trees into `.baseline/`. Call after a
 * pull, when working == server. With a non-empty `skip` set (absolute working
 * paths), those files are left out — used when seeding a mirror that already
 * has local edits so a changed file gets no (misleading) baseline.
 */
export function writeBaselineSnapshot(root: string, skip: Set<string> = new Set()): void {
  const base = baselineRoot(root);
  if (skip.size === 0) removeTree(base);
  fs.mkdirSync(base, { recursive: true });
  for (const name of RESOURCE_DIRS) {
    copyTree(path.join(root, name), path.join(base, name), skip);
  }
  for (const f of LOOSE_FILES) {
    const src = path.join(root, f);
    if (fs.existsSync(src) && !skip.has(src)) fs.copyFileSync(src, path.join(base, f));
  }
  writeGitignore(root);
}

/** Seed a baseline for a mirror that has none yet (predates this feature). */
export function ensureBaseline(root: string): void {
  if (fs.existsSync(baselineRoot(root))) return;
  const skip = new Set<string>();
  try {
    // Dynamic require avoids a static import cycle (push → baseline).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Manifest } = require('./manifest');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { detectChanges } = require('./push');
    for (const c of detectChanges(root, Manifest.load(root))) {
      skip.add(c.jsonPath);
      if (c.jsPath) skip.add(c.jsPath);
    }
  } catch {
    /* no manifest / detect failure → seed everything from working */
  }
  writeBaselineSnapshot(root, skip);
}

/**
 * Clear the previous snapshot, tolerating a lock.
 *
 * A recursive delete fails with EPERM the moment anything else holds a child,
 * and on Windows something usually does: OneDrive's sync engine is still
 * uploading the tree the pull just wrote, and on-access virus scanners hold
 * handles of their own. A mirror under a synced Desktop hits this on every
 * re-pull. Node's own retry loop covers the transient case; when the tree still
 * won't go, the copy that follows overwrites every file that currently exists,
 * so the cost is a stale entry for a resource deleted since the last pull —
 * not a failed snapshot, and certainly not a failed pull.
 */
function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* still locked — the snapshot below refreshes what it can reach */
  }
}

function copyTree(srcDir: string, dstDir: string, skip: Set<string>): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, skip);
    else if (!skip.has(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

/** Keep `.baseline/` out of the user's own git mirror (README suggests git init). */
function writeGitignore(root: string): void {
  const file = path.join(root, '.gitignore');
  const line = '.baseline/';
  try {
    let body = '';
    if (fs.existsSync(file)) {
      body = fs.readFileSync(file, 'utf-8');
      if (body.split(/\r?\n/).some((l) => l.trim() === line)) return;
      if (body.length && !body.endsWith('\n')) body += '\n';
    }
    fs.writeFileSync(file, body + line + '\n', 'utf-8');
  } catch {
    /* best-effort */
  }
}
