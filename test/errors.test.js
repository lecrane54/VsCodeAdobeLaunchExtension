/** Translation of IMS / Reactor failures into actionable messages. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { explainError, errorText, formatJsonApiErrors } = require(path.join(OUT, 'reactor/errors.js'));
const { ReactorError } = require(path.join(OUT, 'reactor/client.js'));
const { IMSError } = require(path.join(OUT, 'auth/ims.js'));
const { check, section, done } = require('./harness');

const has = (text, ...words) => words.every((w) => text.toLowerCase().includes(w.toLowerCase()));

section('1. wrong client id / secret — the most common first-run failure');
{
  const e = explainError(new IMSError(400, 'invalid_client', 'client_id or client_secret is invalid'));
  check('names the credentials, not the status code', has(errorText(e), 'rejected these credentials'));
  check('points at Developer Console', has(errorText(e), 'Adobe Developer Console', 'OAuth Server-to-Server'));
  check('offers to re-enter them', e.actions.includes('signIn'));
  console.log('       → ' + errorText(e));
}

section('2. scopes not granted to the credential');
{
  const e = explainError(new IMSError(400, 'invalid_scope', 'invalid scope'));
  check('mentions the Launch API', has(errorText(e), 'Data Collection API'));
  check('offers settings (scopes are a setting)', e.actions.includes('settings'));
  console.log('       → ' + errorText(e));
}

section('3. authenticated but no product profile access');
{
  const e = explainError(new ReactorError(403, { errors: [{ title: 'Forbidden' }] }));
  check('distinguishes access from authentication', has(errorText(e), "can't access"));
  check('names the fix', has(errorText(e), 'product profile'));
  console.log('       → ' + errorText(e));
}

section('4. token rejected');
{
  const e = explainError(new ReactorError(401, {}));
  check('tells them to sign in again', has(errorText(e), 'sign in again') && e.actions.includes('signIn'));
}

section('5. validation error carries the field that failed');
{
  const body = { errors: [{ title: 'Invalid settings', detail: 'is not valid JSON', source: { pointer: '/data/attributes/settings' } }] };
  const e = explainError(new ReactorError(422, body));
  check('surfaces the pointer', has(e.detail, '/data/attributes/settings'));
  check('surfaces title and detail', has(e.detail, 'Invalid settings', 'is not valid JSON'));
  console.log('       → ' + errorText(e));
}

section('6. throttling after retries are exhausted');
{
  const e = explainError(new ReactorError(429, {}));
  check('suggests the concurrency knob', has(errorText(e), 'pullConcurrency'));
}

section('7. never reached Adobe');
{
  const err = new Error('fetch failed');
  err.code = 'ENOTFOUND';
  const e = explainError(err);
  check('blames the network, not the user', has(errorText(e), "couldn't reach adobe"));
  check('names the hosts a proxy would block', has(errorText(e), 'reactor.adobe.io'));
  console.log('       → ' + errorText(e));
}

section('8. unknown errors still produce something readable');
{
  const e = explainError(new Error('something odd'));
  check('passes the message through', errorText(e).includes('something odd'));
  check('always offers details', e.actions.includes('details'));
  const e2 = explainError('a bare string');
  check('survives a non-Error throw', typeof errorText(e2) === 'string' && errorText(e2).length > 0);
}

section('9. JSON:API formatting edge cases');
{
  check('no errors array → undefined', formatJsonApiErrors({}) === undefined);
  check('non-object → undefined', formatJsonApiErrors('plain text') === undefined);
  check('empty array → undefined', formatJsonApiErrors({ errors: [] }) === undefined);
  check('junk entries → undefined', formatJsonApiErrors({ errors: [{}, {}] }) === undefined);
  check('multiple errors join on newlines',
    formatJsonApiErrors({ errors: [{ detail: 'one' }, { detail: 'two' }] }) === 'one\ntwo');
}

done();
