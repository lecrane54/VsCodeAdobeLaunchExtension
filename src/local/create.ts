/**
 * Local creation of rules and rule components. The extension's write model is
 * "edit locally, push later"; these helpers extend it to *adds* by writing the
 * same on-disk shape pull produces, with a `new-…` placeholder id and a
 * `pending:'create'` manifest entry. Push (see push.ts) turns those into POSTs
 * and reconciles the real Reactor ids.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { canonicalJson, contentHash, dirname, slug } from './layout';
import { Manifest } from './manifest';
import { ComponentKind, namespaceOf } from '../reactor/delegates';

/**
 * A filesystem-safe, obviously-not-real placeholder id (real ids are `RL…`/`EX…`).
 * Must be alphanumeric only (no `-`): the tree parses folder names as
 * `<name>__<id>` with an `[A-Za-z0-9]+` id, so a hyphen here would hide the id and
 * drop the rule's context-menu (propertyTree.ts `displayName`).
 */
export function newLocalId(): string {
  return `new${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Resolve the installed extension that provides a delegate, by matching the
 * delegate namespace (e.g. `core`) to an installed extension's package name.
 * Reads the local `extensions/` mirror — no network.
 */
export function resolveExtensionId(root: string, delegateId: string): string {
  const ns = namespaceOf(delegateId);
  const extDir = path.join(root, 'extensions');
  if (fs.existsSync(extDir)) {
    for (const entry of fs.readdirSync(extDir)) {
      const jsonPath = path.join(extDir, entry, 'extension.json');
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (parsed?.attributes?.name === ns && typeof parsed.id === 'string') {
          return parsed.id;
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  throw new Error(
    `Could not find the "${ns}" extension in this property's local mirror. ` +
      `Pull the property (or install the extension) before adding a "${delegateId}" component.`
  );
}

interface CreatedComponent {
  placeholderId: string;
  jsonPath: string;
  jsPath: string | null;
}

/** Next `order` for a new component: one past the highest existing in the rule. */
function nextOrder(componentsDir: string): number {
  let max = -1;
  if (fs.existsSync(componentsDir)) {
    for (const file of fs.readdirSync(componentsDir)) {
      const m = file.match(/^(\d+)-/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

interface NewComponentOptions {
  ruleId: string;
  ruleDirAbs: string;
  kind: ComponentKind;
  delegateId: string;
  extensionId: string;
  name: string;
  isCustomCode: boolean;
}

/**
 * Write a new rule component (`.json` + optional `.js`) into a rule's
 * `components/` dir and register a pending-create manifest entry. Mirrors the
 * filename/stem scheme pull uses (`<order>-<kind>-<name>`).
 */
export function createRuleComponentLocal(
  root: string,
  manifest: Manifest,
  opts: NewComponentOptions
): CreatedComponent {
  const componentsDir = path.join(opts.ruleDirAbs, 'components');
  fs.mkdirSync(componentsDir, { recursive: true });

  const order = nextOrder(componentsDir);
  const stem = slug(`${String(order).padStart(3, '0')}-${opts.kind}-${opts.name}`.replace(/\//g, '-'), 80);
  const placeholderId = newLocalId();

  const attributes: Record<string, unknown> = {
    name: opts.name,
    settings: {},
    order,
    negate: false,
    delegate_descriptor_id: opts.delegateId,
  };
  const json = canonicalJson({ id: placeholderId, type: 'rule_components', attributes });
  const jsonPath = path.join(componentsDir, `${stem}.json`);
  fs.writeFileSync(jsonPath, json, 'utf-8');

  let jsPath: string | null = null;
  let src = '';
  if (opts.isCustomCode) {
    jsPath = path.join(componentsDir, `${stem}.js`);
    fs.writeFileSync(jsPath, src, 'utf-8');
  }

  manifest.set(`rules/${opts.ruleId}/components/${placeholderId}`, {
    id: placeholderId,
    kind: 'rule_component',
    parent_rule_id: opts.ruleId,
    path: path.relative(root, jsonPath),
    sha256: contentHash(json, src),
    pending: 'create',
    extension_id: opts.extensionId,
  });
  manifest.save(root);

  return { placeholderId, jsonPath, jsPath };
}

interface CreatedRule {
  placeholderId: string;
  ruleDirAbs: string;
  ruleJsonPath: string;
}

/** Write a new (development) rule folder + `rule.json` and register it as a pending create. */
export function createRuleLocal(root: string, manifest: Manifest, name: string): CreatedRule {
  const placeholderId = newLocalId();
  const ruleDirAbs = path.join(root, 'rules', dirname(name, placeholderId));
  fs.mkdirSync(path.join(ruleDirAbs, 'components'), { recursive: true });

  const json = canonicalJson({
    id: placeholderId,
    type: 'rules',
    attributes: { name, enabled: true },
  });
  const ruleJsonPath = path.join(ruleDirAbs, 'rule.json');
  fs.writeFileSync(ruleJsonPath, json, 'utf-8');

  manifest.set(`rules/${placeholderId}`, {
    id: placeholderId,
    kind: 'rule',
    path: path.relative(root, ruleDirAbs),
    sha256: contentHash(json),
    pending: 'create',
  });
  manifest.save(root);

  return { placeholderId, ruleDirAbs, ruleJsonPath };
}
