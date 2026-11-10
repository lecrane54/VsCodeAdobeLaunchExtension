/** Status bar showing "N unpushed changes" for the active property mirror. */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { Config } from '../config';
import { Manifest } from '../local/manifest';
import { detectChanges } from '../local/push';
import { relativeTime } from '../util/format';
import { readPropertyInfo } from '../local/layout';

export class ChangeCounter {
  private readonly item: vscode.StatusBarItem;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: Config) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.show();
  }

  /**
   * Point the item at whatever the next useful step is. Every stage before
   * "ready" used to focus the Changes view, which at that point only says
   * "finish setting up first" — a click that lands nowhere.
   */
  private set(text: string, tooltip: string, command: string, warn = false): void {
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.command = command;
    this.item.backgroundColor = warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  activate(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(this.item);
    const ws = this.config.workspaceRoot();
    if (ws) {
      const w = vscode.workspace.createFileSystemWatcher('**/launch_property/**');
      w.onDidCreate(() => this.scheduleRefresh(), null, subscriptions);
      w.onDidChange(() => this.scheduleRefresh(), null, subscriptions);
      w.onDidDelete(() => this.scheduleRefresh(), null, subscriptions);
      this.watchers.push(w);
      subscriptions.push(w);
    }
    subscriptions.push({ dispose: () => this.dispose() });
    this.refresh();
  }

  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 400);
  }

  refresh(): void {
    const pid = this.config.activePropertyId();
    if (!pid) {
      this.set(
        '$(cloud) Launch: choose property',
        'Launch Tags — no property selected yet.\nClick to pick one.',
        'adobeLaunch.setProperty'
      );
      return;
    }
    let mirror: string;
    try {
      mirror = path.join(this.config.mirrorRoot(), pid);
    } catch {
      // No folder open, so there's nowhere to mirror to.
      this.set(
        '$(cloud) Launch',
        'Launch Tags — open a folder to mirror a property into.',
        'adobeLaunch.openWalkthrough'
      );
      return;
    }
    if (!fs.existsSync(mirror)) {
      this.set(
        '$(cloud-download) Launch: pull property',
        `Launch Tags — ${pid} hasn't been pulled yet.\nClick to pull it.`,
        'adobeLaunch.pull'
      );
      return;
    }
    const name = readPropertyInfo(mirror).name ?? pid;
    const manifest = Manifest.load(mirror);
    const changes = detectChanges(mirror, manifest);
    const pulled = `Pulled ${relativeTime(manifest.data.pulled_at)}`;
    if (changes.length === 0) {
      this.set(
        '$(check) Launch: in sync',
        `Launch Tags — ${name} is in sync with Reactor.\n${pulled}\nClick to review changes in the sidebar.`,
        'adobeLaunchChanges.focus'
      );
    } else {
      this.set(
        `$(cloud-upload) Launch: ${changes.length} unpushed`,
        `Launch Tags — ${changes.length} unpushed change(s) in ${name}.\n${pulled}\nClick to review them in the sidebar.`,
        'adobeLaunchChanges.focus',
        true
      );
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.item.dispose();
  }
}
