/** Pull a Launch property to a local directory tree. */

import * as fs from 'fs';
import * as path from 'path';

import { ReactorClient } from '../reactor/client';
import {
  SplitSettings,
  canonicalJson,
  contentHash,
  dirname,
  kindOf,
  propertyRoot,
  slug,
  splitSettings,
} from './layout';
import { Manifest } from './manifest';
import { writeBaselineSnapshot } from './baseline';

export interface Progress {
  report(message: string): void;
}

type Resource = { id: string; type: string; attributes: any };

export async function pullProperty(
  client: ReactorClient,
  propertyId: string,
  baseDir: string,
  opts: { concurrency?: number; fresh?: boolean; progress?: Progress } = {}
): Promise<Manifest> {
  const { concurrency = 8, fresh = false, progress } = opts;
  const root = propertyRoot(baseDir, propertyId);
  if (fresh && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });

  const report = (msg: string) => progress?.report(msg);

  // Property attributes
  report('Fetching property attributes');
  const propResp = (await client.get<{ data: Resource }>(`/properties/${propertyId}`))!;
  fs.writeFileSync(path.join(root, 'property.json'), canonicalJson(propResp.data), 'utf-8');

  const manifest = Manifest.load(root);
  manifest.data.property_id = propertyId;
  manifest.data.pulled_at = new Date().toISOString();
  manifest.data.resources = {};

  // Rules + components
  report('Listing rules');
  const rules = await client.paged<Resource>(`/properties/${propertyId}/rules`);
  report(`Found ${rules.length} rules; fetching components…`);
  const compsByRule = await gatherWithLimit(rules, concurrency, async (r) => {
    const resp = (await client.get<{ data: Resource[] }>(`/rules/${r.id}/rule_components`))!;
    return [r.id, resp.data ?? []] as [string, Resource[]];
  });

  const rulesDir = path.join(root, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  let i = 0;
  for (const rule of rules) {
    i++;
    const rname = rule.attributes.name || rule.id;
    const rdir = path.join(rulesDir, dirname(rname, rule.id));
    fs.mkdirSync(rdir, { recursive: true });
    const rjson = canonicalJson({
      id: rule.id,
      type: 'rules',
      attributes: rule.attributes,
    });
    fs.writeFileSync(path.join(rdir, 'rule.json'), rjson, 'utf-8');
    manifest.set(`rules/${rule.id}`, {
      id: rule.id,
      kind: 'rule',
      path: path.relative(root, rdir),
      sha256: contentHash(rjson),
      server_updated_at: rule.attributes.updated_at,
    });

    const cdir = path.join(rdir, 'components');
    fs.mkdirSync(cdir, { recursive: true });
    for (const comp of compsByRule.get(rule.id) ?? []) {
      const stem = componentStem(comp);
      const split = splitSettings(
        comp.attributes.settings ?? null,
        comp.attributes.delegate_descriptor_id
      );
      const attrs = { ...comp.attributes };
      attrs.settings = split.settingsWithoutSource;
      const cjson = canonicalJson({ id: comp.id, type: 'rule_components', attributes: attrs });
      const jsonPath = path.join(cdir, `${stem}.json`);
      fs.writeFileSync(jsonPath, cjson, 'utf-8');
      let src = '';
      if (split.source !== null) {
        const jsPath = path.join(cdir, `${stem}.js`);
        fs.writeFileSync(jsPath, split.source, 'utf-8');
        src = split.source;
      }
      manifest.set(`rules/${rule.id}/components/${comp.id}`, {
        id: comp.id,
        kind: 'rule_component',
        parent_rule_id: rule.id,
        path: path.relative(root, jsonPath),
        sha256: contentHash(cjson, src),
        server_updated_at: comp.attributes.updated_at,
      });
    }
    if (i % 25 === 0 || i === rules.length) report(`Rules: ${i}/${rules.length}`);
  }

  // Data elements
  report('Listing data elements');
  const des = await client.paged<Resource>(`/properties/${propertyId}/data_elements`);
  report(`Found ${des.length} data elements`);
  const deDir = path.join(root, 'data_elements');
  fs.mkdirSync(deDir, { recursive: true });
  i = 0;
  for (const de of des) {
    i++;
    const dname = de.attributes.name || de.id;
    const ddir = path.join(deDir, dirname(dname, de.id));
    fs.mkdirSync(ddir, { recursive: true });
    const split = splitSettings(de.attributes.settings ?? null);
    const attrs = { ...de.attributes };
    attrs.settings = split.settingsWithoutSource;
    const djson = canonicalJson({ id: de.id, type: 'data_elements', attributes: attrs });
    fs.writeFileSync(path.join(ddir, 'data_element.json'), djson, 'utf-8');
    let src = '';
    if (split.source !== null) {
      fs.writeFileSync(path.join(ddir, 'settings.js'), split.source, 'utf-8');
      src = split.source;
    }
    manifest.set(`data_elements/${de.id}`, {
      id: de.id,
      kind: 'data_element',
      path: path.relative(root, ddir),
      sha256: contentHash(djson, src),
      server_updated_at: de.attributes.updated_at,
    });
    if (i % 50 === 0 || i === des.length) report(`Data elements: ${i}/${des.length}`);
  }

  // Extensions
  report('Listing extensions');
  const exts = await client.paged<Resource>(`/properties/${propertyId}/extensions`);
  report(`Found ${exts.length} extensions`);
  const extDir = path.join(root, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  for (const ext of exts) {
    const ename = ext.attributes.name || ext.id;
    const edir = path.join(extDir, dirname(ename, ext.id));
    fs.mkdirSync(edir, { recursive: true });
    const split = splitSettings(ext.attributes.settings ?? null);
    const attrs = { ...ext.attributes };
    attrs.settings = split.settingsWithoutSource;
    const ejson = canonicalJson({ id: ext.id, type: 'extensions', attributes: attrs });
    fs.writeFileSync(path.join(edir, 'extension.json'), ejson, 'utf-8');
    let esrc = '';
    if (split.source !== null) {
      fs.writeFileSync(path.join(edir, 'settings.js'), split.source, 'utf-8');
      esrc = split.source;
    }
    manifest.set(`extensions/${ext.id}`, {
      id: ext.id,
      kind: 'extension',
      path: path.relative(root, edir),
      sha256: contentHash(ejson, esrc),
      server_updated_at: ext.attributes.updated_at,
    });
  }

  manifest.save(root);
  // Snapshot the freshly-pulled state as the local diff baseline.
  //
  // Every resource and the manifest are already on disk by this point, so the
  // pull has succeeded whatever happens here. A snapshot that can't be written
  // costs "show what changed" and "revert" — reporting that as `pull failed`
  // sends people back to re-run a pull that already worked.
  try {
    writeBaselineSnapshot(root);
  } catch (err) {
    report(`Warning: could not write the diff baseline — ${(err as Error).message}`);
    report('  The pull itself completed; "show what changed" may be limited until the next one.');
  }
  const total = Object.keys(manifest.data.resources).length;
  report(`Manifest written: ${total} resources tracked`);
  return manifest;
}

function componentStem(comp: Resource): string {
  const order = Number(comp.attributes.order ?? 0);
  const kind = kindOf(comp.attributes.delegate_descriptor_id ?? '');
  const name = comp.attributes.name || comp.id;
  const stem = `${String(order).padStart(3, '0')}-${kind}-${name}`.replace(/\//g, '-');
  return slug(stem, 80);
}

async function gatherWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<[string, R]>
): Promise<Map<string, R>> {
  const out = new Map<string, R>();
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      const [k, v] = await fn(items[i]);
      out.set(k, v);
    }
  });
  await Promise.all(workers);
  return out;
}
