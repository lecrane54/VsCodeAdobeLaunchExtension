/** Filesystem layout: slugs, canonical JSON, source split. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const SLUG_RE = /[^A-Za-z0-9._-]+/g;
// Reactor resource ids: two-letter type prefix + 32 hex (e.g. PR8fb5…, EXaf22…).
const PROPERTY_ID_RE = /^PR[0-9a-f]{32}$/;

export function slug(name: string | undefined | null, maxLen = 60): string {
  const s = (name ?? '').trim().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '');
  return (s || 'unnamed').slice(0, maxLen);
}

/**
 * Reject anything that isn't a real Reactor property id. `propertyId` flows
 * straight into filesystem paths (and an `fs.rmSync(recursive)` on fresh pull),
 * so an unvalidated `../…` value could delete or write outside the mirror.
 */
export function validatePropertyId(propertyId: string): string {
  if (!PROPERTY_ID_RE.test(propertyId ?? '')) {
    throw new Error(
      `Invalid property id "${propertyId}": expected "PR" followed by 32 hex characters.`
    );
  }
  return propertyId;
}

/** The on-disk root for a property — the single validated join for its id. */
export function propertyRoot(baseDir: string, propertyId: string): string {
  return path.join(baseDir, validatePropertyId(propertyId));
}

export interface PropertyInfo {
  name?: string;
  platform?: string;
  domains?: string[];
}

/**
 * What the property calls itself, straight from the mirror. Pull already writes
 * `property.json`, so the UI can show "My Property" instead of a 34-character
 * hex id without keeping a second copy of the name in settings.
 */
export function readPropertyInfo(root: string): PropertyInfo {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'property.json'), 'utf-8'));
    const a = parsed?.attributes ?? {};
    return {
      name: typeof a.name === 'string' && a.name ? a.name : undefined,
      platform: typeof a.platform === 'string' ? a.platform : undefined,
      domains: Array.isArray(a.domains)
        ? a.domains.filter((d: unknown): d is string => typeof d === 'string')
        : undefined,
    };
  } catch {
    return {};
  }
}

export function dirname(name: string | undefined | null, resourceId: string): string {
  // Slug the id too so a hostile/garbled id (e.g. with '/' or '..') can't
  // traverse out of the property root; legitimate ids are unchanged.
  return `${slug(name)}__${slug(resourceId)}`;
}

/** Deterministic JSON for hashing / diffing. */
export function canonicalJson(obj: unknown): string {
  return stableStringify(obj, 2) + '\n';
}

export function contentHash(...parts: string[]): string {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p, 'utf8');
  return h.digest('hex');
}

export function kindOf(delegateId: string | undefined | null): string {
  const parts = (delegateId ?? '').split('::');
  return parts.length >= 3 ? parts[1] : '?';
}

/**
 * Which settings key holds the editable JavaScript for a given delegate.
 * - Standard custom-code actions/conditions store JS under `source`
 * - Adobe Web SDK "Update Variable" action stores JS under `customCode`
 * Extend this map as new extension-provided delegates surface.
 */
export function sourceFieldFor(delegateId: string | undefined | null): string {
  if (!delegateId) return 'source';
  if (delegateId === 'adobe-alloy::actions::update-variable') return 'customCode';
  return 'source';
}

export interface SplitSettings {
  /** The extracted JavaScript, or null when the settings carry none. */
  source: string | null;
  /** Which settings key the source came from. */
  sourceField: string | null;
  /** Parsed settings minus the source field; a raw string if it wasn't JSON. */
  settingsWithoutSource: any;
}

export function splitSettings(raw: string | null | undefined, delegateId?: string): SplitSettings {
  if (raw === null || raw === undefined || raw === '') {
    return { source: null, sourceField: null, settingsWithoutSource: null };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { source: null, sourceField: null, settingsWithoutSource: raw };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { source: null, sourceField: null, settingsWithoutSource: obj };
  }
  const dict = obj as Record<string, unknown>;
  // Preferred field determined by delegate; fall back to sniffing.
  const field = sourceFieldFor(delegateId ?? '');
  const val = dict[field];
  if (typeof val === 'string' && val.length > 0) {
    const rest = { ...dict };
    delete rest[field];
    return { source: val, sourceField: field, settingsWithoutSource: rest };
  }
  // Fallback: if delegate didn't route us to a JS field but settings still has a `source`
  // (rare but possible for older data), extract it.
  if (field !== 'source' && typeof dict.source === 'string' && dict.source.length > 0) {
    const rest = { ...dict };
    delete rest.source;
    return { source: dict.source, sourceField: 'source', settingsWithoutSource: rest };
  }
  return { source: null, sourceField: null, settingsWithoutSource: dict };
}

export function mergeSettings(split: SplitSettings): string {
  const obj = split.settingsWithoutSource;
  if (typeof obj === 'string') return obj;
  if (obj === null && split.source === null) return '';
  const merged: Record<string, unknown> = { ...(obj || {}) };
  if (split.source !== null) {
    merged[split.sourceField ?? 'source'] = split.source;
  }
  return JSON.stringify(merged);
}

/** Sort keys so hashes are deterministic across pulls, editor tools, git noise. */
function stableStringify(value: unknown, indent: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
