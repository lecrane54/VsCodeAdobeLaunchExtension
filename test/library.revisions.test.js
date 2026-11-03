/** reviseAndAddToLibrary: every changed resource type gets revised into the library. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { reviseAndAddToLibrary, REVISABLE_TYPES } = require(path.join(OUT, 'reactor/library.js'));

const { check, section, done } = require('./harness');

/**
 * Minimal ReactorClient stand-in. Records every call and answers
 * `/<type>/<id>/revisions` from `revisions`.
 */
function stubClient(revisions = {}) {
  const calls = [];
  return {
    calls,
    async patch(url, body) {
      calls.push({ method: 'PATCH', url, action: body?.data?.meta?.action, type: body?.data?.type });
      return { data: {} };
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, data: body?.data });
      return { data: {} };
    },
    async paged(url) {
      calls.push({ method: 'GET', url });
      return revisions[url] ?? [{ id: 'REV_DEFAULT', attributes: { revision_number: 1 } }];
    },
  };
}

(async () => {
section('1. an extension change is revised and added to the library');
{
  const client = stubClient({
    '/extensions/EX1/revisions': [
      { id: 'EXREV1', attributes: { revision_number: 1 } },
      { id: 'EXREV2', attributes: { revision_number: 2 } },
    ],
  });
  const result = await reviseAndAddToLibrary(client, 'LB1', [
    { originId: 'EX1', type: 'extensions' },
  ]);

  const patch = client.calls.find((c) => c.method === 'PATCH');
  check('revised the extension head', patch?.url === '/extensions/EX1' && patch.action === 'revise', patch);
  check('patch body typed as extensions', patch?.type === 'extensions', patch);

  const post = client.calls.find((c) => c.method === 'POST');
  check(
    'posted to the library extensions relationship',
    post?.url === '/libraries/LB1/relationships/extensions',
    post
  );
  check(
    'added the highest revision, not the first',
    JSON.stringify(post?.data) === JSON.stringify([{ type: 'extensions', id: 'EXREV2' }]),
    post?.data
  );
  check('reported it as added', result.added.extensions?.length === 1, result.added);
}

section('2. extensions are batched alongside rules and data elements');
{
  const client = stubClient({
    '/rules/RL1/revisions': [{ id: 'RLREV1', attributes: { revision_number: 3 } }],
    '/data_elements/DE1/revisions': [{ id: 'DEREV1', attributes: { revision_number: 1 } }],
    '/extensions/EX1/revisions': [{ id: 'EXREV1', attributes: { revision_number: 7 } }],
  });
  const result = await reviseAndAddToLibrary(client, 'LB1', [
    { originId: 'RL1', type: 'rules' },
    { originId: 'DE1', type: 'data_elements' },
    { originId: 'EX1', type: 'extensions' },
  ]);

  const posts = client.calls.filter((c) => c.method === 'POST').map((c) => c.url);
  check(
    'one POST per type',
    posts.length === 3 &&
      posts.includes('/libraries/LB1/relationships/rules') &&
      posts.includes('/libraries/LB1/relationships/data_elements') &&
      posts.includes('/libraries/LB1/relationships/extensions'),
    posts
  );
  check('all three revised', client.calls.filter((c) => c.action === 'revise').length === 3);
  check('all three reported', Object.keys(result.added).sort().join(',') === 'data_elements,extensions,rules', result.added);
}

section('3. a type with no changes is not POSTed at all');
{
  const client = stubClient();
  await reviseAndAddToLibrary(client, 'LB1', [{ originId: 'EX1', type: 'extensions' }]);
  const posts = client.calls.filter((c) => c.method === 'POST').map((c) => c.url);
  check('only the extensions relationship touched', posts.length === 1 && /extensions$/.test(posts[0]), posts);
}

section('4. the same resource listed twice is revised once');
{
  const client = stubClient();
  await reviseAndAddToLibrary(client, 'LB1', [
    { originId: 'EX1', type: 'extensions' },
    { originId: 'EX1', type: 'extensions' },
  ]);
  check('deduped before revising', client.calls.filter((c) => c.action === 'revise').length === 1, client.calls);
}

section('5. a resource with no revisions is an error, not a silent skip');
{
  const client = stubClient({ '/extensions/EX1/revisions': [] });
  let err;
  try {
    await reviseAndAddToLibrary(client, 'LB1', [{ originId: 'EX1', type: 'extensions' }]);
  } catch (e) { err = e; }
  check('threw', err instanceof Error && /no revisions/.test(err.message), String(err));
}

section('6. extensions are part of the revisable set');
{
  check(
    'REVISABLE_TYPES covers all three',
    JSON.stringify([...REVISABLE_TYPES].sort()) === JSON.stringify(['data_elements', 'extensions', 'rules']),
    REVISABLE_TYPES
  );
}

done();
})();
