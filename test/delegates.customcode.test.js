/** Custom-code-only policy for conditions and actions, and the add-menu wiring. */

const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const d = require(path.join(OUT, 'reactor/delegates.js'));
const pkg = require(path.join(__dirname, '..', 'package.json'));

const { check, section, done } = require('./harness');

(async () => {
section('1. conditions and actions are custom-code only; triggers are not');
{
  check('conditions locked to custom code', d.isCustomCodeOnlyKind('conditions') === true);
  check('actions locked to custom code', d.isCustomCodeOnlyKind('actions') === true);
  // A trigger is configuration (click selector, direct-call id), not code —
  // it keeps the delegate picker.
  check('triggers keep the picker', d.isCustomCodeOnlyKind('events') === false);
}

section('2. the custom-code delegate resolves per kind');
{
  check('conditions', d.customCodeDelegateFor('conditions').delegateId === 'core::conditions::custom-code');
  check('actions', d.customCodeDelegateFor('actions').delegateId === 'core::actions::custom-code');
  check('flagged as custom code', d.customCodeDelegateFor('actions').customCode === true);
  check(
    'and is recognized as such downstream',
    d.isCustomCodeDelegate(d.customCodeDelegateFor('conditions').delegateId) === true
  );
}

section('3. every locked kind actually has a custom-code delegate in the catalog');
{
  for (const kind of d.CUSTOM_CODE_ONLY_KINDS) {
    const inCatalog = d.DELEGATE_CATALOG[kind].some((x) => x.customCode);
    check(`${kind} has one in the catalog (not just the fallback)`, inCatalog, d.DELEGATE_CATALOG[kind]);
  }
}

section('4. a kind-specific add command exists for each kind');
{
  const cmds = pkg.contributes.commands.map((c) => c.command);
  check('addTrigger', cmds.includes('adobeLaunch.addTrigger'));
  check('addCondition', cmds.includes('adobeLaunch.addCondition'));
  check('addAction', cmds.includes('adobeLaunch.addAction'));

  const byId = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c]));
  // The title is what the right-click menu shows, so it should say what you get.
  check('condition title names custom code', /custom code/i.test(byId['adobeLaunch.addCondition'].title), byId['adobeLaunch.addCondition'].title);
  check('action title names custom code', /custom code/i.test(byId['adobeLaunch.addAction'].title), byId['adobeLaunch.addAction'].title);
  check('trigger title does not', !/custom code/i.test(byId['adobeLaunch.addTrigger'].title), byId['adobeLaunch.addTrigger'].title);
}

section('5. each command is bound to its own group row, and only that one');
{
  const menus = pkg.contributes.menus['view/item/context'];
  const whensFor = (cmd) => menus.filter((m) => m.command === cmd).map((m) => m.when);

  for (const [cmd, kind] of [
    ['adobeLaunch.addTrigger', 'events'],
    ['adobeLaunch.addCondition', 'conditions'],
    ['adobeLaunch.addAction', 'actions'],
  ]) {
    const whens = whensFor(cmd);
    check(`${cmd} is contributed`, whens.length > 0, whens);
    check(
      `${cmd} targets adobeLaunch.componentGroup.${kind}`,
      whens.every((w) => w.includes(`adobeLaunch.componentGroup.${kind}`)),
      whens
    );
    // Cross-wiring here would put "Add action" on the Conditions row.
    const others = ['events', 'conditions', 'actions'].filter((k) => k !== kind);
    check(
      `${cmd} does not leak onto the other rows`,
      whens.every((w) => others.every((k) => !w.includes(`componentGroup.${k}`))),
      whens
    );
    check(`${cmd} is scoped to the Property view`, whens.every((w) => w.includes('adobeLaunchProperty')), whens);
  }
}

section('6. the row-targeted commands stay out of the command palette');
{
  // Invoked with no row, they have nothing to add to.
  const palette = pkg.contributes.menus.commandPalette;
  for (const cmd of ['adobeLaunch.addTrigger', 'adobeLaunch.addCondition', 'adobeLaunch.addAction']) {
    const entry = palette.find((m) => m.command === cmd);
    check(`${cmd} hidden from palette`, entry && entry.when === 'false', entry);
  }
  // The rule-level one asks for the kind, so it stays.
  const generic = palette.find((m) => m.command === 'adobeLaunch.addRuleComponent');
  check('addRuleComponent still in the palette', generic && generic.when !== 'false', generic);
}

done();
})();
