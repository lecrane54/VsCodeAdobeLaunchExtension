/** Platform / CJA snapshot pull: paging, layout, per-section failure isolation. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { PlatformClient, PlatformApiError } = require(path.join(OUT, 'platform/client.js'));
const { pullPlatform } = require(path.join(OUT, 'platform/pull.js'));
const { explainError } = require(path.join(OUT, 'reactor/errors.js'));

const { check, section, done } = require('./harness');

const auth = { clientId: 'cid', async accessToken() { return 'tok'; } };
const ORG = 'ORG1@AdobeOrg';

/** Route table: `host path` → handler(url, headers) returning {status, body}. */
function stub(routes) {
  const seen = [];
  global.fetch = async (url, init) => {
    const key = `${url.host} ${url.pathname}`;
    seen.push({ key, url, headers: init.headers });
    const handler = routes[key];
    const r = handler ? handler(url, init.headers) : { status: 404, body: { title: 'no route ' + key } };
    return {
      ok: r.status < 400, status: r.status,
      headers: { get: () => undefined },
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return seen;
}

const P = 'platform.adobe.io';
const C = 'cja.adobe.io';
const SCHEMA_A = { $id: 'https://ns.adobe.com/t/schemas/a', 'meta:altId': '_t.schemas.a', title: 'Web Events', version: '1.2' };
const SCHEMA_B = { $id: 'https://ns.adobe.com/t/schemas/b', 'meta:altId': '_t.schemas.b', title: 'Profile', version: '1.0' };

function baseRoutes(overrides = {}) {
  return {
    [`${P} /data/foundation/sandbox-management/`]: () => ({
      status: 200,
      body: { sandboxes: [
        { name: 'prod', state: 'active' },
        { name: 'dev', state: 'active' },
        { name: 'old', state: 'deleted' },
      ] },
    }),
    // Two pages via the `_page.next` cursor.
    [`${P} /data/foundation/schemaregistry/tenant/schemas`]: (url) =>
      url.searchParams.get('start') === 'c2'
        ? { status: 200, body: { results: [SCHEMA_B], _page: { next: null } } }
        : { status: 200, body: { results: [SCHEMA_A], _page: { next: 'c2' } } },
    [`${P} /data/foundation/schemaregistry/tenant/schemas/_t.schemas.a`]: (url, h) =>
      ({ status: 200, body: { ...SCHEMA_A, properties: { web: {} }, accept: h.Accept } }),
    [`${P} /data/foundation/schemaregistry/tenant/schemas/_t.schemas.b`]: (url, h) =>
      ({ status: 200, body: { ...SCHEMA_B, properties: { person: {} }, accept: h.Accept } }),
    // Offset paging: a full page of 100, then a short one.
    [`${P} /data/foundation/conversion/mappingSets`]: (url) => {
      const start = Number(url.searchParams.get('start'));
      const n = start === 0 ? 100 : 3;
      return { status: 200, body: { data: Array.from({ length: n }, (_, i) => ({
        id: `ms${start + i}`,
        outputSchema: { schemaRef: { id: SCHEMA_A.$id } },
        mappings: [{ source: 'a', destination: 'b', expressionAttributes: ['y', 'x'] }],
      })) } };
    },
    [`${C} /data/dataviews`]: (url) =>
      url.searchParams.get('page') === '0'
        ? { status: 200, body: { content: [{ id: 'dv_1', name: 'Main', recentRecordedAccess: 'now' }], lastPage: false } }
        : { status: 200, body: { content: [{ id: 'dv_2', name: 'China' }], lastPage: true } },
    [`${C} /data/dataviews/dv_1/dimensions`]: () =>
      ({ status: 200, body: { content: [{ id: 'variables/z', dataSetIds: ['d2', 'd1'] }, { id: 'variables/a', usageSummary: { count: 9 } }], lastPage: true } }),
    [`${C} /data/dataviews/dv_1/metrics`]: () =>
      ({ status: 200, body: { content: [{ id: 'metrics/m' }], lastPage: true } }),
    [`${C} /data/dataviews/dv_2/dimensions`]: () => ({ status: 200, body: { content: [], lastPage: true } }),
    [`${C} /data/dataviews/dv_2/metrics`]: () => ({ status: 200, body: { content: [], lastPage: true } }),
    ...overrides,
  };
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

(async () => {
section('1. Full pull: every section lands in the documented layout');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  const seen = stub(baseRoutes());
  const client = new PlatformClient(auth, ORG);
  const res = await pullPlatform(client, root, { sandboxes: ['prod'] });

  check('all sections ok', res.sections.every((s) => s.ok), res.sections);
  const schemaDir = path.join(root, 'aep/prod/schemas');
  const schemas = fs.readdirSync(schemaDir).sort();
  check('both schema pages followed', schemas.length === 2, schemas);
  check('schema file named title__altId', schemas.includes('Web-Events___t.schemas.a.json'), schemas);
  const a = read(path.join(schemaDir, 'Web-Events___t.schemas.a.json'));
  check('fetched resolved schema with major version', a.accept === 'application/vnd.adobe.xed-full+json; version=1', a.accept);
  check('ad-hoc schemas filtered server-side by default', seen.filter((s) => s.key.endsWith('/tenant/schemas')).every((s) => s.url.searchParams.get('property') === 'meta:extends!=https://ns.adobe.com/xdm/data/adhoc'));
  check('schema list asked for xed-id', seen.some((s) => s.key.endsWith('/tenant/schemas') && s.headers.Accept === 'application/vnd.adobe.xed-id+json'));

  const sets = fs.readdirSync(path.join(root, 'aep/prod/mapping_sets'));
  check('mapping sets paged past 100', sets.length === 103, sets.length);
  check('mapping set labelled by target schema', sets.includes('Web-Events__ms0.json'), sets.slice(0, 3));

  const dvs = fs.readdirSync(path.join(root, 'cja/dataviews')).sort();
  check('both data view pages followed', dvs.join() === 'China__dv_2,Main__dv_1', dvs);
  const dims = read(path.join(root, 'cja/dataviews/Main__dv_1/dimensions.json'));
  check('dimensions sorted by id', dims.map((d) => d.id).join() === 'variables/a,variables/z', dims);
  check('unordered dataSetIds sorted', dims[1].dataSetIds.join() === 'd1,d2', dims[1]);
  const ms0 = read(path.join(root, 'aep/prod/mapping_sets/Web-Events__ms0.json'));
  check('unordered expressionAttributes sorted', ms0.mappings[0].expressionAttributes.join() === 'x,y', ms0.mappings[0]);
  check('usageSummary dropped', !('usageSummary' in dims[0]), dims[0]);
  const dv = read(path.join(root, 'cja/dataviews/Main__dv_1/dataview.json'));
  check('recentRecordedAccess dropped', !('recentRecordedAccess' in dv), dv);

  check('org header on every call', seen.every((s) => s.headers['x-gw-ims-org-id'] === ORG));
  check('sandbox header on AEP calls', seen.filter((s) => s.key.startsWith(P) && !s.key.includes('sandbox-management')).every((s) => s.headers['x-sandbox-name'] === 'prod'));
  check('sandbox list is per-caller, with no sandbox header', seen.some((s) => s.key === `${P} /data/foundation/sandbox-management/` && !('x-sandbox-name' in s.headers)));
  check('no sandbox header on CJA calls', seen.filter((s) => s.key.startsWith(C)).every((s) => !('x-sandbox-name' in s.headers)));

  const summary = read(path.join(root, 'platform.json'));
  check('summary records org and counts', summary.org_id === ORG && summary.sections['cja/dataviews'].count === 2, summary);
  check('no staging dirs left behind', !fs.readdirSync(path.join(root, 'cja')).some((d) => d.endsWith('.pulling')));
}

section('2. Empty sandbox setting pulls every active sandbox, skips inactive');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  stub(baseRoutes());
  await pullPlatform(new PlatformClient(auth, ORG), root, {});
  check('prod and dev pulled, deleted skipped', fs.readdirSync(path.join(root, 'aep')).sort().join() === 'dev,prod');
}

section('2b. includeAdhocSchemas drops the filter');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  const seen = stub(baseRoutes());
  await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'], includeAdhocSchemas: true });
  check('no property filter sent', seen.filter((s) => s.key.endsWith('/tenant/schemas')).every((s) => !s.url.searchParams.has('property')));
}

section('3. A 403 from CJA fails only that section and keeps its old snapshot');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  stub(baseRoutes());
  await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'] });

  stub(baseRoutes({
    [`${C} /data/dataviews`]: () => ({ status: 403, body: { error_code: '403003', message: 'Api Key is invalid' } }),
  }));
  const res = await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'] });
  const cja = res.sections.find((s) => s.name === 'cja/dataviews');
  check('cja section failed', cja && !cja.ok);
  check('error is a PlatformApiError', cja.error instanceof PlatformApiError && cja.error.service === 'cja');
  check('aep sections still ok', res.sections.filter((s) => s.name.startsWith('aep')).every((s) => s.ok));
  check('previous data views kept', fs.existsSync(path.join(root, 'cja/dataviews/Main__dv_1/dimensions.json')));
  const e = explainError(cja.error);
  check('403 explained as a CJA permission problem', /Customer Journey Analytics/.test(e.message) && /product profile/.test(e.hint), e);
}

section('4. A resource deleted upstream disappears on the next pull');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  stub(baseRoutes());
  await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'] });
  stub(baseRoutes({
    [`${P} /data/foundation/schemaregistry/tenant/schemas`]: () =>
      ({ status: 200, body: { results: [SCHEMA_A], _page: { next: null } } }),
  }));
  await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'] });
  const schemas = fs.readdirSync(path.join(root, 'aep/prod/schemas'));
  check('stale schema removed', schemas.length === 1 && schemas[0].startsWith('Web-Events'), schemas);
}

section('5. Unknown sandbox fails loudly instead of pulling nothing');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  stub(baseRoutes());
  const res = await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['staging'] });
  const sb = res.sections.find((s) => s.name === 'aep/sandboxes');
  check('sandbox section failed', sb && !sb.ok && /staging/.test(sb.error.message), sb);
  check('names the sandboxes it can read and the fix', /can read: dev, prod/.test(sb.error.message) && /Admin Console/.test(sb.error.message), sb.error.message);
  check('CJA still pulled', res.sections.find((s) => s.name === 'cja/dataviews').ok);
}

section('6. Transient 5xx is retried');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-'));
  let calls = 0;
  stub(baseRoutes({
    [`${C} /data/dataviews/dv_2/metrics`]: () =>
      (++calls === 1 ? { status: 503, body: {} } : { status: 200, body: { content: [], lastPage: true } }),
  }));
  const res = await pullPlatform(new PlatformClient(auth, ORG), root, { sandboxes: ['prod'] });
  check('recovered after one retry', calls === 2 && res.sections.every((s) => s.ok), { calls });
}

done();
})();
