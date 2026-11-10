/**
 * What differs between web, mobile, and edge properties.
 *
 * Reactor uses one API for all three, but the authoring model is not the same:
 * - Web rules run in the browser, so conditions and actions here are hand-written
 *   JavaScript against the Core extension, and data elements are read with
 *   `_satellite.getVar()` or `%name%`.
 * - Mobile rules run inside the Adobe Experience Platform Mobile SDK. There is no
 *   Core extension and no custom code: every trigger, condition, and action comes
 *   from an installed mobile extension (Mobile Core, Analytics, Edge, …), and data
 *   elements are referenced as `{%%name%%}` tokens inside settings.
 * - Edge properties hold Edge Network rules; like mobile, nothing runs as custom JS.
 *
 * Pure module: no `vscode` import, so it can be unit-tested directly.
 */

import * as fs from 'fs';
import * as path from 'path';

export type PropertyPlatform = 'web' | 'mobile' | 'edge';

/**
 * Normalize a raw `platform` attribute. A mirror pulled before the property
 * carried a platform (or a missing `property.json`) is treated as web, which is
 * what this extension has always assumed.
 */
export function platformOf(raw: string | undefined | null): PropertyPlatform {
  return raw === 'mobile' || raw === 'edge' ? raw : 'web';
}

/** Web is the only platform whose rules run custom JavaScript from the Core extension. */
export function supportsCoreCustomCode(platform: PropertyPlatform): boolean {
  return platform === 'web';
}

// ---------------------------------------------------------------------------
// Delegates already in use
// ---------------------------------------------------------------------------

export interface DelegateUsage {
  delegateId: string;
  /** How many components in the property use it. */
  count: number;
  /** One component name, to show what it's for. */
  example?: string;
}

/**
 * Every `<ns>::<kind>::<name>` delegate the pulled property already uses for a
 * kind, most-used first. On mobile there is no static catalog worth shipping —
 * which delegates exist depends on which mobile extensions are installed — so
 * the property's own rules are the best menu of what's available.
 */
export function delegatesInUse(root: string, kind: string): DelegateUsage[] {
  const byId = new Map<string, DelegateUsage>();
  const rulesDir = path.join(root, 'rules');
  if (!fs.existsSync(rulesDir)) return [];
  for (const rule of fs.readdirSync(rulesDir)) {
    const compDir = path.join(rulesDir, rule, 'components');
    if (!fs.existsSync(compDir)) continue;
    for (const file of fs.readdirSync(compDir)) {
      if (!file.endsWith('.json')) continue;
      let attrs: { delegate_descriptor_id?: unknown; name?: unknown } | undefined;
      try {
        attrs = JSON.parse(fs.readFileSync(path.join(compDir, file), 'utf-8'))?.attributes;
      } catch {
        continue;
      }
      const id = attrs?.delegate_descriptor_id;
      if (typeof id !== 'string' || id.split('::')[1] !== kind) continue;
      const seen = byId.get(id) ?? { delegateId: id, count: 0 };
      seen.count++;
      if (!seen.example && typeof attrs?.name === 'string' && attrs.name) seen.example = attrs.name;
      byId.set(id, seen);
    }
  }
  return [...byId.values()].sort(
    (a, b) => b.count - a.count || a.delegateId.localeCompare(b.delegateId)
  );
}

/** "com.adobe.module.core::events::lifecycle-launch" → "Lifecycle Launch". */
export function delegateLabel(delegateId: string): string {
  const name = delegateId.split('::').pop() || delegateId;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Environments: mobile App ID / web embed code
// ---------------------------------------------------------------------------

export interface EnvironmentInfo {
  id: string;
  name: string;
  stage?: string;
  /**
   * `<library_path>/<library_name without extension>`, e.g.
   * `3149c49c3910/b1f4cba2b7f4/launch-EN0123abcd-development`. On mobile this is
   * the App ID passed to `MobileCore.configureWith(appId:)`; on web it is the
   * library URL minus `.min.js`. Undefined until the environment has a host.
   */
  fileId?: string;
}

const STAGE_ORDER: Record<string, number> = { development: 0, staging: 1, production: 2 };

export function toEnvironmentInfo(env: { id: string; attributes?: any }): EnvironmentInfo {
  const a = env.attributes ?? {};
  const libPath: unknown = a.library_path;
  const libName: unknown = a.library_name;
  const fileId =
    typeof libPath === 'string' && libPath && typeof libName === 'string' && libName
      ? `${libPath.replace(/\/+$/, '')}/${libName.replace(/(\.min)?\.(js|json)$/, '')}`
      : undefined;
  return { id: env.id, name: a.name || env.id, stage: a.stage, fileId };
}

/** Development, then staging, then production; by name within a stage. */
export function sortEnvironments(envs: EnvironmentInfo[]): EnvironmentInfo[] {
  return [...envs].sort(
    (a, b) =>
      (STAGE_ORDER[a.stage ?? ''] ?? 9) - (STAGE_ORDER[b.stage ?? ''] ?? 9) ||
      a.name.localeCompare(b.name)
  );
}

export interface CopyOption {
  label: string;
  text: string;
}

/** What someone wiring up an app or a site would paste, per platform. */
export function environmentCopyOptions(platform: PropertyPlatform, fileId: string): CopyOption[] {
  if (platform === 'mobile') {
    return [
      { label: 'App ID', text: fileId },
      { label: 'Swift (iOS)', text: `MobileCore.configureWith(appId: "${fileId}")` },
      { label: 'Kotlin (Android)', text: `MobileCore.configureWithAppID("${fileId}")` },
    ];
  }
  const url = `https://assets.adobedtm.com/${fileId}.min.js`;
  return [
    { label: 'Embed code', text: `<script src="${url}" async></script>` },
    { label: 'Library URL', text: url },
  ];
}

// ---------------------------------------------------------------------------
// Mobile data element tokens
// ---------------------------------------------------------------------------

/** `{%%name%%}` — a data element reference in mobile rule settings. */
export const MOBILE_TOKEN_RE = /\{%%([^%\n"]+)%%\}/g;
/** `{%~state.x%}`, `{%~type%}`, … — event tokens, not data elements. */
const EVENT_TOKEN_RE = /\{%~[^%\n"]+%\}/g;

export interface TokenIssue {
  /** Offset of the name (not the braces) in the scanned text. */
  start: number;
  end: number;
  name: string;
  kind: 'unknown' | 'webStyle';
  message: string;
}

/**
 * Data element references a mobile property can't resolve:
 * - `{%%name%%}` where no data element is called `name`;
 * - web-style `%name%` naming a real data element — the author meant a
 *   reference, but mobile only understands `{%%name%%}`.
 *
 * Web-style matches are only reported for names that exist, because `%` is
 * common in URL-encoded strings and format patterns.
 */
export function findMobileTokenIssues(text: string, known: ReadonlySet<string>): TokenIssue[] {
  const issues: TokenIssue[] = [];
  for (const m of text.matchAll(MOBILE_TOKEN_RE)) {
    const name = m[1];
    if (known.has(name)) continue;
    const start = m.index! + 3;
    issues.push({
      start,
      end: start + name.length,
      name,
      kind: 'unknown',
      message: `Unknown data element "${name}" — no data element with this name in the pulled property.`,
    });
  }
  // Blank out real tokens (keeping offsets) so their inner `%%` can't be read as
  // a web-style token.
  const blank = (s: string) => ' '.repeat(s.length);
  const masked = text.replace(MOBILE_TOKEN_RE, blank).replace(EVENT_TOKEN_RE, blank);
  // Look each known name up directly rather than pairing `%`s left to right: a
  // stray `%` ("50% off %price%") would otherwise swallow the real token's opener.
  if (masked.includes('%')) {
    for (const name of known) {
      const needle = `%${name}%`;
      for (let at = masked.indexOf(needle); at !== -1; at = masked.indexOf(needle, at + 1)) {
        const start = at + 1;
        issues.push({
          start,
          end: start + name.length,
          name,
          kind: 'webStyle',
          message: `"%${name}%" is web syntax and won't resolve in a mobile property — use {%%${name}%%}.`,
        });
      }
    }
  }
  return issues.sort((a, b) => a.start - b.start);
}
