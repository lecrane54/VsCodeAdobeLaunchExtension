/** Command handlers wired into activate(). */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { Config } from '../config';
import { IMSAuth } from '../auth/ims';
import { ReactorClient } from '../reactor/client';
import { ErrorAction, errorText, explainError } from '../reactor/errors';
import { pullProperty } from '../local/pull';
import { PlatformClient } from '../platform/client';
import { pullPlatform } from '../platform/pull';
import { pushProperty } from '../local/push';
import { Manifest } from '../local/manifest';
import {
  detectChanges,
  formatConflict,
  withRequiredParents,
  Change,
  Conflict,
  ConflictChoice,
} from '../local/push';
import { kindOf, readPropertyInfo } from '../local/layout';
import {
  PropertyPlatform,
  delegateLabel,
  delegatesInUse,
  environmentCopyOptions,
  platformOf,
  sortEnvironments,
  supportsCoreCustomCode,
  toEnvironmentInfo,
} from '../reactor/platform';
import {
  createRuleComponentLocal,
  createRuleLocal,
  resolveExtensionId,
} from '../local/create';
import {
  ComponentKind,
  DELEGATE_CATALOG,
  KIND_LABELS,
  customCodeDelegateFor,
  isCustomCodeDelegate,
  isCustomCodeOnlyKind,
  isWellFormedDelegateId,
} from '../reactor/delegates';
import { showSignInPanel } from '../webviews/signIn';
import { showComponentForm } from '../webviews/componentForm';
import {
  buildLibrary,
  createLibrary,
  getBuild,
  isBuildSettled,
  listLibraries,
  reviseAndAddToLibrary,
  BuildStatus,
  LibrarySummary,
  ResourceRef,
  REVISABLE_TYPES,
} from '../reactor/library';
import { ChangeSelection } from '../views/changeSelection';

/** Set once by registerCommands, so reporting helpers don't need it threaded through. */
let output: vscode.OutputChannel | undefined;

const ACTION_LABELS: Record<ErrorAction, string> = {
  signIn: 'Sign in',
  guide: 'Setup guide',
  settings: 'Open settings',
  details: 'Show details',
};

/**
 * Report a failure as a sentence plus the buttons that fix it, with the raw
 * API text kept in the output channel instead of the notification.
 */
async function showError(prefix: string, err: unknown): Promise<void> {
  const explained = explainError(err);
  output?.appendLine(`${prefix}: ${explained.message}`);
  output?.appendLine(explained.detail);

  // Notifications collapse past three buttons into an overflow menu.
  const actions = explained.actions.slice(0, 3);
  const picked = await vscode.window.showErrorMessage(
    `${prefix}: ${errorText(explained)}`,
    ...actions.map((a) => ACTION_LABELS[a])
  );
  if (!picked) return;
  switch (actions.find((a) => ACTION_LABELS[a] === picked)) {
    case 'signIn':
      await vscode.commands.executeCommand('adobeLaunch.signIn');
      break;
    case 'guide':
      await vscode.commands.executeCommand('adobeLaunch.openWalkthrough');
      break;
    case 'settings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'adobeLaunch');
      break;
    default:
      output?.show(true);
  }
}

/** A client if we have credentials, else undefined. Silent — for background callers like the tree. */
export async function createClient(
  config: Config,
  log?: (message: string) => void
): Promise<ReactorClient | undefined> {
  const creds = await config.credentials();
  if (!creds) return undefined;
  const timeoutMs = config.requestTimeoutMs();
  return new ReactorClient(
    new IMSAuth(creds.clientId, creds.clientSecret, creds.scopes, timeoutMs),
    { log, timeoutMs }
  );
}

async function ensureClient(
  config: Config,
  logChannel?: vscode.OutputChannel
): Promise<ReactorClient | undefined> {
  const client = await createClient(config, logChannel && ((m) => logChannel.appendLine(m)));
  if (!client) {
    const choice = await vscode.window.showWarningMessage(
      'Adobe Launch: no credentials found.',
      'Sign in now'
    );
    if (choice === 'Sign in now') {
      await vscode.commands.executeCommand('adobeLaunch.signIn');
    }
    return undefined;
  }
  return client;
}

/**
 * The IMS org behind this credential, read from Reactor's company records —
 * Platform and CJA both require it and the credential alone doesn't name it.
 */
async function resolveOrgId(client: ReactorClient): Promise<string | undefined> {
  const companies = await client.paged<any>('/companies');
  const orgs = new Map<string, string>();
  for (const c of companies) {
    const org = c.attributes?.org_id;
    if (typeof org === 'string' && org) orgs.set(org, c.attributes?.name ?? org);
  }
  if (orgs.size === 0) {
    vscode.window.showErrorMessage(
      'Adobe Launch: no Adobe org visible with these credentials. Check your product profile in Adobe Developer Console.'
    );
    return undefined;
  }
  if (orgs.size === 1) return [...orgs.keys()][0];
  const pick = await vscode.window.showQuickPick(
    [...orgs].map(([id, name]) => ({ label: name, description: id, id })),
    { title: 'Adobe Launch: pull Platform config from which org?', matchOnDescription: true }
  );
  return pick?.id;
}

interface PropertyChoice {
  id: string;
  name: string;
  companyId: string;
}

/** Fetch companies + properties from Reactor and show a QuickPick. Returns the pick or undefined. */
async function pickProperty(
  client: ReactorClient,
  title = 'Adobe Launch: pick a property',
  activeId = ''
): Promise<PropertyChoice | undefined> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading properties from Reactor…' },
    async () => {
      let companies: any[];
      try {
        companies = await client.paged<any>('/companies');
      } catch (err) {
        await showError('Adobe Launch: could not list companies', err);
        return undefined;
      }
      if (companies.length === 0) {
        vscode.window.showErrorMessage(
          'Adobe Launch: no companies visible with these credentials. Check your product profile in Adobe Developer Console.'
        );
        return undefined;
      }
      let companyId: string;
      if (companies.length === 1) {
        companyId = companies[0].id;
      } else {
        const co = await vscode.window.showQuickPick(
          companies.map((c) => ({
            label: c.attributes.name,
            description: c.id,
            id: c.id,
          })),
          { title: 'Adobe Launch: pick a company', matchOnDescription: true }
        );
        if (!co) return undefined;
        companyId = co.id;
      }
      let properties: any[];
      try {
        properties = await client.paged<any>(`/companies/${companyId}/properties`);
      } catch (err) {
        await showError('Adobe Launch: could not list properties', err);
        return undefined;
      }
      if (properties.length === 0) {
        vscode.window.showErrorMessage('Adobe Launch: no properties in that company.');
        return undefined;
      }
      const items = properties
        .map((p) => {
          const a = p.attributes;
          const domains = (a.domains ?? []).join(', ') || (a.platform === 'web' ? '(no domains)' : '');
          const isActive = p.id === activeId;
          return {
            // A check mark on the row you're already using, so switching
            // properties doesn't mean memorizing which id you were on.
            label: `${isActive ? '$(check) ' : ''}${a.name || p.id}`,
            description:
              `${a.platform}${a.enabled === false ? ' · disabled' : ''}  ·  ${p.id}` +
              (isActive ? '  ·  active' : ''),
            detail: domains || undefined,
            id: p.id,
            name: a.name || p.id,
            isActive,
          };
        })
        // Current property first, then alphabetical.
        .sort((a, b) =>
          a.isActive === b.isActive ? a.label.localeCompare(b.label) : a.isActive ? -1 : 1
        );

      const picked = await vscode.window.showQuickPick(items, {
        title,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Type to filter by name, platform, id, or domain',
      });
      if (!picked) return undefined;
      return { id: picked.id, name: picked.name, companyId };
    }
  );
}

/** Show a quick-pick of development libraries for the current property, or offer to create one. */
async function pickLibrary(
  client: ReactorClient,
  propertyId: string,
  title: string
): Promise<LibrarySummary | undefined> {
  let libs: LibrarySummary[];
  try {
    libs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading libraries…' },
      () => listLibraries(client, propertyId, 'development')
    );
  } catch (err) {
    await showError('Adobe Launch: could not list libraries', err);
    return undefined;
  }
  interface Item extends vscode.QuickPickItem {
    lib?: LibrarySummary;
    createNew?: boolean;
  }
  const items: Item[] = [
    { label: '$(add) Create new library…', createNew: true },
    ...(libs.length === 0
      ? []
      : ([{ label: '', kind: vscode.QuickPickItemKind.Separator }] as Item[])),
    ...libs.map<Item>((l) => ({
      label: l.name,
      description: l.id,
      detail:
        (l.updatedAt ? `updated ${l.updatedAt.slice(0, 10)}` : '') +
        (l.updatedBy ? ` by ${l.updatedBy}` : ''),
      lib: l,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'Pick a development library, or create a new one',
  });
  if (!picked) return undefined;
  if (picked.createNew) {
    const name = await vscode.window.showInputBox({
      title: 'Adobe Launch: new library name',
      prompt: 'e.g. "MCP Test" or "Kyle — Rule Optimization"',
      validateInput: (v) => (v.trim().length > 0 ? undefined : 'Name is required.'),
    });
    if (!name) return undefined;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating library "${name}"…` },
        () => createLibrary(client, propertyId, name.trim())
      );
    } catch (err) {
      await showError('Adobe Launch: could not create the library', err);
      return undefined;
    }
  }
  return picked.lib;
}

async function resolvePropertyId(
  config: Config,
  client: ReactorClient,
  opts: { forcePick?: boolean; title?: string } = {}
): Promise<string | undefined> {
  const active = config.activePropertyId();
  if (active && !opts.forcePick) return active;
  const choice = await pickProperty(client, opts.title, active);
  if (!choice) return undefined;
  await config.setActivePropertyId(choice.id);
  return choice.id;
}

/**
 * Ask what to do about resources that moved on in Reactor since the last pull.
 * Cancel is the default — closing the modal never overwrites anyone's work.
 */
function makeConflictPrompt(
  logChannel: vscode.OutputChannel
): (conflicts: Conflict[]) => Promise<ConflictChoice> {
  const OVERWRITE = 'Overwrite with my version';
  const SKIP = 'Skip those, push the rest';
  return async (conflicts) => {
    logChannel.show(true);
    const shown = conflicts.slice(0, 8).map(formatConflict).join('\n');
    const more = conflicts.length > 8 ? `\n… +${conflicts.length - 8} more` : '';
    const choice = await vscode.window.showWarningMessage(
      `${conflicts.length} resource(s) changed in Reactor since you pulled.`,
      {
        modal: true,
        detail:
          `${shown}${more}\n\n` +
          'Overwriting replaces the Reactor version with yours and their edit is lost. ' +
          'To keep it, cancel and pull fresh, then re-apply your change.',
      },
      OVERWRITE,
      SKIP
    );
    if (choice === OVERWRITE) return 'overwrite';
    if (choice === SKIP) return 'skip';
    return 'cancel';
  };
}

function makeProgress(logChannel: vscode.OutputChannel, p: vscode.Progress<{ message?: string }>) {
  return {
    report(msg: string) {
      logChannel.appendLine(msg);
      p.report({ message: msg });
    },
  };
}

/**
 * Poll a build until Reactor settles it. Returns the last status seen — the
 * caller decides what an unsettled one means, because "triggered but unknown"
 * is a different message from "succeeded".
 */
async function waitForBuild(
  client: ReactorClient,
  build: BuildStatus,
  progress: { report: (m: string) => void },
  token: vscode.CancellationToken,
  timeoutMs = 5 * 60_000
): Promise<BuildStatus> {
  if (!build.id || isBuildSettled(build.status)) return build;
  const started = Date.now();
  let last = build;
  let waitMs = 1_000;
  while (!token.isCancellationRequested && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs = Math.min(waitMs * 1.5, 8_000);
    if (token.isCancellationRequested) break;
    try {
      last = await getBuild(client, build.id);
    } catch (err) {
      // A transient read failure shouldn't abort a build that is still running.
      progress.report(`build poll failed: ${(err as Error).message}`);
      continue;
    }
    progress.report(`build ${build.id}: ${last.status ?? 'unknown'}`);
    if (isBuildSettled(last.status)) return last;
  }
  return last;
}

/**
 * Add a trigger / condition / action to a rule.
 *
 * `kind` comes from the row that was right-clicked; when it is undefined (the
 * rule-level "Add trigger/condition/action…") we ask. On web, conditions and
 * actions skip the delegate picker entirely — see `isCustomCodeOnlyKind`. Mobile
 * and edge rules have no Core custom code, so every kind goes through the picker,
 * stocked with the delegates the property already uses.
 */
async function addComponent(
  context: vscode.ExtensionContext,
  config: Config,
  refresh: () => void,
  kind: ComponentKind | undefined,
  arg: unknown
): Promise<void> {
  const pid = config.activePropertyId();
  if (!pid) { await vscode.commands.executeCommand('adobeLaunch.setProperty'); return; }
  const mirror = path.join(config.mirrorRoot(), pid);
  if (!fs.existsSync(mirror)) {
    vscode.window.showInformationMessage('Adobe Launch: not pulled yet — pull the property first.');
    return;
  }

  const rule = await resolveTargetRule(mirror, arg);
  if (!rule) return;

  if (!kind) {
    const kindPick = await vscode.window.showQuickPick(
      [
        { label: '$(symbol-event) Trigger', componentKind: 'events' as ComponentKind },
        { label: '$(filter) Condition', componentKind: 'conditions' as ComponentKind },
        { label: '$(play) Action', componentKind: 'actions' as ComponentKind },
      ],
      { title: `Add to "${rule.name}" — what kind?`, placeHolder: 'Trigger, condition, or action' }
    );
    if (!kindPick) return;
    kind = kindPick.componentKind;
  }

  // On web, conditions and actions are always hand-written JavaScript, so there
  // is nothing to pick — go straight to naming it.
  const platform = platformOf(readPropertyInfo(mirror).platform);
  const delegate =
    supportsCoreCustomCode(platform) && isCustomCodeOnlyKind(kind)
      ? customCodeDelegateFor(kind)
      : await pickDelegate(kind, platform, mirror);
  if (!delegate) return;

  let extensionId: string;
  try {
    extensionId = resolveExtensionId(mirror, delegate.delegateId);
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  const label = KIND_LABELS[kind].toLowerCase();
  const name = await vscode.window.showInputBox({
    title: `Name this ${label}`,
    value: delegate.label,
    validateInput: (v) => (v.trim().length ? undefined : 'Name is required.'),
  });
  if (!name) return;

  const manifest = Manifest.load(mirror);
  let created;
  try {
    created = createRuleComponentLocal(mirror, manifest, {
      ruleId: rule.id,
      ruleDirAbs: rule.dirAbs,
      kind,
      delegateId: delegate.delegateId,
      extensionId,
      name: name.trim(),
      isCustomCode: isCustomCodeDelegate(delegate.delegateId),
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Adobe Launch: could not add component: ${(err as Error).message}`);
    return;
  }

  refresh();
  vscode.window.showInformationMessage(
    `Adobe Launch: added ${label} "${name.trim()}" to "${rule.name}" (unpushed).`
  );

  // Custom code opens the .js sidecar; config opens the settings form.
  if (created.jsPath) {
    await vscode.window.showTextDocument(vscode.Uri.file(created.jsPath));
  } else {
    showComponentForm(context, created.jsonPath, refresh);
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  config: Config,
  refresh: () => void,
  logChannel: vscode.OutputChannel,
  selection: ChangeSelection
): void {
  output = logChannel;
  context.subscriptions.push(
    vscode.commands.registerCommand('adobeLaunch.signIn', async () => {
      showSignInPanel(context, config, refresh);
    }),

    vscode.commands.registerCommand('adobeLaunch.editComponentConfig', async (arg?: unknown) => {
      const jsonPath = resolveComponentPath(arg);
      if (!jsonPath) {
        vscode.window.showWarningMessage('Adobe Launch: no component config for that item.');
        return;
      }
      showComponentForm(context, jsonPath, refresh);
    }),

    vscode.commands.registerCommand('adobeLaunch.openRawJson', async (arg?: unknown) => {
      const jsonPath = resolveComponentPath(arg);
      if (jsonPath) await vscode.window.showTextDocument(vscode.Uri.file(jsonPath));
    }),

    vscode.commands.registerCommand('adobeLaunch.signOut', async () => {
      await config.clearCredentials();
      vscode.window.showInformationMessage('Adobe Launch: credentials cleared.');
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.setProperty', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const choice = await pickProperty(client, 'Adobe Launch: set active property', config.activePropertyId());
      if (!choice) return;
      await config.setActivePropertyId(choice.id);
      vscode.window.showInformationMessage(`Adobe Launch: active property = ${choice.name}`);
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.setLibrary', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const pid = await resolvePropertyId(config, client, { title: 'Adobe Launch: pick a property first' });
      if (!pid) return;
      const lib = await pickLibrary(client, pid, 'Adobe Launch: set active library');
      if (!lib) return;
      await config.setActiveLibrary(lib.id, lib.name);
      vscode.window.showInformationMessage(`Adobe Launch: active library = ${lib.name}`);
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.pull', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const pid = await resolvePropertyId(config, client, { forcePick: true, title: 'Adobe Launch: pull which property?' });
      if (!pid) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pulling ${pid}…`, cancellable: false },
        async (progress) => {
          try {
            await pullProperty(client, pid, config.mirrorRoot(), {
              concurrency: config.pullConcurrency(),
              progress: makeProgress(logChannel, progress),
            });
            vscode.window.showInformationMessage(`Adobe Launch: pulled ${pid}`);
            refresh();
          } catch (err) {
            await showError('Adobe Launch pull failed', err);
          }
        }
      );
    }),

    vscode.commands.registerCommand('adobeLaunch.pullPlatform', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const creds = await config.credentials(); if (!creds) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Pulling AEP schemas, mappings & CJA components…',
          cancellable: false,
        },
        async (progress) => {
          try {
            const orgId = await resolveOrgId(client);
            if (!orgId) return;
            const timeoutMs = config.requestTimeoutMs();
            const platform = new PlatformClient(
              new IMSAuth(creds.clientId, creds.clientSecret, creds.scopes, timeoutMs),
              orgId,
              { log: (m) => logChannel.appendLine(m), timeoutMs }
            );
            const result = await pullPlatform(platform, config.platformMirrorRoot(), {
              sandboxes: config.platformSandboxes(),
              includeAdhocSchemas: config.platformIncludeAdhocSchemas(),
              concurrency: config.pullConcurrency(),
              progress: makeProgress(logChannel, progress),
            });
            const failed = result.sections.filter((s) => !s.ok);
            const pulled = result.sections
              .filter((s) => s.ok && s.name !== 'aep/sandboxes')
              .map((s) => `${s.name} (${s.count})`);
            logChannel.appendLine(`Platform pull → ${result.root}`);
            if (!failed.length) {
              vscode.window.showInformationMessage(
                `Adobe Launch: pulled ${pulled.length} sections to ${path.basename(result.root)}/.`
              );
              return;
            }
            for (const f of failed) logChannel.appendLine(`  ${f.name}: ${(f.error as Error)?.message}`);
            // Explain the first failure; the rest are usually the same cause.
            await showError(
              `Adobe Launch: ${failed.length} of ${result.sections.length} sections failed ` +
                `(${failed.map((f) => f.name).join(', ')})`,
              failed[0].error
            );
          } catch (err) {
            await showError('Adobe Launch Platform pull failed', err);
          }
        }
      );
    }),

    vscode.commands.registerCommand('adobeLaunch.pullFresh', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const pid = await resolvePropertyId(config, client, { forcePick: true, title: 'Adobe Launch: fresh-pull which property?' });
      if (!pid) return;
      // Name the property and count what's about to be destroyed — "wipe
      // PR8fb5f409…" tells the user neither which property nor what they lose.
      let label = pid;
      let pending = 0;
      try {
        const mirror = path.join(config.mirrorRoot(), pid);
        if (fs.existsSync(mirror)) {
          label = readPropertyInfo(mirror).name ?? pid;
          pending = detectChanges(mirror, Manifest.load(mirror)).length;
        }
      } catch {
        /* no mirror to describe — the generic warning still applies */
      }
      const ok = await vscode.window.showWarningMessage(
        `Wipe the local mirror of "${label}" and re-pull from Reactor?`,
        {
          modal: true,
          detail:
            (pending
              ? `${pending} unpushed change${pending === 1 ? '' : 's'} will be lost permanently.\n\n`
              : 'The mirror has no unpushed changes.\n\n') + pid,
        },
        'Wipe and pull'
      );
      if (ok !== 'Wipe and pull') return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fresh pull ${pid}…`, cancellable: false },
        async (progress) => {
          try {
            await pullProperty(client, pid, config.mirrorRoot(), {
              concurrency: config.pullConcurrency(),
              fresh: true,
              progress: makeProgress(logChannel, progress),
            });
            vscode.window.showInformationMessage(`Adobe Launch: fresh-pulled ${pid}`);
            refresh();
          } catch (err) {
            await showError('Adobe Launch pull failed', err);
          }
        }
      );
    }),

    vscode.commands.registerCommand('adobeLaunch.pushDryRun', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const pid = await resolvePropertyId(config, client);
      if (!pid) return;
      // Preview exactly what a push would send — the ticked subset, not everything.
      let only: Set<string> | undefined;
      try {
        const mirror = path.join(config.mirrorRoot(), pid);
        const all = detectChanges(mirror, Manifest.load(mirror));
        selection.prune(all);
        if (selection.hasExclusions) {
          only = withRequiredParents(all, new Set(selection.filter(all).map((c) => c.key))).keys;
        }
      } catch {
        // No mirror yet — let pushProperty report it.
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Push dry-run ${pid}…` },
        async (progress) => {
          try {
            const result = await pushProperty(client, pid, config.mirrorRoot(), {
              dryRun: true,
              progress: makeProgress(logChannel, progress),
              only,
            });
            if (result.changes.length === 0) {
              vscode.window.showInformationMessage('Adobe Launch: no local changes.');
            } else {
              logChannel.show(true);
              const drift = result.conflicts.length
                ? ` ${result.conflicts.length} conflict(s) with newer Reactor state.`
                : '';
              const show = result.conflicts.length
                ? vscode.window.showWarningMessage
                : vscode.window.showInformationMessage;
              show(
                `Adobe Launch: ${result.changes.length} change(s) would be pushed.${drift}` +
                  ' See "Adobe Launch" output for details.'
              );
            }
            refresh();
          } catch (err) {
            await showError('Adobe Launch dry-run failed', err);
          }
        }
      );
    }),

    /**
     * Legacy id. Pushing now always goes through the active library, so this
     * forwards rather than PATCHing the property head on its own — a bare push
     * leaves the change unrevised and undeployed, which is never what we want.
     * Kept registered so an existing keybinding still does the right thing.
     */
    vscode.commands.registerCommand('adobeLaunch.push', async () => {
      await vscode.commands.executeCommand('adobeLaunch.pushToLibrary');
    }),

    vscode.commands.registerCommand('adobeLaunch.pushToLibrary', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const pid = await resolvePropertyId(config, client);
      if (!pid) return;
      const mirror = path.join(config.mirrorRoot(), pid);
      if (!fs.existsSync(mirror)) {
        vscode.window.showErrorMessage(`Adobe Launch: no local mirror at ${mirror}. Pull first.`);
        return;
      }
      const manifest = Manifest.load(mirror);
      const all = detectChanges(mirror, manifest);
      if (all.length === 0) {
        vscode.window.showInformationMessage('Adobe Launch: no local changes to push.');
        return;
      }
      selection.prune(all);
      const ticked = selection.filter(all);
      if (ticked.length === 0) {
        vscode.window.showInformationMessage(
          'Adobe Launch: nothing ticked in the Changes view — tick at least one change to push.'
        );
        return;
      }
      // A brand-new component can't be POSTed before the rule it hangs off.
      const { keys: onlyKeys, added: pulledIn } = withRequiredParents(
        all,
        new Set(ticked.map((c) => c.key))
      );
      const changes = all.filter((c) => onlyKeys.has(c.key));
      const subset = changes.length < all.length;

      // This command always targets the active library — never the bare property.
      // The toolbar button is disabled without one (see `enablement` in package.json),
      // but the command can still be reached before the context key has synced.
      const activeId = config.activeLibraryId();
      if (!activeId) {
        const pick = await vscode.window.showWarningMessage(
          'Adobe Launch: no active library. Set one before pushing.',
          'Set active library'
        );
        if (pick === 'Set active library') {
          await vscode.commands.executeCommand('adobeLaunch.setLibrary');
        }
        return;
      }
      const lib: LibrarySummary = {
        id: activeId,
        name: config.activeLibraryName() || activeId,
        state: 'development',
      };

      const pulledInNote = pulledIn.length
        ? `\n\nAlso including ${pulledIn.length} new rule(s) the ticked components belong to — ` +
          'a component cannot be created before its rule.'
        : '';
      const ok = await vscode.window.showWarningMessage(
        subset
          ? `Push ${changes.length} of ${all.length} change(s) and add revisions to "${lib.name}"?`
          : `Push ${changes.length} change(s) and add revisions to "${lib.name}"?`,
        {
          modal: true,
          detail:
            changes.slice(0, 10).map((c) => `${c.kind} · ${c.resourceId}`).join('\n') +
            (changes.length > 10 ? `\n… +${changes.length - 10} more` : '') +
            pulledInNote,
        },
        'Push to library'
      );
      if (ok !== 'Push to library') return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Push → ${lib.name}` },
        async (progress) => {
          const p = makeProgress(logChannel, progress);
          try {
            p.report(`Step 1/3: PATCHing ${changes.length} resource(s)…`);
            const pushResult = await pushProperty(client, pid, config.mirrorRoot(), {
              progress: p,
              onConflicts: makeConflictPrompt(logChannel),
              only: onlyKeys,
            });
            if (pushResult.cancelled) {
              vscode.window.showWarningMessage(
                `Adobe Launch: push cancelled — ${pushResult.conflicts.length} resource(s) changed in Reactor. Nothing was pushed or added to "${lib.name}".`
              );
              return;
            }
            if (pushResult.applied === 0) {
              vscode.window.showWarningMessage('Adobe Launch: nothing applied — aborting library add.');
              return;
            }

            // Collect origins to revise: rule_component changes bubble up to their parent rule.
            const refs: ResourceRef[] = [];
            for (const c of pushResult.changes) {
              if (c.kind === 'rule') refs.push({ originId: c.resourceId, type: 'rules' });
              else if (c.kind === 'rule_component' && c.parentRuleId) {
                refs.push({ originId: c.parentRuleId, type: 'rules' });
              }
              else if (c.kind === 'data_element') refs.push({ originId: c.resourceId, type: 'data_elements' });
              else if (c.kind === 'extension') refs.push({ originId: c.resourceId, type: 'extensions' });
            }
            if (refs.length === 0) {
              vscode.window.showInformationMessage('Adobe Launch: pushed but no resources needed library add.');
              refresh();
              return;
            }

            p.report(`Step 2/3: revising ${new Set(refs.map(r => r.originId)).size} resource(s)…`);
            const addResult = await reviseAndAddToLibrary(client, lib.id, refs);
            const addedCount = REVISABLE_TYPES.reduce(
              (n, t) => n + (addResult.added[t]?.length ?? 0),
              0
            );
            // Name the types — extension revisions are easy to miss, and their
            // absence used to be the thing that made a build ship stale settings.
            const breakdown = REVISABLE_TYPES.filter((t) => addResult.added[t]?.length)
              .map((t) => `${addResult.added[t]!.length} ${t.replace(/_/g, ' ')}`)
              .join(', ');
            p.report(
              `Step 3/3: added ${addedCount} revision(s) to "${lib.name}"` +
                (breakdown ? ` — ${breakdown}` : '')
            );

            const build = await vscode.window.showInformationMessage(
              `Adobe Launch: pushed ${pushResult.applied}, added ${addedCount} to "${lib.name}".`,
              'Build library now',
              'Later'
            );
            if (build === 'Build library now') {
              await buildLibrary(client, lib.id);
              vscode.window.showInformationMessage(`Adobe Launch: build triggered for "${lib.name}".`);
            }
            refresh();
          } catch (err) {
            await showError('Adobe Launch push-to-library failed', err);
          }
        }
      );
    }),

    /**
     * Build the active library. Reachable on its own — the post-push
     * notification's "Build library now" button disappears when the
     * notification does, and the Library view flags "build required" without
     * offering any way to act on it.
     */
    vscode.commands.registerCommand('adobeLaunch.buildLibrary', async () => {
      const client = await ensureClient(config, logChannel); if (!client) return;
      const libId = config.activeLibraryId();
      if (!libId) {
        const pick = await vscode.window.showWarningMessage(
          'Adobe Launch: no active library to build.',
          'Set active library'
        );
        if (pick === 'Set active library') {
          await vscode.commands.executeCommand('adobeLaunch.setLibrary');
        }
        return;
      }
      const name = config.activeLibraryName() || libId;
      const ok = await vscode.window.showWarningMessage(
        `Build "${name}"?`,
        {
          modal: true,
          detail:
            'This publishes the library to its environment. Anything already in the ' +
            'library is included, not just what you pushed.',
        },
        'Build'
      );
      if (ok !== 'Build') return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Building "${name}"…`, cancellable: true },
        async (progress, token) => {
          const p = makeProgress(logChannel, progress);
          try {
            const build = await buildLibrary(client, libId);
            p.report(`Build ${build.id ?? '(id unknown)'} status=${build.status ?? 'unknown'}`);
            const final = await waitForBuild(client, build, p, token);
            refresh();
            if (final.status === 'succeeded') {
              vscode.window.showInformationMessage(`Adobe Launch: "${name}" built successfully.`);
            } else if (final.status === 'failed') {
              const pick = await vscode.window.showErrorMessage(
                `Adobe Launch: build of "${name}" failed. Reactor usually explains why on the build in the Launch UI.`,
                'Show details'
              );
              if (pick === 'Show details') logChannel.show(true);
            } else if (token.isCancellationRequested) {
              vscode.window.showInformationMessage(
                `Adobe Launch: stopped watching the build of "${name}" — it is still running on Reactor.`
              );
            } else {
              // Either the poll timed out or the response wasn't the shape we
              // expected. Say what we actually know rather than claim success.
              vscode.window.showWarningMessage(
                `Adobe Launch: build of "${name}" triggered; final status unknown (last seen: ${final.status ?? 'unknown'}).`
              );
            }
          } catch (err) {
            await showError('Adobe Launch build failed', err);
          }
        }
      );
    }),

    vscode.commands.registerCommand('adobeLaunch.selectAllChanges', async () => {
      selection.selectAll();
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.selectNoChanges', async () => {
      const pid = config.activePropertyId();
      if (!pid) return;
      try {
        const mirror = path.join(config.mirrorRoot(), pid);
        selection.selectNone(detectChanges(mirror, Manifest.load(mirror)));
      } catch {
        return;
      }
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.goto', async () => {
      const pid = config.activePropertyId();
      if (!pid) {
        await vscode.commands.executeCommand('adobeLaunch.setProperty');
        return;
      }
      const mirror = path.join(config.mirrorRoot(), pid);
      if (!fs.existsSync(mirror)) {
        vscode.window.showInformationMessage('Adobe Launch: not pulled yet.');
        return;
      }
      const items = collectResources(mirror);
      if (items.length === 0) {
        vscode.window.showInformationMessage('Adobe Launch: nothing to open — pull the property first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Adobe Launch: go to resource',
        matchOnDescription: true,
        placeHolder: 'Search rules, data elements, and extensions by name…',
      });
      if (picked?.path) {
        await vscode.window.showTextDocument(vscode.Uri.file(picked.path));
      }
    }),

    vscode.commands.registerCommand('adobeLaunch.showStatus', async () => {
      const pid = config.activePropertyId();
      if (!pid) {
        await vscode.commands.executeCommand('adobeLaunch.setProperty');
        return;
      }
      const mirror = path.join(config.mirrorRoot(), pid);
      if (!fs.existsSync(mirror)) {
        vscode.window.showInformationMessage('Adobe Launch: not pulled yet.');
        return;
      }
      const manifest = Manifest.load(mirror);
      const changes = detectChanges(mirror, manifest);
      if (changes.length === 0) {
        vscode.window.showInformationMessage('Adobe Launch: in sync — no local changes.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        changes.map((c) => {
          // Prefer the editable JavaScript when the change has code.
          const open = c.jsPath ?? c.jsonPath;
          const { label, description } = describeChange(c);
          return { label, description, path: open };
        }),
        {
          title: `${changes.length} unpushed change(s) — pick one to open`,
          matchOnDescription: true,
        }
      );
      if (picked?.path) {
        await vscode.window.showTextDocument(vscode.Uri.file(picked.path));
      }
    }),

    vscode.commands.registerCommand('adobeLaunch.addRuleComponent', async (arg?: unknown) => {
      await addComponent(context, config, refresh, undefined, arg);
    }),

    // One command per kind so the right-click menu on a Triggers / Conditions /
    // Actions row reads "Add trigger" rather than a generic "Add component".
    vscode.commands.registerCommand('adobeLaunch.addTrigger', async (arg?: unknown) => {
      await addComponent(context, config, refresh, 'events', arg);
    }),

    vscode.commands.registerCommand('adobeLaunch.addCondition', async (arg?: unknown) => {
      await addComponent(context, config, refresh, 'conditions', arg);
    }),

    vscode.commands.registerCommand('adobeLaunch.addAction', async (arg?: unknown) => {
      await addComponent(context, config, refresh, 'actions', arg);
    }),

    // Mobile/edge counterparts for the Conditions / Actions rows. Same flow —
    // addComponent picks by platform — but titled without "(custom code)",
    // which these properties don't have.
    vscode.commands.registerCommand('adobeLaunch.addExtensionCondition', async (arg?: unknown) => {
      await addComponent(context, config, refresh, 'conditions', arg);
    }),

    vscode.commands.registerCommand('adobeLaunch.addExtensionAction', async (arg?: unknown) => {
      await addComponent(context, config, refresh, 'actions', arg);
    }),

    vscode.commands.registerCommand('adobeLaunch.copyEnvironmentId', () =>
      copyEnvironmentId(config, logChannel)
    ),

    vscode.commands.registerCommand('adobeLaunch.newRule', async () => {
      const pid = config.activePropertyId();
      if (!pid) { await vscode.commands.executeCommand('adobeLaunch.setProperty'); return; }
      const mirror = path.join(config.mirrorRoot(), pid);
      if (!fs.existsSync(mirror)) {
        vscode.window.showInformationMessage('Adobe Launch: not pulled yet — pull the property first.');
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'Adobe Launch: new rule name',
        prompt: 'A development-state rule is created locally and pushed later.',
        validateInput: (v) => (v.trim().length ? undefined : 'Name is required.'),
      });
      if (!name) return;

      const manifest = Manifest.load(mirror);
      let created;
      try {
        created = createRuleLocal(mirror, manifest, name.trim());
      } catch (err) {
        vscode.window.showErrorMessage(`Adobe Launch: could not create rule: ${(err as Error).message}`);
        return;
      }
      refresh();

      const next = await vscode.window.showInformationMessage(
        `Adobe Launch: created rule "${name.trim()}" (unpushed).`,
        'Add trigger/condition/action',
        'Open rule.json'
      );
      if (next === 'Add trigger/condition/action') {
        await vscode.commands.executeCommand('adobeLaunch.addRuleComponent', {
          resourceUri: vscode.Uri.file(created.ruleDirAbs),
        });
      } else if (next === 'Open rule.json') {
        await vscode.window.showTextDocument(vscode.Uri.file(created.ruleJsonPath));
      }
    }),

    vscode.commands.registerCommand('adobeLaunch.search', async () => {
      const pid = config.activePropertyId();
      if (!pid) { await vscode.commands.executeCommand('adobeLaunch.setProperty'); return; }
      const mirror = path.join(config.mirrorRoot(), pid);
      if (!fs.existsSync(mirror)) {
        vscode.window.showInformationMessage('Adobe Launch: not pulled yet — pull the property first.');
        return;
      }
      const query = await vscode.window.showInputBox({
        title: 'Adobe Launch: search rules & code',
        prompt: 'Text to find in names, settings, and custom code. Filters: kind:events|conditions|actions, delegate:<substr>',
        placeHolder: 'e.g.  checkout   ·   kind:events click   ·   delegate:custom-code',
      });
      if (query === undefined) return;
      const results = searchMirror(mirror, query);
      if (results.length === 0) {
        vscode.window.showInformationMessage('Adobe Launch: no matches.');
        return;
      }
      const picked = await vscode.window.showQuickPick(results, {
        title: `${results.length} match(es)`,
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Open a match',
      });
      if (picked?.path) await vscode.window.showTextDocument(vscode.Uri.file(picked.path));
    }),
  );
}

/**
 * Resolve the component `.json` path from whatever a command hands us: the tree
 * click passes the path string directly; a context-menu invocation passes the
 * tree Node (with `.path`). Falls back to the active editor.
 */
function resolveComponentPath(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if (arg && typeof arg === 'object') {
    const a = arg as { path?: unknown; resourceUri?: vscode.Uri };
    if (typeof a.path === 'string') return a.path;
    if (a.resourceUri instanceof vscode.Uri) return a.resourceUri.fsPath;
  }
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

/** Strip the trailing `__<resourceId>` a directory carries for uniqueness. */
function stripId(dirName: string): string {
  // `-` included so locally-created `new…` placeholder ids strip cleanly too.
  const m = dirName.match(/^(.*)__[A-Za-z0-9-]+$/);
  return m ? m[1] : dirName;
}

interface GotoItem extends vscode.QuickPickItem {
  path?: string;
}

/** Enumerate every rule / data element / extension for the "go to resource" picker. */
function collectResources(mirror: string): GotoItem[] {
  const out: GotoItem[] = [];
  const add = (
    folder: string,
    kind: string,
    icon: string,
    fileFor: (dir: string) => string | undefined
  ) => {
    const abs = path.join(mirror, folder);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs).sort()) {
      const dir = path.join(abs, entry);
      let isDir = false;
      try {
        isDir = fs.statSync(dir).isDirectory();
      } catch {
        /* ignore */
      }
      if (!isDir) continue;
      out.push({ label: `$(${icon}) ${stripId(entry)}`, description: kind, path: fileFor(dir) });
    }
  };
  const pick = (dir: string, ...names: string[]): string | undefined =>
    names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));

  add('rules', 'rule', 'symbol-event', (dir) => pick(dir, 'rule.json'));
  add('data_elements', 'data element', 'symbol-variable', (dir) => pick(dir, 'settings.js', 'data_element.json'));
  add('extensions', 'extension', 'package', (dir) => pick(dir, 'settings.js', 'extension.json'));
  return out;
}

/**
 * Human-readable label + kind for an unpushed change, derived from the mirror
 * folder names — no resource ids. Rule components show their action name and
 * the rule they belong to.
 */
function describeChange(c: Change): { label: string; description: string } {
  if (c.kind === 'rule_component') {
    // jsonPath = <ruleDir>/components/<order>-<kind>-<name>.json
    const ruleName = stripId(path.basename(path.dirname(path.dirname(c.jsonPath))));
    const stem = path.basename(c.jsonPath).replace(/\.(js|json)$/, '');
    const m = stem.match(/^\d+-([a-z0-9]+)-(.*)$/i);
    const kind = m ? m[1] : 'component';
    const name = (m ? m[2] : stem) || ruleName;
    return { label: name, description: `${kind} · ${ruleName}` };
  }
  const name = stripId(path.basename(path.dirname(c.jsonPath)));
  const kind =
    c.kind === 'data_element' ? 'data element' : c.kind === 'extension' ? 'extension' : 'rule';
  return { label: name, description: kind };
}

// ---------------------------------------------------------------------------
// Add-component / new-rule / search helpers
// ---------------------------------------------------------------------------

interface TargetRule {
  id: string;
  name: string;
  dirAbs: string;
}

/** Read a rule's id + name from its `rule.json`, falling back to the folder name. */
function readRuleInfo(dirAbs: string, folderName: string): { id: string; name: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dirAbs, 'rule.json'), 'utf-8'));
    const id = typeof parsed?.id === 'string' ? parsed.id : stripId(folderName);
    const name = parsed?.attributes?.name ?? stripId(folderName);
    return { id, name };
  } catch {
    return { id: stripId(folderName), name: stripId(folderName) };
  }
}

/** If a command arg is a rule tree node, resolve its `rules/<folder>` directory. */
function ruleFromArg(mirror: string, arg: unknown): TargetRule | undefined {
  let candidate: string | undefined;
  if (arg && typeof arg === 'object') {
    const a = arg as { resourceUri?: vscode.Uri; path?: unknown; ruleDirAbs?: unknown };
    // A component-group row carries its rule folder outright.
    if (typeof a.ruleDirAbs === 'string') candidate = a.ruleDirAbs;
    else if (a.resourceUri instanceof vscode.Uri) candidate = a.resourceUri.fsPath;
    else if (typeof a.path === 'string') candidate = a.path;
  }
  if (!candidate) return undefined;

  const rulesAbs = path.join(mirror, 'rules');
  let dir = candidate;
  try { if (fs.statSync(dir).isFile()) dir = path.dirname(dir); } catch { /* may not exist yet */ }
  // Climb to the immediate child of rules/.
  while (dir && path.dirname(dir) !== rulesAbs && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  if (path.dirname(dir) !== rulesAbs) return undefined;
  const info = readRuleInfo(dir, path.basename(dir));
  return { id: info.id, name: info.name, dirAbs: dir };
}

/** Resolve the rule to add to: from the invoking tree node, else a QuickPick. */
async function resolveTargetRule(mirror: string, arg: unknown): Promise<TargetRule | undefined> {
  const fromNode = ruleFromArg(mirror, arg);
  if (fromNode) return fromNode;

  const rulesAbs = path.join(mirror, 'rules');
  const entries = fs.existsSync(rulesAbs)
    ? fs.readdirSync(rulesAbs).sort().filter((e) => {
        try { return fs.statSync(path.join(rulesAbs, e)).isDirectory(); } catch { return false; }
      })
    : [];
  if (entries.length === 0) {
    vscode.window.showInformationMessage('Adobe Launch: no rules yet — create one with "New rule…".');
    return undefined;
  }
  interface Item extends vscode.QuickPickItem { rule: TargetRule; }
  const items: Item[] = entries.map((entry) => {
    const dirAbs = path.join(rulesAbs, entry);
    const info = readRuleInfo(dirAbs, entry);
    return { label: `$(symbol-event) ${info.name}`, description: info.id, rule: { ...info, dirAbs } };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Add a component to which rule?',
    matchOnDescription: true,
    placeHolder: 'Pick a rule',
  });
  return picked?.rule;
}

/**
 * Pick a delegate for a kind, or enter one by hand.
 *
 * Web offers the Core catalog. Mobile and edge have no Core extension — what
 * exists depends on the installed extensions — so they offer the delegates this
 * property's rules already use, which is the closest thing to a catalog we have.
 */
async function pickDelegate(
  kind: ComponentKind,
  platform: PropertyPlatform,
  mirror: string
): Promise<{ delegateId: string; label: string } | undefined> {
  interface Item extends vscode.QuickPickItem { delegateId?: string; custom?: boolean; }
  const items: Item[] = supportsCoreCustomCode(platform)
    ? DELEGATE_CATALOG[kind].map((d) => ({
        label: d.label,
        description: d.delegateId,
        delegateId: d.delegateId,
      }))
    : delegatesInUse(mirror, kind).map((u) => ({
        label: delegateLabel(u.delegateId),
        description: u.delegateId,
        detail: `Used by ${u.count} ${u.count === 1 ? 'component' : 'components'}` +
          (u.example ? `, e.g. "${u.example}"` : ''),
        delegateId: u.delegateId,
      }));
  items.push({ label: '$(edit) Enter delegate id…', description: 'advanced', custom: true });

  // Nothing to choose from (a brand-new mobile property): skip straight to typing one.
  const picked =
    items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, {
          title: `Pick a ${KIND_LABELS[kind].toLowerCase()}`,
          matchOnDescription: true,
          placeHolder: supportsCoreCustomCode(platform)
            ? 'Choose a delegate'
            : `Delegates already used in this ${platform} property`,
        });
  if (!picked) return undefined;
  if (picked.custom) {
    const entered = await vscode.window.showInputBox({
      title: `Enter a ${kind} delegate id`,
      prompt: supportsCoreCustomCode(platform)
        ? `e.g. adobe-analytics::${kind}::…`
        : `"<extension name>::${kind}::<delegate>" — the extension must be installed in this property`,
      validateInput: (v) =>
        isWellFormedDelegateId(v.trim(), kind) ? undefined : `Expected "<ns>::${kind}::<name>".`,
    });
    if (!entered) return undefined;
    const id = entered.trim();
    return { delegateId: id, label: id.split('::').pop() || id };
  }
  return {
    delegateId: picked.delegateId!,
    label: supportsCoreCustomCode(platform) ? picked.label : delegateLabel(picked.delegateId!),
  };
}

/**
 * Copy what an app or a site needs to load an environment's library: the App ID
 * (plus a MobileCore init line) for mobile, the embed code for web. Read live,
 * since an environment only has a library path once a host is assigned.
 */
async function copyEnvironmentId(config: Config, logChannel: vscode.OutputChannel): Promise<void> {
  const client = await ensureClient(config, logChannel); if (!client) return;
  const pid = config.activePropertyId();
  if (!pid) { await vscode.commands.executeCommand('adobeLaunch.setProperty'); return; }

  let platform: PropertyPlatform;
  let envs;
  try {
    [platform, envs] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading environments…' },
      async () => {
        const prop = await client.get<{ data: { attributes?: { platform?: string } } }>(`/properties/${pid}`);
        const list = await client.paged<{ id: string; attributes?: any }>(`/properties/${pid}/environments`);
        return [platformOf(prop?.data?.attributes?.platform), sortEnvironments(list.map(toEnvironmentInfo))] as const;
      }
    );
  } catch (err) {
    await showError('Adobe Launch: could not list environments', err);
    return;
  }
  if (platform === 'edge') {
    vscode.window.showInformationMessage(
      'Adobe Launch: edge properties run on the Edge Network — there is no App ID or embed code to copy.'
    );
    return;
  }
  if (envs.length === 0) {
    vscode.window.showInformationMessage('Adobe Launch: this property has no environments yet.');
    return;
  }

  const envPick = await vscode.window.showQuickPick(
    envs.map((e) => ({
      label: e.name,
      description: e.stage,
      detail: e.fileId ?? 'No library path yet — assign a host to this environment first.',
      env: e,
    })),
    {
      title: platform === 'mobile' ? 'Copy the App ID for which environment?' : 'Copy the embed code for which environment?',
      matchOnDescription: true,
    }
  );
  if (!envPick) return;
  const fileId = envPick.env.fileId;
  if (!fileId) {
    vscode.window.showErrorMessage(
      `Adobe Launch: "${envPick.label}" has no library path yet. Assign it a host in the Launch UI, then try again.`
    );
    return;
  }

  const options = environmentCopyOptions(platform, fileId);
  const fmt = await vscode.window.showQuickPick(
    options.map((o) => ({ label: o.label, detail: o.text, text: o.text })),
    { title: `Copy ${envPick.label} as…` }
  );
  if (!fmt) return;
  await vscode.env.clipboard.writeText(fmt.text);
  vscode.window.showInformationMessage(`Adobe Launch: copied ${fmt.label} for ${envPick.label}.`);
}

interface SearchItem extends vscode.QuickPickItem {
  path?: string;
}

function parseQuery(raw: string): { text: string; kind?: string; delegate?: string } {
  let kind: string | undefined;
  let delegate: string | undefined;
  const words: string[] = [];
  for (const tok of raw.trim().split(/\s+/)) {
    const mk = tok.match(/^kind:(events|conditions|actions)$/i);
    const md = tok.match(/^delegate:(.+)$/i);
    if (mk) { kind = mk[1].toLowerCase(); continue; }
    if (md) { delegate = md[1].toLowerCase(); continue; }
    if (tok) words.push(tok);
  }
  return { text: words.join(' ').toLowerCase(), kind, delegate };
}

function safeRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function snippet(needle: string, hay: string): string | undefined {
  if (!needle || !hay) return undefined;
  const i = hay.toLowerCase().indexOf(needle);
  if (i < 0) return undefined;
  const start = Math.max(0, i - 30);
  const s = hay.slice(start, i + needle.length + 30).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + '…';
}

/** Content-aware search over the local mirror: rule components + data elements. */
function searchMirror(mirror: string, rawQuery: string): SearchItem[] {
  const q = parseQuery(rawQuery);
  const out: SearchItem[] = [];

  const matchText = (name: string, jsonText: string, jsSrc: string): { ok: boolean; inCode: boolean } => {
    if (!q.text) return { ok: true, inCode: false };
    const inName = name.toLowerCase().includes(q.text);
    const inJson = jsonText.toLowerCase().includes(q.text);
    const inJs = jsSrc.toLowerCase().includes(q.text);
    return { ok: inName || inJson || inJs, inCode: inJs && !inName };
  };

  // Rule components.
  const rulesAbs = path.join(mirror, 'rules');
  if (fs.existsSync(rulesAbs)) {
    for (const ruleEntry of fs.readdirSync(rulesAbs).sort()) {
      const compsDir = path.join(rulesAbs, ruleEntry, 'components');
      if (!fs.existsSync(compsDir)) continue;
      const ruleName = stripId(ruleEntry);
      const stems = new Map<string, { js?: string; json?: string }>();
      for (const file of fs.readdirSync(compsDir)) {
        if (!/\.(js|json)$/.test(file)) continue;
        const stem = file.replace(/\.(js|json)$/, '');
        const b = stems.get(stem) ?? {};
        if (file.endsWith('.js')) b.js = file; else b.json = file;
        stems.set(stem, b);
      }
      for (const [stem, b] of stems) {
        if (!b.json) continue;
        const jsonPath = path.join(compsDir, b.json);
        let attrs: any = {};
        try { attrs = JSON.parse(safeRead(jsonPath)).attributes ?? {}; } catch { /* skip */ }
        const delegateId: string = attrs.delegate_descriptor_id ?? '';
        const kind = kindOf(delegateId);
        if (q.kind && kind !== q.kind) continue;
        if (q.delegate && !delegateId.toLowerCase().includes(q.delegate)) continue;
        const name: string = attrs.name ?? stem;
        const jsonText = safeRead(jsonPath);
        const jsSrc = b.js ? safeRead(path.join(compsDir, b.js)) : '';
        const m = matchText(name, jsonText, jsSrc);
        if (!m.ok) continue;
        out.push({
          label: `${ruleName} › ${name}`,
          description: `${kind}${delegateId ? ' · ' + delegateId : ''}`,
          detail: snippet(q.text, jsSrc || jsonText),
          path: m.inCode && b.js ? path.join(compsDir, b.js) : jsonPath,
        });
      }
    }
  }

  // Data elements (never events/conditions/actions, so skip when kind: is set).
  const deAbs = path.join(mirror, 'data_elements');
  if (fs.existsSync(deAbs) && !q.kind) {
    for (const entry of fs.readdirSync(deAbs).sort()) {
      const dir = path.join(deAbs, entry);
      const jsonPath = path.join(dir, 'data_element.json');
      if (!fs.existsSync(jsonPath)) continue;
      let attrs: any = {};
      try { attrs = JSON.parse(safeRead(jsonPath)).attributes ?? {}; } catch { /* skip */ }
      const delegateId: string = attrs.delegate_descriptor_id ?? '';
      if (q.delegate && !delegateId.toLowerCase().includes(q.delegate)) continue;
      const name: string = attrs.name ?? stripId(entry);
      const jsPath = path.join(dir, 'settings.js');
      const jsSrc = fs.existsSync(jsPath) ? safeRead(jsPath) : '';
      const jsonText = safeRead(jsonPath);
      const m = matchText(name, jsonText, jsSrc);
      if (!m.ok) continue;
      out.push({
        label: name,
        description: `data element${delegateId ? ' · ' + delegateId : ''}`,
        detail: snippet(q.text, jsSrc || jsonText),
        path: m.inCode && fs.existsSync(jsPath) ? jsPath : jsonPath,
      });
    }
  }

  return out;
}
