/** Reactor client retry / backoff policy. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { ReactorClient, ReactorError } = require(path.join(OUT, 'reactor/client.js'));

const { check, section, done } = require('./harness');

const auth = { clientId: 'cid', async accessToken() { return 'tok'; } };
function stub(responses) {
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push(`${init.method} ${url.pathname}`);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status < 400, status: r.status,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] },
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  return seen;
}
const ok = { status: 200, body: { data: { id: 'X' } } };

(async () => {
section('1. 429 is retried on every method (Reactor rejected it before applying)');
{
  const seen = stub([{ status: 429, headers: { 'retry-after': '0' } }, ok]);
  const logs = [];
  const c = new ReactorClient(auth, { log: (m) => logs.push(m) });
  const t0 = Date.now();
  const r = await c.post('/properties/PR1/rules', { data: {} });
  check('succeeded after retry', r?.data?.id === 'X');
  check('two attempts made', seen.length === 2, seen);
  check('honored Retry-After: 0 (fast)', Date.now() - t0 < 400);
  check('told the user', /retrying in/.test(logs[0] || ''), logs);
}

section('2. 5xx is retried for GET');
{
  const seen = stub([{ status: 503 }, { status: 502 }, ok]);
  const c = new ReactorClient(auth, {});
  const r = await c.get('/rules/RL1');
  check('recovered', r?.data?.id === 'X' && seen.length === 3, seen);
}

section('3. 5xx is NOT retried for POST (a duplicate rule is worse than an error)');
{
  const seen = stub([{ status: 503, body: { errors: ['down'] } }, ok]);
  const c = new ReactorClient(auth, {});
  let err;
  try { await c.post('/properties/PR1/rules', {}); } catch (e) { err = e; }
  check('threw instead of replaying', err instanceof ReactorError && err.status === 503, String(err));
  check('exactly one attempt', seen.length === 1, seen);
}

section('4. dropped connection is retried for GET only');
{
  const seen = stub([new Error('ECONNRESET'), ok]);
  const c = new ReactorClient(auth, {});
  check('GET recovered', (await c.get('/rules/RL1'))?.data?.id === 'X' && seen.length === 2, seen);

  const seen2 = stub([new Error('ECONNRESET'), ok]);
  const c2 = new ReactorClient(auth, {});
  let err;
  try { await c2.patch('/rules/RL1', {}); } catch (e) { err = e; }
  check('PATCH surfaced the error', /ECONNRESET/.test(String(err)) && seen2.length === 1, seen2);
}

section('5. gives up after the budget and reports the real status');
{
  const seen = stub([{ status: 429, headers: { 'retry-after': '0' } }, { status: 429, headers: { 'retry-after': '0' } },
                     { status: 429, headers: { 'retry-after': '0' } }, { status: 429, headers: { 'retry-after': '0' } }]);
  const c = new ReactorClient(auth, {});
  let err;
  try { await c.get('/rules/RL1'); } catch (e) { err = e; }
  check('4 attempts then throw', seen.length === 4 && err.status === 429, seen);
}

section('6. 4xx client errors are not retried');
{
  const seen = stub([{ status: 422, body: { errors: [{ detail: 'bad settings' }] } }]);
  const c = new ReactorClient(auth, {});
  let err;
  try { await c.patch('/rules/RL1', {}); } catch (e) { err = e; }
  check('one attempt, error preserved', seen.length === 1 && err.status === 422 && /bad settings/.test(err.message), seen);
}

done();
})();
