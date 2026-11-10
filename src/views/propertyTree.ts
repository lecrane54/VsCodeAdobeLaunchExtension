/**
 * The three sidebar trees: Changes, Property, and Library.
 *
 * They share one Node shape and one base class; each supplies its own roots.
 * `resolveState()` drives the `adobeLaunch.state` context key, which in turn
 * picks the welcome content each view shows while set-up is incomplete.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Config } from '../config';
import { Manifest } from '../local/manifest';
import { detectChanges, Change } from '../local/push';
import { ChangeRef } from '../diff/changeDiff';
import { ChangeSelection } from './changeSelection';
import { ComponentKind } from '../reactor/delegates';
import { relativeTime } from '../util/format';
import { readPropertyInfo } from '../local/layout';
import { ReactorClient } from '../reactor/client';
import { PropertyPlatform, platformOf } from '../reactor/platform';
import {
  getLibrary,
  listLibraryResources,
  listRuleComponents,
  LibraryDetail,
  LibraryResource,
} from '../reactor/library';

interface Node {
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  path?: string;
  resourceUri?: vscode.Uri;
  resourceId?: string;
  icon?: string;
  iconColor?: string;
  command?: vscode.Command;
  children?: Node[];
  /** Fetched from Reactor the first time the node is expanded; cached per id. */
  loadChildren?: () => Promise<Node[]>;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  change?: ChangeRef; // set on Unpushed-changes leaves so "compare" can diff vs Reactor
  /**
   * Change keys this row covers — its own on a leaf, every descendant's on a
   * group. Presence is what gives a row a checkbox.
   */
  changeKeys?: string[];
  /** Set on a Triggers/Conditions/Actions row so "add one here" knows where. */
  ruleDirAbs?: string;
  componentKind?: ComponentKind;
}

/** Drives the `viewsWelcome` buttons for each setup stage. */
type SetupState = 'signedOut' | 'noProperty' | 'notPulled' | 'ready';

/**
 * Directories are stored on disk as `<slug>__<resourceId>` for uniqueness.
 * Strip the trailing `__<id>` so the tree shows the human-readable name; the
 * id lives in the tooltip and the folder name is unchanged on disk.
 */
function displayName(dir: string): { label: string; id?: string } {
  // Ids are hex (`RL…`); also accept `-` so locally-created `new…` placeholders parse.
  const m = dir.match(/^(.*)__([A-Za-z0-9-]+)$/);
  if (m) return { label: m[1], id: m[2] };
  return { label: dir };
}

/** Which setup stage the user is at — drives every view's welcome content. */
export async function resolveState(config: Config): Promise<SetupState> {
  const creds = await config.credentials();
  if (!creds) return 'signedOut';
  if (!config.activePropertyId()) return 'noProperty';
  try {
    const mirror = path.join(config.mirrorRoot(), config.activePropertyId());
    return fs.existsSync(mirror) ? 'ready' : 'notPulled';
  } catch {
    // No folder open — nothing to mirror. Treat as "not pulled" so the
    // Pull button (which prompts to open/pick) is offered.
    return 'notPulled';
  }
}

/** Absolute path of the active property's mirror, or undefined if unusable. */
function mirrorDir(config: Config): string | undefined {
  const pid = config.activePropertyId();
  if (!pid) return undefined;
  try {
    const dir = path.join(config.mirrorRoot(), pid);
    return fs.existsSync(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Shared plumbing: node → TreeItem, lazy children, and the redraw event. */
abstract class BaseTreeProvider implements vscode.TreeDataProvider<Node> {
  protected readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  /** Redraw from local state. Cheap — safe to call on every keystroke. */
  refresh(): void {
    this._onDidChange.fire();
  }

  /** Redraw, discarding anything cached from Reactor. */
  reload(): void {
    this._onDidChange.fire();
  }

  protected abstract rootNodes(): Promise<Node[]>;

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return this.rootNodes();
    if (!node.loadChildren) return node.children ?? [];
    try {
      return await node.loadChildren();
    } catch (err) {
      return [errorNode(err)];
    }
  }

  /** Set by the Changes view; other trees have no checkboxes. */
  protected selection?: ChangeSelection;

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.collapsibleState ?? vscode.TreeItemCollapsibleState.None
    );
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    if (this.selection && node.changeKeys?.length) {
      item.checkboxState = this.selection.allSelected(node.changeKeys)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(
        node.icon,
        node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined
      );
    }

    const isFile = node.path ? safeIsFile(node.path) : false;
    // resourceUri drives file decorations; prefer the explicit folder uri so the
    // "modified" badge lands on the resource's row.
    if (node.resourceUri) item.resourceUri = node.resourceUri;
    else if (isFile) item.resourceUri = vscode.Uri.file(node.path!);

    // Any node backed by a concrete file opens it on click.
    if (isFile) {
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(node.path!)],
      };
    }
    // An explicit command (e.g. the library picker) wins.
    if (node.command) item.command = node.command;
    return item;
  }
}

/**
 * "Changes" view — every locally-modified resource, grouped under its parent
 * rule. Empty (so the welcome content shows) when the mirror is in sync.
 */
export class ChangesTreeProvider extends BaseTreeProvider {
  constructor(private readonly config: Config, selection: ChangeSelection) {
    super();
    this.selection = selection;
  }

  /** How many changes the mirror currently has — drives the view badge. */
  count(): number {
    return countChanges(this.config);
  }

  /** The changes on disk right now, with stale selection state pruned. */
  currentChanges(): Change[] {
    const mirror = mirrorDir(this.config);
    if (!mirror) return [];
    try {
      const changes = detectChanges(mirror, Manifest.load(mirror));
      this.selection!.prune(changes);
      return changes;
    } catch {
      return [];
    }
  }

  protected async rootNodes(): Promise<Node[]> {
    const mirror = mirrorDir(this.config);
    if (!mirror) return [];
    let section: Node | null;
    try {
      section = changesSection(mirror, Manifest.load(mirror));
    } catch {
      return [];
    }
    // The section's own children are this view's roots — the view title
    // already says "Changes", so the wrapper row would just be noise.
    const children = section?.children ?? [];
    if (children.length === 0) return [];
    return [this.pushActionNode(), ...children];
  }

  /**
   * The push affordance, pinned above the changes as a full-width row.
   *
   * A TreeView can't host a real button — `viewsWelcome` renders one, but only
   * while the tree is empty, which is exactly when there is nothing to push. A
   * row is the widest clickable target the API allows, and unlike a toolbar
   * icon it can say what it will do and where it will go.
   */
  private pushActionNode(): Node {
    const changes = this.currentChanges();
    const total = changes.length;
    const picked = this.selection!.filter(changes).length;
    const libraryId = this.config.activeLibraryId();
    const library = this.config.activeLibraryName() || (libraryId ? 'active library' : '');

    if (!library) {
      return {
        label: 'Set an active library to push',
        description: 'required',
        icon: 'warning',
        iconColor: 'list.warningForeground',
        tooltip: new vscode.MarkdownString(
          'Pushing always goes into a library. Pick one and this becomes the push button.'
        ),
        contextValue: 'adobeLaunch.pushAction',
        command: { command: 'adobeLaunch.setLibrary', title: 'Set active library' },
      };
    }

    if (picked === 0) {
      return {
        label: 'Nothing ticked to push',
        description: `${total} change${total === 1 ? '' : 's'} below`,
        icon: 'circle-slash',
        iconColor: 'disabledForeground',
        tooltip: new vscode.MarkdownString('Tick at least one change to push it.'),
        contextValue: 'adobeLaunch.pushAction',
      };
    }

    const count =
      picked === total
        ? `${total} change${total === 1 ? '' : 's'}`
        : `${picked} of ${total} changes`;
    const tip = new vscode.MarkdownString(`Push **${count}** into **${library}**`);
    tip.appendMarkdown('\n\nEach one is revised into the library, then you can build.');
    return {
      label: `Push ${count}`,
      description: `→ ${library}`,
      icon: 'cloud-upload',
      iconColor: 'charts.blue',
      tooltip: tip,
      contextValue: 'adobeLaunch.pushAction',
      command: { command: 'adobeLaunch.pushToLibrary', title: 'Push to active library' },
    };
  }
}

/**
 * "Property" view — the pulled mirror: rules, data elements, extensions.
 */
export class PropertyTreeProvider extends BaseTreeProvider {
  constructor(private readonly config: Config) {
    super();
  }

  protected async rootNodes(): Promise<Node[]> {
    const mirror = mirrorDir(this.config);
    if (!mirror) return [];
    const manifest = Manifest.load(mirror);
    const counts = countByKind(manifest);
    return [
      propertyNode(mirror, this.config.activePropertyId(), manifest.data.pulled_at),
      rulesSection(mirror, counts.rule),
      flatSection(mirror, 'data_elements', 'Data Elements', counts.data_element, 'data_element'),
      flatSection(mirror, 'extensions', 'Extensions', counts.extension, 'extension'),
    ];
  }
}

/**
 * "Library" view — what the chosen library actually contains, fetched from
 * Reactor on first expand and cached until `reload()`.
 */
export class LibraryTreeProvider extends BaseTreeProvider {
  /** Reactor responses, keyed by library/revision id. */
  private readonly remoteCache = new Map<string, Node[]>();

  constructor(
    private readonly config: Config,
    private readonly clientFactory: () => Promise<ReactorClient | undefined>
  ) {
    super();
  }

  override reload(): void {
    this.remoteCache.clear();
    this._onDidChange.fire();
  }

  /** Fetch once per id; a failure isn't cached so expanding again retries. */
  private async cached(key: string, load: () => Promise<Node[]>): Promise<Node[]> {
    const hit = this.remoteCache.get(key);
    if (hit) return hit;
    const nodes = await load();
    this.remoteCache.set(key, nodes);
    return nodes;
  }

  protected async rootNodes(): Promise<Node[]> {
    const id = this.config.activeLibraryId();
    // No library chosen → empty, so the "choose a library" welcome shows.
    if (!id) return [];
    return this.libraryChildren(id);
  }

  /** The library's own contents: a status row plus one section per resource type. */
  private libraryChildren(libraryId: string): Promise<Node[]> {
    return this.cached(`library:${libraryId}`, async () => {
      const client = await this.clientFactory();
      if (!client) {
        return [{ label: 'Sign in to load library contents', icon: 'warning', iconColor: 'list.warningForeground' }];
      }
      const [detail, rules, dataElements, extensions] = await Promise.all([
        getLibrary(client, libraryId),
        listLibraryResources(client, libraryId, 'rules'),
        listLibraryResources(client, libraryId, 'data_elements'),
        listLibraryResources(client, libraryId, 'extensions'),
      ]);

      // A library lists revisions, which are immutable on Reactor — but the
      // resource each one was cut from is sitting in the mirror, editable.
      // Hand every row its working file so the pane is a way in, not a dead end.
      const local = mirrorIndex(mirrorDir(this.config));

      const out: Node[] = [libraryStatusNode(detail)];
      if (rules.length) {
        out.push({
          label: 'Rules',
          description: `${rules.length}`,
          icon: 'list-tree',
          collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
          children: rules.map((r) => this.libraryRuleNode(r, local)),
        });
      }
      if (dataElements.length) {
        out.push({
          label: 'Data Elements',
          description: `${dataElements.length}`,
          icon: 'symbol-variable',
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          children: dataElements.map((d) => libraryResourceNode(d, 'symbol-variable', local)),
        });
      }
      if (extensions.length) {
        out.push({
          label: 'Extensions',
          description: `${extensions.length}`,
          icon: 'extensions',
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          children: extensions.map((e) => libraryResourceNode(e, 'package', local)),
        });
      }
      if (out.length === 1) {
        out.push({
          label: 'Nothing added to this library yet',
          description: 'push changes to it to populate',
          icon: 'info',
        });
      }
      return out;
    });
  }

  /** A rule revision in the library, expanding into its triggers/conditions/actions. */
  private libraryRuleNode(r: LibraryResource, local?: Map<string, string>): Node {
    const tip = new vscode.MarkdownString(`**${r.name}**${r.enabled === false ? ' · _disabled_' : ''}`);
    if (r.revisionNumber !== undefined) tip.appendMarkdown(`\n\nRevision ${r.revisionNumber}`);
    if (r.updatedAt) tip.appendMarkdown(`\n\nRevised ${relativeTime(r.updatedAt)}`);
    if (r.originId) tip.appendMarkdown(`\n\n\`${r.originId}\``);
    const working = localFileFor(r, local);
    appendEditHint(tip, working);
    return {
      label: r.name,
      description: revisionLabel(r),
      tooltip: tip,
      icon: r.enabled === false ? 'circle-slash' : 'symbol-event',
      iconColor: r.enabled === false ? 'disabledForeground' : undefined,
      // The origin id is what the mirror on disk is keyed by, so that's the useful one to copy.
      resourceId: r.originId ?? r.id,
      path: working,
      contextValue: working ? 'adobeLaunch.libResource.local' : 'adobeLaunch.libResource',
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      loadChildren: () => this.ruleComponentChildren(r.id),
    };
  }

  private ruleComponentChildren(ruleRevisionId: string): Promise<Node[]> {
    return this.cached(`rule:${ruleRevisionId}`, async () => {
      const client = await this.clientFactory();
      if (!client) return [];
      const comps = await listRuleComponents(client, ruleRevisionId);
      const groups: Node[] = [];
      for (const kind of ['events', 'conditions', 'actions'] as const) {
        const inKind = comps.filter((c) => c.kind === kind);
        if (!inKind.length) continue;
        const meta = kindMeta(kind);
        groups.push(
          componentGroup(
            kind === 'events' ? 'Triggers' : kind === 'conditions' ? 'Conditions' : 'Actions',
            meta.icon,
            inKind.map((c) => ({
              label: c.name,
              description: delegateShort(c.delegateDescriptorId),
              tooltip: c.delegateDescriptorId,
              icon: meta.icon,
              resourceId: c.id,
              contextValue: 'adobeLaunch.libResource',
            }))
          )
        );
      }
      return groups.length ? groups : [{ label: '(no components in this rule)' }];
    });
  }
}

/**
 * The active property's name for chrome that has room for one line — the view
 * header, the status bar. Falls back to the id when the mirror isn't pulled yet
 * (nothing on disk names it), and to undefined when no property is set.
 */
export function activePropertyLabel(config: Config): string | undefined {
  const pid = config.activePropertyId();
  if (!pid) return undefined;
  const mirror = mirrorDir(config);
  const info = mirror ? readPropertyInfo(mirror) : {};
  const name = info.name ?? pid;
  // Web is the default this extension grew up on; only call out the others.
  const platform = platformOf(info.platform);
  return platform === 'web' ? name : `${name} · ${platform}`;
}

/** The active mirror's platform; `web` when nothing is pulled yet. */
export function activePropertyPlatform(config: Config): PropertyPlatform {
  const mirror = mirrorDir(config);
  return platformOf(mirror ? readPropertyInfo(mirror).platform : undefined);
}

/** Unpushed change count for the active mirror; 0 when there's nothing to compare. */
export function countChanges(config: Config): number {
  const mirror = mirrorDir(config);
  if (!mirror) return 0;
  try {
    return detectChanges(mirror, Manifest.load(mirror)).length;
  } catch {
    return 0;
  }
}

/**
 * Top-of-tree row for the property. Labelled with the property's real name so
 * the sidebar says which one you're editing — the id is 34 characters of hex and
 * tells nobody anything at a glance, so it moves to the tooltip.
 */
function propertyNode(mirror: string, pid: string, pulledAt?: string): Node {
  const rel = relativeTime(pulledAt);
  const info = readPropertyInfo(mirror);
  const tip = new vscode.MarkdownString(
    `**${info.name ?? 'Property'}**\n\n\`${pid}\``
  );
  if (info.platform) tip.appendMarkdown(`\n\nPlatform: ${info.platform}`);
  if (info.domains?.length) tip.appendMarkdown(`\n\nDomains: ${info.domains.join(', ')}`);
  tip.appendMarkdown(
    `\n\nPulled ${rel}` + (pulledAt ? ` — ${new Date(pulledAt).toLocaleString()}` : '')
  );
  tip.appendMarkdown('\n\nClick to switch property.');
  return {
    label: info.name ?? 'Property',
    description: `pulled ${rel}`,
    tooltip: tip,
    icon: 'cloud',
    contextValue: 'adobeLaunch.property',
    command: { command: 'adobeLaunch.setProperty', title: 'Set active property' },
  };
}

/** State + build health of the library, as the first row under it. */
function libraryStatusNode(detail: LibraryDetail): Node {
  const tip = new vscode.MarkdownString(`**State** ${detail.state}`);
  tip.appendMarkdown(
    detail.buildRequired
      ? '\n\nChanges have been added since the last build.'
      : '\n\nNo build needed — the library is up to date.'
  );
  if (detail.updatedAt) {
    tip.appendMarkdown(
      `\n\nUpdated ${relativeTime(detail.updatedAt)}` + (detail.updatedBy ? ` by ${detail.updatedBy}` : '')
    );
  }
  return {
    label: detail.state,
    description: detail.buildRequired ? 'build required' : `updated ${relativeTime(detail.updatedAt)}`,
    tooltip: tip,
    icon: detail.buildRequired ? 'warning' : 'check',
    iconColor: detail.buildRequired ? 'list.warningForeground' : 'testing.iconPassed',
  };
}

/** A data element / extension revision inside the library. */
function libraryResourceNode(r: LibraryResource, icon: string, local?: Map<string, string>): Node {
  const tip = new vscode.MarkdownString(`**${r.name}**${r.enabled === false ? ' · _disabled_' : ''}`);
  if (r.version) tip.appendMarkdown(`\n\nVersion ${r.version}`);
  const type = delegateShort(r.delegateDescriptorId);
  if (type) tip.appendMarkdown(`\n\nType: ${type}`);
  if (r.revisionNumber !== undefined) tip.appendMarkdown(`\n\nRevision ${r.revisionNumber}`);
  if (r.updatedAt) tip.appendMarkdown(`\n\nRevised ${relativeTime(r.updatedAt)}`);
  if (r.originId) tip.appendMarkdown(`\n\n\`${r.originId}\``);
  const working = localFileFor(r, local);
  appendEditHint(tip, working);
  return {
    label: r.name,
    description: r.version ? `v${r.version}` : revisionLabel(r),
    tooltip: tip,
    icon: r.enabled === false ? 'circle-slash' : icon,
    iconColor: r.enabled === false ? 'disabledForeground' : undefined,
    resourceId: r.originId ?? r.id,
    path: working,
    contextValue: working ? 'adobeLaunch.libResource.local' : 'adobeLaunch.libResource',
  };
}

/** `rev 4 · disabled` */
function revisionLabel(r: LibraryResource): string {
  const rev = r.revisionNumber !== undefined ? `rev ${r.revisionNumber}` : '';
  return rev + (r.enabled === false ? `${rev ? ' · ' : ''}disabled` : '');
}

/**
 * Every resource in the mirror, keyed by its Reactor id, pointing at the file
 * you would edit. Built once per library load — the manifest is one read, and
 * resolving each row separately would re-read it for all of them.
 */
function mirrorIndex(mirror: string | undefined): Map<string, string> | undefined {
  if (!mirror) return undefined;
  let manifest: Manifest;
  try {
    manifest = Manifest.load(mirror);
  } catch {
    return undefined;
  }
  const out = new Map<string, string>();
  for (const entry of Object.values(manifest.data.resources)) {
    const abs = path.join(mirror, entry.path);
    // A component's manifest path is already its .json; the others are folders.
    out.set(
      entry.id,
      entry.kind === 'rule' ? path.join(abs, 'rule.json')
        : entry.kind === 'data_element' ? path.join(abs, 'data_element.json')
          : entry.kind === 'extension' ? path.join(abs, 'extension.json')
            : abs
    );
  }
  return out;
}

/**
 * The working file behind a library row, found through the revision's origin —
 * the revision id itself is not in the mirror, only the resource it was cut from.
 */
function localFileFor(r: LibraryResource, local?: Map<string, string>): string | undefined {
  const file = local?.get(r.originId ?? r.id);
  return file && safeIsFile(file) ? file : undefined;
}

/** Say whether the row is a way into the mirror, since the icon can't. */
function appendEditHint(tip: vscode.MarkdownString, working?: string): void {
  tip.appendMarkdown(
    working
      ? '\n\nClick to edit the local copy. Revisions themselves are frozen — edit, push, then revise into the library.'
      : '\n\nNot in the local mirror. Pull the property to edit this.'
  );
}

function errorNode(err: unknown): Node {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    label: 'Could not load from Reactor',
    description: msg.slice(0, 120),
    tooltip: msg,
    icon: 'error',
    iconColor: 'list.errorForeground',
  };
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function countByKind(m: Manifest): Record<string, number> {
  const c: Record<string, number> = { rule: 0, rule_component: 0, data_element: 0, extension: 0 };
  for (const r of Object.values(m.data.resources)) c[r.kind] = (c[r.kind] ?? 0) + 1;
  return c;
}

/** Trigger/condition/action display label + icon for a component kind. */
function kindMeta(kind: string): { label: string; icon: string } {
  if (kind === 'events') return { label: 'trigger', icon: 'symbol-event' };
  if (kind === 'conditions') return { label: 'condition', icon: 'filter' };
  if (kind === 'actions') return { label: 'action', icon: 'play' };
  return { label: kind, icon: 'circle-small-filled' };
}

/**
 * Top-of-tree "Unpushed changes" section: every locally-modified resource,
 * grouped under its parent rule so a rule's changed triggers/conditions/actions
 * sit together. Returns null when the mirror is in sync. Each leaf opens the
 * right editor — the config form for config components, the file for JS/others.
 */
function changesSection(mirror: string, manifest: Manifest): Node | null {
  let changes: Change[];
  try {
    changes = detectChanges(mirror, manifest);
  } catch {
    return null;
  }
  if (changes.length === 0) return null;

  interface RuleGroup { name: string; ruleDir: string; comps: Node[]; ruleChange?: Change }
  const ruleGroups = new Map<string, RuleGroup>();
  const deNodes: Node[] = [];
  const extNodes: Node[] = [];

  const groupFor = (ruleDir: string): RuleGroup => {
    let g = ruleGroups.get(ruleDir);
    if (!g) {
      g = { name: displayName(path.basename(ruleDir)).label, ruleDir, comps: [] };
      ruleGroups.set(ruleDir, g);
    }
    return g;
  };

  for (const c of changes) {
    if (c.kind === 'rule_component') {
      const ruleDir = path.dirname(path.dirname(c.jsonPath)); // …/<rule>/components/<f>.json
      const stem = path.basename(c.jsonPath).replace(/\.json$/, '');
      const m = stem.match(/^\d+-([a-z0-9]+)-(.*)$/i);
      const meta = kindMeta(m ? m[1] : 'component');
      const name = (m ? m[2] : stem) || '(unnamed)';
      const node: Node = c.jsPath
        ? { label: name, description: meta.label, icon: meta.icon, path: c.jsPath, contextValue: 'adobeLaunch.file.changed', change: changeRef(c), changeKeys: [c.key] }
        : {
            label: name,
            description: meta.label,
            icon: meta.icon,
            path: c.jsonPath,
            contextValue: 'adobeLaunch.config.changed',
            change: changeRef(c),
            changeKeys: [c.key],
            command: { command: 'adobeLaunch.editComponentConfig', title: 'Edit config', arguments: [c.jsonPath] },
          };
      groupFor(ruleDir).comps.push(node);
    } else if (c.kind === 'rule') {
      groupFor(path.dirname(c.jsonPath)).ruleChange = c;
    } else if (c.kind === 'data_element') {
      deNodes.push(resourceChangeNode(c, 'data element', 'symbol-variable'));
    } else if (c.kind === 'extension') {
      extNodes.push(resourceChangeNode(c, 'extension', 'package'));
    }
  }

  const children: Node[] = [];
  for (const ruleDir of [...ruleGroups.keys()].sort()) {
    const g = ruleGroups.get(ruleDir)!;
    const comps = g.comps.sort((a, b) => a.label.localeCompare(b.label));
    if (g.ruleChange) {
      comps.unshift({
        label: 'rule settings',
        description: 'name / enabled',
        icon: 'gear',
        path: path.join(g.ruleDir, 'rule.json'),
        contextValue: 'adobeLaunch.file.changed',
        change: changeRef(g.ruleChange),
        changeKeys: [g.ruleChange.key],
      });
    }
    children.push({
      label: g.name,
      description: `${comps.length}`,
      icon: 'symbol-event',
      resourceUri: vscode.Uri.file(g.ruleDir),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children: comps,
      changeKeys: keysOf(comps),
    });
  }
  if (deNodes.length) {
    children.push({
      label: 'Data Elements', description: `${deNodes.length}`, icon: 'symbol-variable',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded, children: deNodes,
      changeKeys: keysOf(deNodes),
    });
  }
  if (extNodes.length) {
    children.push({
      label: 'Extensions', description: `${extNodes.length}`, icon: 'package',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded, children: extNodes,
      changeKeys: keysOf(extNodes),
    });
  }

  return {
    label: 'Unpushed changes',
    description: `${changes.length}`,
    tooltip: `${changes.length} local change(s) not yet pushed to Reactor.`,
    icon: 'cloud-upload',
    iconColor: 'gitDecoration.modifiedResourceForeground',
    contextValue: 'adobeLaunch.changesRoot',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    children,
  };
}

/** A changed data element / extension leaf, opening its JS if present else its JSON. */
function resourceChangeNode(c: Change, kindLabel: string, icon: string): Node {
  const dir = path.dirname(c.jsonPath);
  return {
    label: displayName(path.basename(dir)).label,
    description: kindLabel,
    icon,
    path: c.jsPath ?? c.jsonPath,
    resourceUri: vscode.Uri.file(dir),
    contextValue: 'adobeLaunch.file.changed',
    change: changeRef(c),
    changeKeys: [c.key],
  };
}

/** Every change key under a set of rows, for a group row's own checkbox. */
function keysOf(nodes: readonly Node[]): string[] {
  return nodes.flatMap((n) => n.changeKeys ?? []);
}

/** Distill a detected Change into the metadata the diff command needs. */
function changeRef(c: Change): ChangeRef {
  return { kind: c.kind, resourceId: c.resourceId, jsonPath: c.jsonPath, jsPath: c.jsPath, reason: c.reason };
}

/** Rules → only actions (as .js when available, .json fallback). */
function rulesSection(mirrorRoot: string, n: number): Node {
  const abs = path.join(mirrorRoot, 'rules');
  if (!fs.existsSync(abs)) return { label: 'Rules', description: '(none)', icon: 'list-tree' };
  const ruleDirs = fs.readdirSync(abs).sort();
  const children: Node[] = ruleDirs.map((entry) => {
    const ruleAbs = path.join(abs, entry);
    const { label, id } = displayName(entry);
    const attrs = readAttrs(path.join(ruleAbs, 'rule.json'));
    const enabled = attrs?.enabled !== false;
    const summary = summarizeRuleComponents(ruleAbs);
    const desc =
      (summary.actions
        ? `${summary.actions} action${summary.actions === 1 ? '' : 's'}`
        : 'no actions') + (enabled ? '' : ' · disabled');

    const tip = new vscode.MarkdownString(`**${attrs?.name ?? label}**${enabled ? '' : ' · _disabled_'}`);
    if (summary.events.length) tip.appendMarkdown(`\n\nEvent: ${summary.events.join(', ')}`);
    tip.appendMarkdown(`\n\n${summary.conditions} condition${summary.conditions === 1 ? '' : 's'} · ${summary.actions} action${summary.actions === 1 ? '' : 's'}`);
    if (id) tip.appendMarkdown(`\n\n\`${id}\``);

    // Group the rule's components into Triggers / Conditions / Actions.
    // All three are always shown, even when empty: the group row is where you
    // right-click to add one, so hiding it would make the first condition of a
    // rule unreachable from the tree.
    const groups: Node[] = [
      componentGroup('Triggers', 'symbol-event', ruleComponentNodes(ruleAbs, 'events'), ruleAbs, 'events'),
      componentGroup('Conditions', 'filter', ruleComponentNodes(ruleAbs, 'conditions'), ruleAbs, 'conditions'),
      componentGroup('Actions', 'play', ruleComponentNodes(ruleAbs, 'actions'), ruleAbs, 'actions'),
    ];

    return {
      label,
      tooltip: tip,
      description: desc,
      resourceUri: vscode.Uri.file(ruleAbs),
      resourceId: id,
      icon: enabled ? 'symbol-event' : 'circle-slash',
      iconColor: enabled ? undefined : 'disabledForeground',
      contextValue: id ? 'adobeLaunch.rule' : undefined,
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: groups,
    };
  });
  return {
    label: 'Rules',
    description: `${n}`,
    icon: 'list-tree',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    children,
  };
}

/**
 * A collapsible section (Triggers / Conditions / Actions) under a rule, and the
 * right-click target for adding a component of that kind. An empty one is a
 * plain row rather than a collapsible with nothing inside it.
 */
function componentGroup(
  label: string,
  icon: string,
  children: Node[],
  /**
   * The local rule folder this group belongs to. Omitted by the Library view,
   * which renders immutable revisions fetched from Reactor — there is nothing
   * local to add to, so those rows get no add menu.
   */
  ruleDirAbs?: string,
  kind?: ComponentKind
): Node {
  return {
    label,
    description: `${children.length}`,
    icon,
    collapsibleState: children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    children,
    ...(ruleDirAbs && kind
      ? { contextValue: `adobeLaunch.componentGroup.${kind}`, ruleDirAbs, componentKind: kind }
      : {}),
  };
}

/**
 * Return one node per component of the given kind (events/conditions/actions),
 * grouping a `.js` + `.json` pair into a single item.
 * - JS components open the `.js` file as code (unchanged behavior).
 * - Config components (no `.js`) open the settings form webview on click.
 */
function ruleComponentNodes(
  ruleDir: string,
  kind: 'events' | 'conditions' | 'actions'
): Node[] {
  const compsDir = path.join(ruleDir, 'components');
  if (!fs.existsSync(compsDir)) return [];
  const prefix = new RegExp(`^\\d+-${kind}-`);
  const byStem = new Map<string, { js?: string; json?: string }>();
  for (const file of fs.readdirSync(compsDir)) {
    if (!prefix.test(file)) continue;
    const stem = file.replace(/\.(js|json)$/, '');
    const bucket = byStem.get(stem) ?? {};
    if (file.endsWith('.js')) bucket.js = file;
    else if (file.endsWith('.json')) bucket.json = file;
    byStem.set(stem, bucket);
  }
  const nodes: Node[] = [];
  for (const stem of [...byStem.keys()].sort()) {
    const { js, json } = byStem.get(stem)!;
    const label = stem.replace(prefix, '');
    if (js) {
      nodes.push({
        label,
        description: 'JavaScript',
        path: path.join(compsDir, js),
        contextValue: 'adobeLaunch.file',
      });
    } else if (json) {
      const jsonPath = path.join(compsDir, json);
      nodes.push({
        label,
        description: 'config',
        path: jsonPath,
        contextValue: 'adobeLaunch.config',
        command: {
          command: 'adobeLaunch.editComponentConfig',
          title: 'Edit config',
          arguments: [jsonPath],
        },
      });
    }
  }
  return nodes;
}

/** Flat "entry per folder" section for data elements / extensions. */
function flatSection(
  mirrorRoot: string,
  folder: string,
  label: string,
  n: number,
  kind: 'data_element' | 'extension'
): Node {
  const primaryFile = kind === 'data_element' ? 'data_element.json' : 'extension.json';
  const sectionIcon = kind === 'extension' ? 'extensions' : 'symbol-variable';
  const itemIcon = kind === 'extension' ? 'package' : 'symbol-variable';

  const abs = path.join(mirrorRoot, folder);
  if (!fs.existsSync(abs)) return { label, description: '(none)', icon: sectionIcon };
  const entries = fs.readdirSync(abs).sort();
  const children: Node[] = entries.map((entry) => {
    const dir = path.join(abs, entry);
    const primary = path.join(dir, primaryFile);
    const js = path.join(dir, 'settings.js');
    const hasJs = fs.existsSync(js);
    const target = hasJs ? js : primary;
    const { label: name, id } = displayName(entry);
    const attrs = readAttrs(primary);
    const enabled = attrs?.enabled !== false;
    const type = delegateShort(attrs?.delegate_descriptor_id);

    const tip = new vscode.MarkdownString(`**${attrs?.name ?? name}**${enabled ? '' : ' · _disabled_'}`);
    if (kind === 'extension' && attrs?.version) tip.appendMarkdown(`\n\nVersion ${attrs.version}`);
    if (type) tip.appendMarkdown(`\n\nType: ${type}`);
    if (kind === 'data_element' && attrs?.storage_duration) {
      tip.appendMarkdown(`\n\nStorage: ${attrs.storage_duration}`);
    }
    if (id) tip.appendMarkdown(`\n\n\`${id}\``);

    return {
      label: name,
      tooltip: tip,
      description: (hasJs ? 'JavaScript' : 'config') + (enabled ? '' : ' · disabled'),
      path: fs.existsSync(target) ? target : undefined,
      resourceUri: vscode.Uri.file(dir),
      resourceId: id,
      icon: enabled ? itemIcon : 'circle-slash',
      iconColor: enabled ? undefined : 'disabledForeground',
      contextValue: id ? 'adobeLaunch.resource' : undefined,
    };
  });
  return {
    label,
    description: `${n}`,
    icon: sectionIcon,
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    children,
  };
}

/** Read the `attributes` object from a pulled resource JSON, if present. */
function readAttrs(jsonPath: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    return parsed?.attributes ?? undefined;
  } catch {
    return undefined;
  }
}

/** Last segment of a delegate id, e.g. `core::dataElements::javascript-variable` → `javascript-variable`. */
function delegateShort(delegateId?: string): string | undefined {
  if (!delegateId) return undefined;
  const parts = delegateId.split('::');
  return parts[parts.length - 1] || undefined;
}

/**
 * Count a rule's components by kind and collect event names — read from the
 * component filenames (`<order>-<kind>-<name>`), so no JSON parsing needed.
 */
function summarizeRuleComponents(ruleDir: string): {
  events: string[];
  conditions: number;
  actions: number;
} {
  const compsDir = path.join(ruleDir, 'components');
  const out = { events: [] as string[], conditions: 0, actions: 0 };
  if (!fs.existsSync(compsDir)) return out;
  const stems = new Set<string>();
  for (const file of fs.readdirSync(compsDir)) {
    stems.add(file.replace(/\.(js|json)$/, ''));
  }
  for (const stem of stems) {
    const m = stem.match(/^\d+-([a-z0-9]+)-(.*)$/i);
    if (!m) continue;
    const [, kind, name] = m;
    if (kind === 'events') out.events.push(name);
    else if (kind === 'conditions') out.conditions++;
    else if (kind === 'actions') out.actions++;
  }
  return out;
}
