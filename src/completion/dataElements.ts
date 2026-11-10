/** Shared, mtime-cached inventory of the active property's data elements. */

import * as fs from 'fs';
import * as path from 'path';

import { Config } from '../config';
import { Manifest } from '../local/manifest';

export interface DataElementInfo {
  name: string;
  id: string;
  kind: string;
  storageDuration?: string;
  defaultValue?: string;
}

let cache: { path: string; mtime: number; items: DataElementInfo[] } | undefined;

/**
 * Data elements in the active property's local mirror.
 * Returns `undefined` when there is no active property or no pulled mirror —
 * callers should treat that as "can't tell", not "none exist" (e.g. diagnostics
 * must not flag references when there's nothing to validate against).
 */
export function loadDataElements(config: Config): DataElementInfo[] | undefined {
  const pid = config.activePropertyId();
  if (!pid) return undefined;
  let mirror: string;
  try {
    mirror = path.join(config.mirrorRoot(), pid);
  } catch {
    return undefined;
  }
  const manifestPath = path.join(mirror, '.launch-manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  const mtime = fs.statSync(manifestPath).mtimeMs;
  if (cache && cache.path === manifestPath && cache.mtime === mtime) {
    return cache.items;
  }
  const items = build(mirror);
  cache = { path: manifestPath, mtime, items };
  return items;
}

function build(mirror: string): DataElementInfo[] {
  const manifest = Manifest.load(mirror);
  const out: DataElementInfo[] = [];
  for (const entry of Object.values(manifest.data.resources)) {
    if (entry.kind !== 'data_element') continue;
    const jsonPath = path.join(mirror, entry.path, 'data_element.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const a = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).attributes;
      const name = a.name;
      if (!name) continue;
      out.push({
        name,
        id: entry.id,
        kind: String(a.delegate_descriptor_id ?? '').split('::').pop() ?? 'unknown',
        storageDuration: a.storage_duration || undefined,
        defaultValue: a.default_value || undefined,
      });
    } catch {
      // Ignore parse errors on individual files; serve what we can.
    }
  }
  return out;
}
