/** Adobe Launch extension entry point. */

import * as fs from 'fs';
import * as vscode from 'vscode';

import { Config } from './config';
import { registerCommands, createClient } from './commands/commands';
import { ChangeSelection } from './views/changeSelection';
import {
  ChangesTreeProvider,
  PropertyTreeProvider,
  LibraryTreeProvider,
  countChanges,
  resolveState,
  activePropertyLabel,
} from './views/propertyTree';
import { ChangeCounter } from './status/changeCounter';
import { ChangeDecorationProvider } from './status/decorations';
import { SatelliteVarCompletionProvider } from './completion/satelliteGetVar';
import { SatelliteVarDiagnostics } from './completion/satelliteVarDiagnostics';
import { registerChangeDiff } from './diff/changeDiff';

export function activate(context: vscode.ExtensionContext): void {
  const config = new Config(context);
  const output = vscode.window.createOutputChannel('Adobe Launch');
  context.subscriptions.push(output);

  // Three views in the Adobe Launch activity-bar container.
  const selection = new ChangeSelection();
  const changesTree = new ChangesTreeProvider(config, selection);
  const propertyTree = new PropertyTreeProvider(config);
  const libraryTree = new LibraryTreeProvider(config, () =>
    createClient(config, (m) => output.appendLine(m))
  );

  const changesView = vscode.window.createTreeView('adobeLaunchChanges', {
    treeDataProvider: changesTree,
    showCollapseAll: true,
  });
  const propertyView = vscode.window.createTreeView('adobeLaunchProperty', {
    treeDataProvider: propertyTree,
    showCollapseAll: true,
  });
  const libraryView = vscode.window.createTreeView('adobeLaunchLibrary', {
    treeDataProvider: libraryTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(changesView, propertyView, libraryView);

  // Ticking a row (or a whole group) narrows what the next push sends.
  context.subscriptions.push(
    changesView.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) {
        if (!node.changeKeys?.length) continue;
        selection.setSelected(node.changeKeys, state === vscode.TreeItemCheckboxState.Checked);
      }
      // Redraw so ancestor rows pick up the new all-or-nothing state.
      changesTree.refresh();
      updateChangesHeader();
    })
  );

  /**
   * Name the thing each view is showing, in the view header. Without this the
   * sidebar never says which property or library you're working in — the ids
   * are 34 characters of hex and live in tooltips.
   */
  const updateViewTitles = (): void => {
    propertyView.description = activePropertyLabel(config);
    libraryView.description = config.activeLibraryName() || undefined;
  };

  /**
   * Badge, header, and the "why is Push greyed out" line — all from one read of
   * the mirror, since this runs on every keystroke.
   *
   * The header names the push target: the button writes into the active
   * library, and before this the Changes panel never said which one.
   */
  const updateChangesHeader = (): void => {
    const changes = changesTree.currentChanges();
    const n = changes.length;
    changesView.badge = n
      ? { value: n, tooltip: `${n} unpushed change${n === 1 ? '' : 's'}` }
      : undefined;

    const library = config.activeLibraryName() || (config.activeLibraryId() ? 'active library' : '');
    if (n === 0) {
      changesView.description = undefined;
      changesView.message = undefined;
      return;
    }
    const picked = selection.filter(changes).length;
    const count = picked === n ? `${n}` : `${picked} of ${n}`;
    changesView.description = library ? `${count} → ${library}` : count;
    // The missing-library case is carried by the push row at the top of the
    // tree, which says the same thing and is clickable — no need to say it twice.
    changesView.message = undefined;
  };
  const updateBadge = updateChangesHeader;

  /** Context keys the welcome views switch on. */
  const syncContext = async (): Promise<void> => {
    await vscode.commands.executeCommand('setContext', 'adobeLaunch.state', await resolveState(config));
    await vscode.commands.executeCommand('setContext', 'adobeLaunch.hasChanges', countChanges(config) > 0);
    await vscode.commands.executeCommand('setContext', 'adobeLaunch.hasLibrary', !!config.activeLibraryId());
  };

  // Redraw from disk. Cheap — no network, safe on every keystroke.
  const softRefresh = (): void => {
    changesTree.refresh();
    propertyTree.refresh();
    libraryTree.refresh();
    updateBadge();
    updateViewTitles();
    void syncContext();
  };

  // Redraw and re-fetch the library from Reactor.
  const reloadTrees = (): void => {
    changesTree.reload();
    propertyTree.reload();
    libraryTree.reload();
    updateBadge();
    updateViewTitles();
    void syncContext();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('adobeLaunch.refreshTree', () => reloadTrees()),
    vscode.commands.registerCommand('adobeLaunch.openWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#adobeLaunch.setup`,
        false
      )
    )
  );

  const status = new ChangeCounter(config);
  status.activate(context.subscriptions);

  const decorations = new ChangeDecorationProvider(config);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations)
  );

  // Right-click actions on tree items.
  context.subscriptions.push(
    vscode.commands.registerCommand('adobeLaunch.copyResourceId', async (node?: { resourceId?: string }) => {
      const id = node?.resourceId;
      if (!id) {
        vscode.window.showWarningMessage('Adobe Launch: no resource id for that item.');
        return;
      }
      await vscode.env.clipboard.writeText(id);
      vscode.window.showInformationMessage(`Adobe Launch: copied ${id}`);
    }),
    vscode.commands.registerCommand('adobeLaunch.revealInFinder', async (node?: { resourceUri?: vscode.Uri; path?: string }) => {
      const uri = node?.resourceUri ?? (node?.path ? vscode.Uri.file(node.path) : undefined);
      if (!uri) {
        vscode.window.showWarningMessage('Adobe Launch: nothing to reveal for that item.');
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', uri);
    })
  );

  const completion = new SatelliteVarCompletionProvider(config);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'typescript' },
      ],
      completion,
      '"',
      "'"
    )
  );

  const diagnostics = new SatelliteVarDiagnostics(config);
  diagnostics.activate(context.subscriptions);

  // Commands (push, set library, …) can change what's in the library, so drop
  // the cached library subtree. The file watcher below uses the soft refresh.
  const refresh = () => {
    reloadTrees();
    status.refresh();
    decorations.refresh();
    diagnostics.refreshAll();
    watchMirror();
  };

  // Re-badge changed resources as the mirror is edited on disk (debounced).
  //
  // Watch the mirror wherever it actually is. `adobeLaunch.mirrorPath` moves it,
  // and people do move it — off a synced OneDrive folder, or out from under a
  // long Windows path — at which point a workspace-relative glob stops matching
  // and the Changes view quietly goes stale with no sign anything is wrong. A
  // RelativePattern rooted at the mirror keeps working outside the workspace.
  let watcher: vscode.FileSystemWatcher | undefined;
  let watching: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const bump = () => {
    if (timer) clearTimeout(timer);
    // Re-badge and rebuild the Changes view as files are edited.
    timer = setTimeout(() => {
      decorations.refresh();
      softRefresh();
    }, 400);
  };
  const watchMirror = (): void => {
    let root: string | undefined;
    try {
      root = config.mirrorRoot();
    } catch {
      root = undefined; // no workspace and no override — nothing to watch yet
    }
    // A watcher armed before the first pull is aimed at a directory that does
    // not exist, so re-arm once it does rather than watching a dead path.
    const key = root ? `${root}\u0000${fs.existsSync(root)}` : undefined;
    if (key === watching) return;
    watcher?.dispose();
    watcher = undefined;
    watching = key;
    if (!root) return;
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '**')
    );
    watcher.onDidChange(bump);
    watcher.onDidCreate(bump);
    watcher.onDidDelete(bump);
  };
  watchMirror();
  context.subscriptions.push({
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher?.dispose();
    },
  });

  registerCommands(context, config, refresh, output, selection);
  registerChangeDiff(context, config, refresh);

  // React to configuration changes that affect UI state.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('adobeLaunch.activePropertyId') ||
        e.affectsConfiguration('adobeLaunch.mirrorPath') ||
        e.affectsConfiguration('adobeLaunch.activeLibraryId') ||
        e.affectsConfiguration('adobeLaunch.activeLibraryName') ||
        e.affectsConfiguration('adobeLaunch.validateDataElementRefs')
      ) {
        refresh();
      }
    })
  );

  decorations.refresh();
  updateBadge();
  updateViewTitles();
  void syncContext();
  output.appendLine('Adobe Launch extension activated.');
}

export function deactivate(): void {
  /* no-op */
}
