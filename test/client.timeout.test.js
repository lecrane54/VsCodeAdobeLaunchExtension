/** Request deadlines: a stalled socket must fail, not hang forever. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { ReactorClient } = require(path.join(OUT, 'reactor/client.js'));
const { RequestTimeoutError, deadline } = require(path.join(OUT, 'util/http.js'));
const { IMSAuth } = require(path.join(OUT, 'auth/ims.js'));
const { explainError, errorText } = require(path.join(OUT, 'reactor/errors.js'));

const { check, section, done } = require('./harness');

const auth = { clientId: 'cid', async accessToken() { return 'tok'; } };

/** A server that accepts the connection and then says nothing — the hang case. */
function stall() {
  const seen = [];
  global.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      seen.push(`${init.method} ${url.pathname}`);
      init.signal.addEventListener('abort', () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  return seen;
}

/** Headers arrive, body never does. */
function stallBody() {
  global.fetch = async (url, init) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () =>
      new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted body')));
      }),
  });
}

(async () => {
// Deadline timers are unref'd so a pending timeout never holds a process open.
// These stubs have no real socket, so nothing else keeps the loop alive.
const keepAlive = setInterval(() => {}, 1000);

section('1. a stalled GET times out instead of hanging');
{
  const seen = stall();
  const c = new ReactorClient(auth, { timeoutMs: 60 });
  const t0 = Date.now();
  let err;
  try { await c.get('/properties/PR1'); } catch (e) { err = e; }
  const elapsed = Date.now() - t0;
  check('threw rather than hung', err instanceof RequestTimeoutError, String(err));
  check('gave up promptly', elapsed < 4000, elapsed);
  check('retried the read (GET is replayable)', seen.length === 4, seen);
  check('names the call', /Reactor GET \/properties\/PR1/.test(err.message), err.message);
}

section('2. a stalled POST fails on the first attempt — never replayed');
{
  const seen = stall();
  const c = new ReactorClient(auth, { timeoutMs: 60 });
  let err;
  try { await c.post('/properties/PR1/rules', { data: {} }); } catch (e) { err = e; }
  check('timed out', err instanceof RequestTimeoutError, String(err));
  check('exactly one attempt — no duplicate write', seen.length === 1, seen);
}

section('3. a response whose body stalls also times out');
{
  stallBody();
  const c = new ReactorClient(auth, { timeoutMs: 60 });
  let err;
  try { await c.get('/properties/PR1'); } catch (e) { err = e; }
  check('body read is covered by the deadline', err instanceof RequestTimeoutError, String(err));
}

section('4. sign-in stops verifying when IMS stalls');
{
  stall();
  const t0 = Date.now();
  let err;
  try { await new IMSAuth('cid', 'secret', 'openid', 60).accessToken(); } catch (e) { err = e; }
  check('threw a timeout', err instanceof RequestTimeoutError, String(err));
  check('did not hang', Date.now() - t0 < 4000);
  check('blames the sign-in host', /ims-na1\.adobelogin\.com/.test(err.message), err.message);
}

section('5. the timeout reads as a timeout, not as "unreachable"');
{
  const e = new RequestTimeoutError('Reactor GET /properties/PR1', 30_000);
  const text = errorText(explainError(e));
  check('states the budget', /didn't answer within 30s/.test(text), text);
  check('does not claim Adobe was unreachable', !/Couldn't reach Adobe/.test(text), text);
  check('points at the setting', /requestTimeoutSeconds/.test(text), text);
  check('offers settings', explainError(e).actions.includes('settings'));
}

section('6. a successful call still clears its deadline');
{
  global.fetch = async (_url, init) => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ data: { id: 'X' } }),
  });
  const c = new ReactorClient(auth, { timeoutMs: 60 });
  const r = await c.get('/properties/PR1');
  check('returned normally', r?.data?.id === 'X');
  // If done() failed to clear the timer, this sleep would outlive it and the
  // aborted signal would leak into nothing observable — assert directly instead.
  const dl = deadline(50);
  dl.done();
  await new Promise((r2) => setTimeout(r2, 120));
  check('cleared timer never fires', dl.aborted() === false);
}

clearInterval(keepAlive);
done();
})();
