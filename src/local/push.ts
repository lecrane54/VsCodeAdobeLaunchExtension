/** Push local edits back to Reactor: diff against manifest, PATCH only what changed. */

import * as fs from 'fs';
import * as path from 'path';

import { ReactorClient, ReactorError } from '../reactor/client';
import { canonicalJson, contentHash, dirname, mergeSettings, propertyRoot, sourceFieldFor, SplitSettings } from './layout';
import { Manifest, ResourceEntry } from './manifest';
import { updateBaselineFile } from './baseline';
import type { Progress } from './pull';

export interface Change {
  key: string;
  kind: ResourceEntry['kind'];
  resourceId: string;
  jsonPath: string;
  jsPath: string | null;
  parentRuleId: string | null;
  reason: 'modified' | 'created';
  /** Providing extension id, on a `created` rule_component. */
  extensionId?: string | null;
}

export interface PushResult {
  /** The changes push actually attempted (conflicted ones are excluded when skipped). */
  changes: Change[];
  applied: number;
  failed: number;
  /** Changes held back because Reactor moved on since the last pull. */
  skipped: number;
  conflicts: Conflict[];
  /** True when the user backed out at the conflict prompt — nothing was applied. */
  cancelled: boolean;
}

/** A local change whose server-side resource no longer matches what we pulled. */
export interface Conflict {
  change: Change;
  reason: 'modified-remotely' | 'deleted-remotely';
  /** `updated_at` we recorded at pull/push time. */
  expectedUpdatedAt?: string;
  /** `updated_at` Reactor reports now. */
  serverUpdatedAt?: string;
  serverUpdatedBy?: string;
  name?: string;
}

/** What to do about conflicts, decided by the caller (a modal, in the extension). */
export type ConflictChoice = 'overwrite' | 'skip' | 'cancel';

const ENDPOINT: Record<ResourceEntry['kind'], string> = {
  rule: 'rules',
  rule_component: 'rule_components',
  data_element: 'data_elements',
  extension: 'extensions',
};

export function detectChanges(root: string, manifest: Manifest): Change[] {
  const out: Change[] = [];
  for (const [key, entry] of Object.entries(manifest.data.resources)) {
    const absPath = path.join(root, entry.path);

    // Locally-created resource not yet on Reactor. Its files ARE the change;
    // there's no baseline to hash against. If the files were deleted (the user
    // reverted the add), emit nothing — a later pull rebuilds the manifest.
    if (entry.pending === 'create') {
      if (entry.kind === 'rule') {
        const jsonPath = path.join(absPath, 'rule.json');
        if (!fs.existsSync(jsonPath)) continue;
        out.push({
          key, kind: 'rule', resourceId: entry.id,
          jsonPath, jsPath: null, parentRuleId: null, reason: 'created',
        });
      } else if (entry.kind === 'rule_component') {
        const jsonPath = absPath;
        const jsPath = jsonPath.replace(/\.json$/, '.js');
        if (!fs.existsSync(jsonPath)) continue;
        out.push({
          key, kind: 'rule_component', resourceId: entry.id,
          jsonPath, jsPath: fs.existsSync(jsPath) ? jsPath : null,
          parentRuleId: entry.parent_rule_id ?? null, reason: 'created',
          extensionId: entry.extension_id ?? null,
        });
      }
      continue;
    }

    if (entry.kind === 'rule') {
      const jsonPath = path.join(absPath, 'rule.json');
      if (!fs.existsSync(jsonPath)) continue;
      const json = fs.readFileSync(jsonPath, 'utf-8');
      if (contentHash(json) !== entry.sha256) {
        out.push({
          key, kind: 'rule', resourceId: entry.id,
          jsonPath, jsPath: null, parentRuleId: null, reason: 'modified',
        });
      }
    } else if (entry.kind === 'rule_component') {
      const jsonPath = absPath;
      const jsPath = jsonPath.replace(/\.json$/, '.js');
      if (!fs.existsSync(jsonPath)) continue;
      const json = fs.readFileSync(jsonPath, 'utf-8');
      const src = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf-8') : '';
      if (contentHash(json, src) !== entry.sha256) {
        out.push({
          key, kind: 'rule_component', resourceId: entry.id,
          jsonPath, jsPath: fs.existsSync(jsPath) ? jsPath : null,
          parentRuleId: entry.parent_rule_id ?? null, reason: 'modified',
        });
      }
    } else if (entry.kind === 'data_element') {
      const jsonPath = path.join(absPath, 'data_element.json');
      const jsPath = path.join(absPath, 'settings.js');
      if (!fs.existsSync(jsonPath)) continue;
      const json = fs.readFileSync(jsonPath, 'utf-8');
      const src = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf-8') : '';
      if (contentHash(json, src) !== entry.sha256) {
        out.push({
          key, kind: 'data_element', resourceId: entry.id,
          jsonPath, jsPath: fs.existsSync(jsPath) ? jsPath : null,
          parentRuleId: null, reason: 'modified',
        });
      }
    } else if (entry.kind === 'extension') {
      const jsonPath = path.join(absPath, 'extension.json');
      const jsPath = path.join(absPath, 'settings.js');
      if (!fs.existsSync(jsonPath)) continue;
      const json = fs.readFileSync(jsonPath, 'utf-8');
      const src = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf-8') : '';
      if (contentHash(json, src) !== entry.sha256) {
        out.push({
          key, kind: 'extension', resourceId: entry.id,
          jsonPath, jsPath: fs.existsSync(jsPath) ? jsPath : null,
          parentRuleId: null, reason: 'modified',
        });
      }
    }
  }
  // Apply order matters: a created rule must exist before its created components,
  // which must exist before any modify. Modifies keep their relative order.
  const rank = (c: Change): number =>
    c.reason === 'created' && c.kind === 'rule' ? 0
      : c.reason === 'created' && c.kind === 'rule_component' ? 1
        : 2;
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

function loadLocalAttrs(jsonPath: string, jsPath: string | null): Record<string, any> {
  const body = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const attrs: Record<string, any> = { ...body.attributes };
  const settingsObj = attrs.settings;
  const src = jsPath ? fs.readFileSync(jsPath, 'utf-8') : null;
  const delegateId: string = attrs.delegate_descriptor_id ?? '';
  const split: SplitSettings = {
    source: src,
    sourceField: src !== null ? sourceFieldFor(delegateId) : null,
    settingsWithoutSource:
      settingsObj === undefined ? null : (settingsObj as any),
  };
  if (src !== null || (settingsObj !== undefined && settingsObj !== null)) {
    attrs.settings = mergeSettings(split);
  } else {
    delete attrs.settings;
  }
  return attrs;
}

/** Shared state threaded through a push run, for reconciling created resources. */
export interface ApplyCtx {
  propertyId: string;
  root: string;
  manifest: Manifest;
  /** placeholder rule id → real Reactor id, once a created rule is POSTed. */
  ruleIdMap: Map<string, string>;
  /** The live change list, so a rule rename can repath its child-component changes. */
  changes: Change[];
}

export async function applyChange(
  client: ReactorClient,
  change: Change,
  ctx?: ApplyCtx
): Promise<string | undefined> {
  if (change.reason === 'created') {
    if (!ctx) throw new Error('created change requires push context');
    if (change.kind === 'rule') return applyCreateRule(client, change, ctx);
    if (change.kind === 'rule_component') return applyCreateComponent(client, change, ctx);
    throw new Error(`Launch Tags: creating a ${change.kind} is not supported.`);
  }
  if (change.kind === 'rule') {
    const attrs = loadLocalAttrs(change.jsonPath, null);
    const allowed = pick(attrs, ['name', 'enabled']);
    const resp = await client.patch<any>(`/rules/${change.resourceId}`, {
      data: { type: 'rules', id: change.resourceId, attributes: allowed },
    });
    return updatedAtOf(resp);
  } else if (change.kind === 'rule_component') {
    const attrs = loadLocalAttrs(change.jsonPath, change.jsPath);
    const allowed = pick(attrs, ['name', 'settings', 'order', 'negate', 'rule_order']);
    const resp = await client.patch<any>(`/rule_components/${change.resourceId}`, {
      data: { type: 'rule_components', id: change.resourceId, attributes: allowed },
    });
    return updatedAtOf(resp);
  } else if (change.kind === 'data_element') {
    const attrs = loadLocalAttrs(change.jsonPath, change.jsPath);
    const allowed = pick(attrs, [
      'name', 'settings', 'default_value', 'force_lower_case', 'clean_text', 'storage_duration',
    ]);
    const resp = await client.patch<any>(`/data_elements/${change.resourceId}`, {
      data: { type: 'data_elements', id: change.resourceId, attributes: allowed },
    });
    return updatedAtOf(resp);
  } else if (change.kind === 'extension') {
    const attrs = loadLocalAttrs(change.jsonPath, change.jsPath);
    const allowed = pick(attrs, ['settings']);
    const resp = await client.patch<any>(`/extensions/${change.resourceId}`, {
      data: { type: 'extensions', id: change.resourceId, attributes: allowed },
    });
    return updatedAtOf(resp);
  }
  return undefined;
}

function updatedAtOf(resp: any): string | undefined {
  const value = resp?.data?.attributes?.updated_at;
  return typeof value === 'string' ? value : undefined;
}

/** POST a locally-created rule, then rename its folder to the real id and reconcile. */
async function applyCreateRule(
  client: ReactorClient,
  change: Change,
  ctx: ApplyCtx
): Promise<string | undefined> {
  const attrs = loadLocalAttrs(change.jsonPath, null);
  const body = pick(attrs, ['name', 'enabled']);
  const resp = await client.post<any>(`/properties/${ctx.propertyId}/rules`, {
    data: { type: 'rules', attributes: body },
  });
  const realId = resp?.data?.id;
  if (!realId) throw new Error('Launch Tags: rule create returned no id.');
  const updatedAt = updatedAtOf(resp);
  reconcileCreatedRule(ctx, change, realId, updatedAt);
  return updatedAt;
}

function reconcileCreatedRule(
  ctx: ApplyCtx,
  change: Change,
  realId: string,
  updatedAt?: string
): void {
  const { root, manifest } = ctx;
  const placeholder = change.resourceId;
  const oldFolderAbs = path.dirname(change.jsonPath);
  const parsed = JSON.parse(fs.readFileSync(change.jsonPath, 'utf-8'));
  const name: string = parsed?.attributes?.name ?? realId;

  const newFolderAbs = path.join(root, 'rules', dirname(name, realId));
  if (newFolderAbs !== oldFolderAbs) fs.renameSync(oldFolderAbs, newFolderAbs);
  const newRuleJson = path.join(newFolderAbs, 'rule.json');
  parsed.id = realId;
  fs.writeFileSync(newRuleJson, canonicalJson(parsed), 'utf-8');

  const oldFolderName = path.basename(oldFolderAbs);
  const newFolderName = path.basename(newFolderAbs);

  for (const entry of Object.values(manifest.data.resources)) {
    if (entry.id === placeholder && entry.kind === 'rule') {
      entry.id = realId;
      entry.path = path.relative(root, newFolderAbs);
      entry.sha256 = contentHash(fs.readFileSync(newRuleJson, 'utf-8'));
      entry.server_updated_at = updatedAt;
      delete entry.pending;
    } else if (entry.parent_rule_id === placeholder) {
      entry.parent_rule_id = realId;
      const rel = path.relative(path.join('rules', oldFolderName), entry.path);
      entry.path = path.join('rules', newFolderName, rel);
    }
  }

  // The folder moved: repath any not-yet-applied child-component changes.
  for (const c of ctx.changes) {
    if (c === change) continue;
    if (c.jsonPath.startsWith(oldFolderAbs + path.sep)) {
      c.jsonPath = path.join(newFolderAbs, path.relative(oldFolderAbs, c.jsonPath));
      if (c.jsPath) c.jsPath = path.join(newFolderAbs, path.relative(oldFolderAbs, c.jsPath));
    }
    if (c.parentRuleId === placeholder) c.parentRuleId = realId;
  }

  ctx.ruleIdMap.set(placeholder, realId);
  change.resourceId = realId;
  change.jsonPath = newRuleJson;
  updateBaselineFile(root, newRuleJson);
}

/** POST a locally-created rule component, then reconcile its id/manifest/baseline. */
async function applyCreateComponent(
  client: ReactorClient,
  change: Change,
  ctx: ApplyCtx
): Promise<string | undefined> {
  const parent = change.parentRuleId;
  if (!parent) throw new Error('Launch Tags: new component has no parent rule.');
  const realRuleId = ctx.ruleIdMap.get(parent) ?? parent;
  const extId = change.extensionId;
  if (!extId) throw new Error('Launch Tags: new component has no providing extension id.');

  const attrs = loadLocalAttrs(change.jsonPath, change.jsPath);
  const body = pick(attrs, ['name', 'settings', 'order', 'negate', 'delegate_descriptor_id']);
  const resp = await client.post<any>(`/rules/${realRuleId}/rule_components`, {
    data: {
      type: 'rule_components',
      attributes: body,
      relationships: { extension: { data: { type: 'extensions', id: extId } } },
    },
  });
  const realId = resp?.data?.id;
  if (!realId) throw new Error('Launch Tags: rule component create returned no id.');
  const updatedAt = updatedAtOf(resp);

  const parsed = JSON.parse(fs.readFileSync(change.jsonPath, 'utf-8'));
  parsed.id = realId;
  fs.writeFileSync(change.jsonPath, canonicalJson(parsed), 'utf-8');

  const src = change.jsPath && fs.existsSync(change.jsPath)
    ? fs.readFileSync(change.jsPath, 'utf-8')
    : '';
  const placeholder = change.resourceId;
  for (const entry of Object.values(ctx.manifest.data.resources)) {
    if (entry.id === placeholder && entry.kind === 'rule_component') {
      entry.id = realId;
      entry.parent_rule_id = realRuleId;
      entry.path = path.relative(ctx.root, change.jsonPath);
      entry.sha256 = contentHash(fs.readFileSync(change.jsonPath, 'utf-8'), src);
      entry.server_updated_at = updatedAt;
      delete entry.pending;
      delete entry.extension_id;
      break;
    }
  }

  change.resourceId = realId;
  change.parentRuleId = realRuleId;
  updateBaselineFile(ctx.root, change.jsonPath);
  if (change.jsPath) updateBaselineFile(ctx.root, change.jsPath);
  return updatedAt;
}

function refreshHash(manifest: Manifest, change: Change, updatedAt?: string): void {
  const json = fs.readFileSync(change.jsonPath, 'utf-8');
  const src = change.jsPath && fs.existsSync(change.jsPath)
    ? fs.readFileSync(change.jsPath, 'utf-8')
    : '';
  const entry = manifest.get(change.key);
  if (!entry) return;
  entry.sha256 = change.jsPath ? contentHash(json, src) : contentHash(json);
  // Our own PATCH just moved `updated_at`; record it so the next push doesn't
  // read its own write as somebody else's edit.
  if (updatedAt) entry.server_updated_at = updatedAt;
}

/**
 * Compare each locally-modified resource against its live Reactor state.
 *
 * We PATCH whole attribute sets, so pushing over a resource somebody edited in
 * the Launch UI would drop their work with no trace. `updated_at` is Reactor's
 * own change stamp: if it moved since our last pull or push, the local edit is
 * built on a stale copy.
 *
 * Only `modified` changes are checkable — a `created` resource has no server
 * counterpart yet. Mirrors pulled before timestamps were recorded fall back to
 * the `updated_at` inside the working JSON, and are skipped if even that is
 * missing rather than blocking the push on unknowable state.
 */
export async function detectConflicts(
  client: ReactorClient,
  manifest: Manifest,
  changes: Change[],
  progress?: Progress
): Promise<Conflict[]> {
  const checkable = changes.filter((c) => c.reason === 'modified');
  if (checkable.length === 0) return [];
  progress?.report(`Checking ${checkable.length} resource(s) against Reactor…`);

  const results = await mapWithLimit(checkable, 8, async (c): Promise<Conflict | undefined> => {
    const expected = manifest.get(c.key)?.server_updated_at ?? localUpdatedAt(c.jsonPath);
    if (!expected) return undefined;

    let data: any;
    try {
      const resp = await client.get<any>(`/${ENDPOINT[c.kind]}/${c.resourceId}`);
      data = resp?.data;
    } catch (err) {
      if (err instanceof ReactorError && err.status === 404) {
        return { change: c, reason: 'deleted-remotely', expectedUpdatedAt: expected };
      }
      // Couldn't verify (auth, outage). Don't block on it — the PATCH that
      // follows will surface the same failure with a real error message.
      progress?.report(`  could not verify ${c.kind} ${c.resourceId}: ${(err as Error).message}`);
      return undefined;
    }

    const serverUpdatedAt: string | undefined = data?.attributes?.updated_at;
    if (!serverUpdatedAt || serverUpdatedAt === expected) return undefined;
    return {
      change: c,
      reason: 'modified-remotely',
      expectedUpdatedAt: expected,
      serverUpdatedAt,
      serverUpdatedBy:
        data?.attributes?.updated_by_email ?? data?.attributes?.updated_by_display_name,
      name: data?.attributes?.name,
    };
  });
  return results.filter((c): c is Conflict => c !== undefined);
}

/** One line describing a conflict, for the modal and the output channel. */
export function formatConflict(c: Conflict): string {
  // Reactor's name when we have it; a deleted resource gives us nothing, so
  // fall back to what the local copy calls itself before resorting to a path.
  const label = c.name ?? localName(c.change.jsonPath) ?? path.basename(c.change.jsonPath);
  if (c.reason === 'deleted-remotely') {
    return `${c.change.kind} · ${label} — deleted in Reactor`;
  }
  const who = c.serverUpdatedBy ? ` by ${c.serverUpdatedBy}` : '';
  const when = c.serverUpdatedAt ? ` ${c.serverUpdatedAt.slice(0, 16).replace('T', ' ')}` : '';
  return `${c.change.kind} · ${label} — changed in Reactor${when}${who}`;
}

/** The resource's own name, read from its working JSON. */
function localName(jsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const value = parsed?.attributes?.name;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `updated_at` as recorded in a working JSON file — the fallback for older mirrors. */
function localUpdatedAt(jsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const value = parsed?.attributes?.updated_at;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function pushProperty(
  client: ReactorClient,
  propertyId: string,
  baseDir: string,
  opts: {
    dryRun?: boolean;
    progress?: Progress;
    /**
     * Asked what to do when local edits collide with newer Reactor state.
     * Omitted means cancel: never overwrite somebody's work unprompted.
     */
    onConflicts?: (conflicts: Conflict[]) => Promise<ConflictChoice>;
    /**
     * Push only these change keys. Omitted means everything detected.
     * The caller is responsible for the closure — see `withRequiredParents`.
     */
    only?: ReadonlySet<string>;
  } = {}
): Promise<PushResult> {
  const { dryRun = false, progress } = opts;
  const root = propertyRoot(baseDir, propertyId);
  const manifest = Manifest.load(root);
  if (manifest.data.property_id && manifest.data.property_id !== propertyId) {
    throw new Error(
      `Manifest is for ${manifest.data.property_id}, not ${propertyId}. Pull first.`
    );
  }
  const detected = detectChanges(root, manifest);
  const changes = opts.only ? detected.filter((c) => opts.only!.has(c.key)) : detected;
  if (opts.only && changes.length !== detected.length) {
    progress?.report(`${detected.length} local change(s) detected, ${changes.length} selected`);
  } else {
    progress?.report(`${changes.length} local change(s) detected`);
  }
  for (const c of changes) progress?.report(`  ${c.kind}  ${c.resourceId}  ${path.basename(c.jsonPath)}`);

  const conflicts = changes.length ? await detectConflicts(client, manifest, changes, progress) : [];
  for (const c of conflicts) progress?.report(`CONFLICT ${formatConflict(c)}`);

  if (dryRun || changes.length === 0) {
    return { changes, applied: 0, failed: 0, skipped: 0, conflicts, cancelled: false };
  }

  let toApply = changes;
  let skipped = 0;
  if (conflicts.length > 0) {
    const choice = opts.onConflicts ? await opts.onConflicts(conflicts) : 'cancel';
    if (choice === 'cancel') {
      progress?.report('Push cancelled — resolve the conflicts and try again.');
      return {
        changes: [], applied: 0, failed: 0, skipped: conflicts.length, conflicts, cancelled: true,
      };
    }
    if (choice === 'skip') {
      const blocked = new Set(conflicts.map((c) => c.change.key));
      toApply = changes.filter((c) => !blocked.has(c.key));
      skipped = changes.length - toApply.length;
      progress?.report(`Skipping ${skipped} conflicted change(s)`);
      if (toApply.length === 0) {
        return { changes: [], applied: 0, failed: 0, skipped, conflicts, cancelled: false };
      }
    } else {
      progress?.report(`Overwriting ${conflicts.length} conflicted resource(s) as requested`);
    }
  }

  let applied = 0, failed = 0;
  const ctx: ApplyCtx = { propertyId, root, manifest, ruleIdMap: new Map(), changes: toApply };
  try {
    for (const c of toApply) {
      try {
        const updatedAt = await applyChange(client, c, ctx);
        if (c.reason === 'created') {
          // applyChange reconciled the id, manifest, and baseline in place;
          // c.resourceId now holds the real Reactor id.
          progress?.report(`created ${c.kind} ${c.resourceId}`);
        } else {
          refreshHash(manifest, c, updatedAt);
          // The pushed content is now the server state → refresh its diff baseline.
          updateBaselineFile(root, c.jsonPath);
          if (c.jsPath) updateBaselineFile(root, c.jsPath);
          progress?.report(`pushed ${c.kind} ${c.resourceId}`);
        }
        applied++;
      } catch (err) {
        progress?.report(`FAILED ${c.kind} ${c.resourceId}: ${(err as Error).message}`);
        failed++;
        if (err instanceof ReactorError) throw err;
      }
    }
  } finally {
    // Must persist even when a ReactorError aborts the run: earlier creates have
    // already POSTed and had their folders renamed to real ids. Losing those
    // manifest entries would make the next push re-create them as duplicates.
    manifest.save(root);
  }
  return { changes: toApply, applied, failed, skipped, conflicts, cancelled: false };
}

function pick<T extends Record<string, any>>(obj: T, keys: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) (out as any)[k] = obj[k];
  return out;
}

/**
 * Expand a selection so it can actually apply.
 *
 * A locally-created rule component POSTs to `/rules/<parent>/rule_components`,
 * and that parent only has a real Reactor id once its own create has been
 * pushed. Ticking the component but not the rule would POST to the placeholder
 * id and 404. Rather than fail, pull the parent in and tell the user.
 */
export function withRequiredParents(
  all: Change[],
  selectedKeys: ReadonlySet<string>
): { keys: Set<string>; added: Change[] } {
  const keys = new Set(selectedKeys);
  const createdRules = new Map<string, Change>();
  for (const c of all) {
    if (c.kind === 'rule' && c.reason === 'created') createdRules.set(c.resourceId, c);
  }
  const added: Change[] = [];
  for (const c of all) {
    if (!keys.has(c.key)) continue;
    if (c.kind !== 'rule_component' || c.reason !== 'created' || !c.parentRuleId) continue;
    const parent = createdRules.get(c.parentRuleId);
    if (parent && !keys.has(parent.key)) {
      keys.add(parent.key);
      added.push(parent);
    }
  }
  return { keys, added };
}
