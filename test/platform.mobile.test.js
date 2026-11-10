/** Mobile property support: platform rules, delegates in use, App IDs, {%%tokens%%}, menu wiring. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const p = require(path.join(OUT, 'reactor/platform.js'));
const pkg = require(path.join(__dirname, '..', 'package.json'));

const { check, section, done } = require('./harness');

(async () => {
section('1. platform normalization');
{
  check('mobile', p.platformOf('mobile') === 'mobile');
  check('edge', p.platformOf('edge') === 'edge');
  check('web', p.platformOf('web') === 'web');
  // Mirrors pulled before platform mattered have no platform: keep the old web behavior.
  check('missing → web', p.platformOf(undefined) === 'web');
  check('garbage → web', p.platformOf('tv') === 'web');
  check('web has Core custom code', p.supportsCoreCustomCode('web') === true);
  check('mobile does not', p.supportsCoreCustomCode('mobile') === false);
  check('edge does not', p.supportsCoreCustomCode('edge') === false);
}

section('2. delegates already used by the property, per kind, most-used first');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-mobile-'));
  const comp = (rule, file, delegate, name) => {
    const dir = path.join(root, 'rules', rule, 'components');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, file),
      JSON.stringify({ attributes: { delegate_descriptor_id: delegate, name } })
    );
  };
  comp('r1', '000-events-launch.json', 'com.adobe.module.core::events::lifecycle-launch', 'App launch');
  comp('r2', '000-events-launch.json', 'com.adobe.module.core::events::lifecycle-launch', 'Launch 2');
  comp('r2', '001-events-track.json', 'com.adobe.module.core::events::track-action', 'Track');
  comp('r2', '002-actions-attach.json', 'com.adobe.module.core::actions::attach-data', 'Attach');
  fs.writeFileSync(path.join(root, 'rules', 'r2', 'components', 'broken.json'), '{not json');

  const events = p.delegatesInUse(root, 'events');
  check('two event delegates', events.length === 2, events);
  check('most used first', events[0].delegateId.endsWith('lifecycle-launch') && events[0].count === 2, events);
  check('example name kept', events[0].example === 'App launch', events[0]);
  const actions = p.delegatesInUse(root, 'actions');
  check('actions kept separate', actions.length === 1 && actions[0].delegateId.endsWith('attach-data'), actions);
  check('unparseable files skipped, not fatal', p.delegatesInUse(root, 'conditions').length === 0);
  check('no rules dir → empty', p.delegatesInUse(path.join(root, 'nope'), 'events').length === 0);
  check('label from delegate', p.delegateLabel('com.adobe.module.core::events::lifecycle-launch') === 'Lifecycle Launch');
  fs.rmSync(root, { recursive: true, force: true });
}

section('3. environment App ID / embed code');
{
  const dev = p.toEnvironmentInfo({
    id: 'EN1',
    attributes: { name: 'Dev', stage: 'development', library_path: '3149c49c3910/b1f4cba2b7f4/', library_name: 'launch-EN1-development.min.js' },
  });
  check('file id joins path and name, minus extension', dev.fileId === '3149c49c3910/b1f4cba2b7f4/launch-EN1-development', dev);
  const mobileJson = p.toEnvironmentInfo({
    id: 'EN2', attributes: { name: 'Prod', stage: 'production', library_path: 'a/b', library_name: 'launch-EN2.json' },
  });
  check('.json library name stripped too', mobileJson.fileId === 'a/b/launch-EN2', mobileJson);
  const noHost = p.toEnvironmentInfo({ id: 'EN3', attributes: { name: 'Stage', stage: 'staging' } });
  check('no host → no file id', noHost.fileId === undefined, noHost);

  const sorted = p.sortEnvironments([mobileJson, noHost, dev]).map((e) => e.stage);
  check('dev, staging, prod order', sorted.join() === 'development,staging,production', sorted);

  const mobile = p.environmentCopyOptions('mobile', 'x/y/launch-EN1-development');
  check('mobile offers the bare App ID first', mobile[0].label === 'App ID' && mobile[0].text === 'x/y/launch-EN1-development');
  check('mobile offers Swift', mobile.some((o) => o.text === 'MobileCore.configureWith(appId: "x/y/launch-EN1-development")'));
  check('mobile offers Kotlin', mobile.some((o) => o.text === 'MobileCore.configureWithAppID("x/y/launch-EN1-development")'));
  const web = p.environmentCopyOptions('web', 'x/y/launch-EN1-development');
  check('web offers the embed script', web[0].text === '<script src="https://assets.adobedtm.com/x/y/launch-EN1-development.min.js" async></script>', web[0]);
}

section('4. mobile data element tokens');
{
  const known = new Set(['user id', 'screen']);
  const issues = (t) => p.findMobileTokenIssues(t, known);

  check('known {%%token%%} is fine', issues('{"v":"{%%user id%%}"}').length === 0);
  const unknown = issues('{"v":"{%%usr id%%}"}');
  check('unknown {%%token%%} flagged', unknown.length === 1 && unknown[0].kind === 'unknown' && unknown[0].name === 'usr id', unknown);
  const text = '{"v":"{%%usr id%%}"}';
  check('range covers just the name', text.slice(unknown[0].start, unknown[0].end) === 'usr id', unknown[0]);

  const webStyle = issues('{"v":"%screen%"}');
  check('web-style %name% of a real data element flagged', webStyle.length === 1 && webStyle[0].kind === 'webStyle', webStyle);
  check('…with the fix in the message', /\{%%screen%%\}/.test(webStyle[0].message), webStyle[0].message);
  check('unknown %name% ignored (URL encoding, format strings)', issues('{"u":"a%20b%3Dc"}').length === 0);
  check('event tokens are not data elements', issues('{"v":"{%~state.com.adobe.module.lifecycle/lifecyclecontextdata.launches%}"}').length === 0);
  // The inner %% of a correct token must not read as a web-style token.
  check('a correct token is not also web-style', issues('{"v":"{%%screen%%}"}').length === 0);
  const stray = issues('{"v":"50% off %screen%"}');
  check('a stray % does not hide a web-style token', stray.length === 1 && stray[0].name === 'screen', stray);
}

section('5. menus: custom code on web rows, extension delegates on mobile/edge rows');
{
  const menus = pkg.contributes.menus['view/item/context'];
  const whens = (cmd) => menus.filter((m) => m.command === cmd).map((m) => m.when);
  for (const cmd of ['adobeLaunch.addCondition', 'adobeLaunch.addAction']) {
    check(`${cmd} hidden on mobile and edge`, whens(cmd).every((w) => w.includes('adobeLaunch.platform != mobile') && w.includes('adobeLaunch.platform != edge')), whens(cmd));
  }
  for (const [cmd, kind] of [['adobeLaunch.addExtensionCondition', 'conditions'], ['adobeLaunch.addExtensionAction', 'actions']]) {
    const w = whens(cmd);
    check(`${cmd} contributed inline and in the context menu`, w.length === 2, w);
    check(`${cmd} only on its own row`, w.every((x) => x.includes(`adobeLaunch.componentGroup.${kind}`)), w);
    check(`${cmd} only on mobile/edge`, w.every((x) => x.includes('adobeLaunch.platform =~ /^(mobile|edge)$/')), w);
  }
  const byId = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c]));
  check('mobile titles do not promise custom code', !/custom code/i.test(byId['adobeLaunch.addExtensionCondition'].title + byId['adobeLaunch.addExtensionAction'].title));
  const palette = pkg.contributes.menus.commandPalette;
  for (const cmd of ['adobeLaunch.addExtensionCondition', 'adobeLaunch.addExtensionAction']) {
    const entry = palette.find((m) => m.command === cmd);
    check(`${cmd} hidden from palette`, entry && entry.when === 'false', entry);
  }
  check('copy App ID command contributed', !!byId['adobeLaunch.copyEnvironmentId']);
}

done();
})();
