/** Build trigger + status reading. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { buildLibrary, getBuild, isBuildSettled } = require(path.join(OUT, 'reactor/library.js'));

const { check, section, done } = require('./harness');

function stubClient(responses = {}) {
  const calls = [];
  return {
    calls,
    async post(url) {
      calls.push({ method: 'POST', url });
      return responses.post ?? { data: { id: 'BLD1', attributes: { status: 'pending' } } };
    },
    async get(url) {
      calls.push({ method: 'GET', url });
      return responses.get ?? { data: { id: 'BLD1', attributes: { status: 'succeeded' } } };
    },
  };
}

(async () => {
section('1. building posts to the library builds endpoint');
{
  const client = stubClient();
  const build = await buildLibrary(client, 'LB1');
  check('posted to /libraries/LB1/builds', client.calls[0]?.url === '/libraries/LB1/builds', client.calls);
  check('returned the build id', build.id === 'BLD1', build);
  check('returned the status', build.status === 'pending', build);
}

section('2. a build is read back by id');
{
  const client = stubClient();
  const build = await getBuild(client, 'BLD1');
  check('read /builds/BLD1', client.calls[0]?.url === '/builds/BLD1', client.calls);
  check('status parsed', build.status === 'succeeded', build);
}

section('3. settled means finished, either way');
{
  check('succeeded is settled', isBuildSettled('succeeded') === true);
  check('failed is settled', isBuildSettled('failed') === true);
  check('pending is not', isBuildSettled('pending') === false);
  // An unrecognized or missing status must not read as "done" — the command
  // reports "status unknown" rather than claiming the build succeeded.
  check('unknown is not settled', isBuildSettled(undefined) === false);
  check('a surprise status is not settled', isBuildSettled('queued') === false);
}

section('4. an unexpected response shape degrades instead of throwing');
{
  const client = stubClient({ post: { data: {} } });
  const build = await buildLibrary(client, 'LB1');
  check('no id invented', build.id === undefined, build);
  check('no status invented', build.status === undefined, build);
  check('not mistaken for settled', isBuildSettled(build.status) === false);
}

done();
})();
