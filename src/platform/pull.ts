/**
 * Pull a read-only snapshot of Experience Platform and CJA configuration:
 * XDM schemas and Data Prep mapping sets per sandbox, and CJA data views with
 * their dimensions and metrics.
 *
 * Layout under `root`:
 *   platform.json                                   org, pull time, per-section outcome
 *   aep/<sandbox>/schemas/<title>__<altId>.json     fully resolved schema (xed-full)
 *   aep/<sandbox>/mapping_sets/<target>__<id>.json  mapping set incl. field mappings
 *   cja/dataviews/<name>__<id>/dataview.json
 *   cja/dataviews/<name>__<id>/dimensions.json
 *   cja/dataviews/<name>__<id>/metrics.json
 *
 * Kept apart from the Launch mirror: nothing here has a manifest or baseline,
 * and push never looks at it. Each section is fetched completely before its
 * directory is replaced, so a section that fails (say, a credential without
 * CJA access) leaves its previous snapshot in place and the others still land.
 */

import * as fs from 'fs';
import * as path from 'path';

import { PlatformClient } from './client';
import { canonicalJson, dirname, slug } from '../local/layout';

export interface Progress {
  report(message: string): void;
}

export interface SectionResult {
  /** e.g. `aep/prod/schemas`, `cja/dataviews` — also its path under the root. */
  name: string;
  ok: boolean;
  count: number;
  error?: unknown;
}

export interface PlatformPullResult {
  root: string;
  sections: SectionResult[];
}

export interface PlatformPullOptions {
  /** Sandboxes to pull; empty means every active sandbox the credential can see. */
  sandboxes?: string[];
  /**
   * Include ad-hoc schemas — the ones Platform generates for query-service and
   * temp datasets. They can outnumber real schemas 40:1, so they're off by default.
   */
  includeAdhocSchemas?: boolean;
  concurrency?: number;
  progress?: Progress;
}

const PAGE_SIZE = 100;
/** A paging loop that never ends is a server bug; don't let it become ours. */
const MAX_PAGES = 1000;

const SCHEMA_LIST_ACCEPT = 'application/vnd.adobe.xed-id+json';
const ADHOC_CLASS = 'https://ns.adobe.com/xdm/data/adhoc';

const DATAVIEW_EXPANSION = [
  'name', 'description', 'owner', 'parentDataGroupId', 'segmentList',
  'currentTimezoneOffset', 'timezoneDesignator', 'modified', 'createdDate',
  'organization', 'curationEnabled', 'sessionDefinition', 'externalData',
  'containerNames', 'sandboxName', 'sandboxId', 'tags',
].join(',');

const COMPONENT_EXPANSION = [
  'approved', 'favorite', 'tags', 'description', 'sourceFieldId', 'segmentable',
  'required', 'hideFromReporting', 'hidden', 'includeExcludeSetting',
  'fieldDefinition', 'storageId', 'tableName', 'dataSetIds', 'dataSetType', 'type',
  'schemaPath', 'hasData', 'sourceFieldName', 'schemaType', 'sourceFieldType',
  'fromGlobalLookup', 'multiValued', 'precision',
];
const DIMENSION_EXPANSION = [
  ...COMPONENT_EXPANSION,
  'bucketingSetting', 'noValueOptionsSetting', 'defaultDimensionSort', 'persistenceSetting',
].join(',');
const METRIC_EXPANSION = [
  ...COMPONENT_EXPANSION,
  'attributionSetting', 'formatSetting', 'decimalPlaces', 'currency', 'polarity',
].join(',');

/**
 * Fields that change on every read without anyone editing anything. Dropping
 * them keeps a re-pull's diff down to real configuration changes.
 */
const VOLATILE_FIELDS = ['usageSummary', 'usageSummaryWithRelevancyScore', 'recentRecordedAccess'];

/**
 * String arrays the APIs return in arbitrary order although order means
 * nothing — sorted so an unchanged mapping or data view re-pulls byte-identical.
 */
const UNORDERED_ARRAYS = new Set(['expressionAttributes', 'dataSetIds', 'segmentList']);

type Json = Record<string, any>;

export async function pullPlatform(
  client: PlatformClient,
  root: string,
  opts: PlatformPullOptions = {}
): Promise<PlatformPullResult> {
  const { concurrency = 8, progress } = opts;
  const report = (msg: string) => progress?.report(msg);
  fs.mkdirSync(root, { recursive: true });
  const sections: SectionResult[] = [];

  /** Run one section; a failure is recorded, not thrown, so the rest still pull. */
  async function section(name: string, run: () => Promise<number>): Promise<void> {
    try {
      const count = await run();
      sections.push({ name, ok: true, count });
    } catch (err) {
      report(`${name}: failed — ${(err as Error).message}`);
      sections.push({ name, ok: false, count: 0, error: err });
    }
  }

  // --- Experience Platform ---------------------------------------------------
  let sandboxes: string[] = [];
  await section('aep/sandboxes', async () => {
    report('Listing sandboxes');
    sandboxes = await listSandboxes(client, opts.sandboxes ?? []);
    return sandboxes.length;
  });

  for (const sandbox of sandboxes) {
    const sbDir = path.join(root, 'aep', slug(sandbox));
    const schemaTitles = new Map<string, string>();

    await section(`aep/${sandbox}/schemas`, async () => {
      report(`[${sandbox}] Listing schemas`);
      const listed = await pageSchemas(client, sandbox, opts.includeAdhocSchemas ?? false);
      report(`[${sandbox}] Found ${listed.length} schemas; fetching definitions…`);
      let done = 0;
      const full = await mapLimit(listed, concurrency, async (s) => {
        const altId: string = s['meta:altId'];
        const major = String(s.version ?? '1').split('.')[0] || '1';
        const schema = await client.aep<Json>(
          sandbox,
          `/data/foundation/schemaregistry/tenant/schemas/${encodeURIComponent(altId)}`,
          { accept: `application/vnd.adobe.xed-full+json; version=${major}` }
        );
        if (++done % 25 === 0 || done === listed.length) {
          report(`[${sandbox}] Schemas: ${done}/${listed.length}`);
        }
        return schema;
      });
      replaceDir(path.join(sbDir, 'schemas'), (dir) => {
        for (const schema of full) {
          const altId = String(schema['meta:altId'] ?? schema.$id);
          fs.writeFileSync(
            path.join(dir, `${dirname(schema.title || altId, altId)}.json`),
            canonicalJson(schema),
            'utf-8'
          );
        }
      });
      for (const s of listed) schemaTitles.set(s.$id, s.title);
      return full.length;
    });

    await section(`aep/${sandbox}/mapping_sets`, async () => {
      report(`[${sandbox}] Listing Data Prep mapping sets`);
      const sets = await pageMappingSets(client, sandbox);
      replaceDir(path.join(sbDir, 'mapping_sets'), (dir) => {
        for (const set of sets) {
          const target: string | undefined =
            set.outputSchema?.schemaRef?.id ?? set.schemaRef?.id;
          const label = (target && schemaTitles.get(target)) || 'mapping-set';
          fs.writeFileSync(
            path.join(dir, `${dirname(label, set.id)}.json`),
            canonicalJson(sortUnordered(set)),
            'utf-8'
          );
        }
      });
      report(`[${sandbox}] Mapping sets: ${sets.length}`);
      return sets.length;
    });
  }

  // --- Customer Journey Analytics ------------------------------------------
  await section('cja/dataviews', async () => {
    report('CJA: listing data views');
    const views = await pageCja(client, '/data/dataviews', { expansion: DATAVIEW_EXPANSION });
    report(`CJA: found ${views.length} data views; fetching components…`);
    let done = 0;
    const withComponents = await mapLimit(views, Math.min(concurrency, 4), async (dv) => {
      const [dimensions, metrics] = await Promise.all([
        pageCja(client, `/data/dataviews/${encodeURIComponent(dv.id)}/dimensions`, {
          expansion: DIMENSION_EXPANSION,
        }),
        pageCja(client, `/data/dataviews/${encodeURIComponent(dv.id)}/metrics`, {
          expansion: METRIC_EXPANSION,
        }),
      ]);
      report(`CJA: ${++done}/${views.length} ${dv.name} (${dimensions.length} dimensions, ${metrics.length} metrics)`);
      return { dv, dimensions, metrics };
    });
    replaceDir(path.join(root, 'cja', 'dataviews'), (dir) => {
      for (const { dv, dimensions, metrics } of withComponents) {
        const dvDir = path.join(dir, dirname(dv.name || dv.id, dv.id));
        fs.mkdirSync(dvDir, { recursive: true });
        fs.writeFileSync(path.join(dvDir, 'dataview.json'), canonicalJson(stable(dv)), 'utf-8');
        fs.writeFileSync(path.join(dvDir, 'dimensions.json'), canonicalJson(sortById(dimensions)), 'utf-8');
        fs.writeFileSync(path.join(dvDir, 'metrics.json'), canonicalJson(sortById(metrics)), 'utf-8');
      }
    });
    return views.length;
  });

  const summary = {
    org_id: client.orgId,
    pulled_at: new Date().toISOString(),
    sections: Object.fromEntries(
      sections.map((s) => [
        s.name,
        s.ok ? { ok: true, count: s.count } : { ok: false, error: (s.error as Error)?.message },
      ])
    ),
  };
  fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify(summary, null, 2) + '\n', 'utf-8');
  return { root, sections };
}

const NO_SANDBOX_HINT =
  'In Adobe Admin Console → Experience Platform → your product profile → Permissions → ' +
  'Sandboxes, add the sandboxes, and add the credential to that profile under API credentials.';

/**
 * The sandboxes this credential can read. The per-caller listing needs no
 * sandbox header and no Sandbox Administration permission — the org-wide
 * `/sandboxes` listing needs both, and 403s a read-only credential.
 */
async function listSandboxes(client: PlatformClient, wanted: string[]): Promise<string[]> {
  const resp = await client.aep<{ sandboxes?: Json[] }>(
    null,
    '/data/foundation/sandbox-management/'
  );
  const active = (resp.sandboxes ?? [])
    .filter((s) => s.state === 'active' && typeof s.name === 'string')
    .map((s) => s.name as string)
    .sort();
  if (!active.length) {
    throw new Error(`This credential can't read any sandbox. ${NO_SANDBOX_HINT}`);
  }
  if (!wanted.length) return active;
  const missing = wanted.filter((w) => !active.includes(w));
  if (missing.length) {
    throw new Error(
      `No read access to sandbox${missing.length === 1 ? '' : 'es'} ${missing.join(', ')} ` +
        `(this credential can read: ${active.join(', ')}). ${NO_SANDBOX_HINT}`
    );
  }
  return wanted;
}

/** Tenant schemas, following the registry's `_page.next` cursor. */
async function pageSchemas(
  client: PlatformClient,
  sandbox: string,
  includeAdhoc: boolean
): Promise<Json[]> {
  const out: Json[] = [];
  let start: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string | number> = { limit: PAGE_SIZE };
    if (!includeAdhoc) query.property = `meta:extends!=${ADHOC_CLASS}`;
    if (start) query.start = start;
    const resp = await client.aep<{ results?: Json[]; _page?: { next?: string | null } }>(
      sandbox,
      '/data/foundation/schemaregistry/tenant/schemas',
      { query, accept: SCHEMA_LIST_ACCEPT }
    );
    out.push(...(resp.results ?? []));
    const next = resp._page?.next ?? undefined;
    if (!next || next === start) break;
    start = next;
  }
  return out;
}

/** Data Prep mapping sets, offset-paged (`_page.count` is not a total). */
async function pageMappingSets(client: PlatformClient, sandbox: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.aep<{ data?: Json[] }>(
      sandbox,
      '/data/foundation/conversion/mappingSets',
      { query: { limit: PAGE_SIZE, start: page * PAGE_SIZE } }
    );
    const rows = resp.data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** CJA's Spring-style pages: `content`, `lastPage`, zero-based `page`. */
async function pageCja(
  client: PlatformClient,
  apiPath: string,
  query: Record<string, string | number>
): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.cja<{ content?: Json[]; lastPage?: boolean }>(apiPath, {
      ...query,
      limit: PAGE_SIZE,
      page,
    });
    const rows = resp.content ?? [];
    out.push(...rows.map((r) => sortUnordered(stable(r))));
    if (resp.lastPage !== false || rows.length === 0) break;
  }
  return out;
}

function stable(obj: Json): Json {
  const copy = { ...obj };
  for (const f of VOLATILE_FIELDS) delete copy[f];
  return copy;
}

function sortUnordered<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortUnordered) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) {
    out[k] =
      UNORDERED_ARRAYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')
        ? [...v].sort()
        : sortUnordered(v);
  }
  return out as T;
}

function sortById(rows: Json[]): Json[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Swap in a freshly written directory, dropping files for deleted resources. */
function replaceDir(dir: string, write: (dir: string) => void): void {
  const staging = `${dir}.pulling`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    write(staging);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
