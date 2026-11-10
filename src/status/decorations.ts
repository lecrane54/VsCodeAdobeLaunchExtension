/** File decorations that badge locally-modified (unpushed) Launch resources. */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { Config } from '../config';
import { Manifest } from '../local/manifest';
import { detectChanges, Change } from '../local/push';

const MODIFIED = new vscode.FileDecoration('M', 'Modified — unpushed local change', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));

/**
 * Marks changed rules, data elements, extensions, and rule components so the
 * tree (and the file explorer) show which resources have unpushed edits.
 * A changed component also propagates the badge up to its parent rule folder.
 */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private modified = new Set<string>();

  constructor(private readonly config: Config) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.modified.has(uri.fsPath) ? MODIFIED : undefined;
  }

  refresh(): void {
    const previous = this.modified;
    this.modified = this.computeModified();
    // Notify for the union of old and new so cleared badges disappear too.
    const changed = new Set([...previous, ...this.modified]);
    this._onDidChange.fire([...changed].map((p) => vscode.Uri.file(p)));
  }

  private computeModified(): Set<string> {
    const out = new Set<string>();
    const pid = this.config.activePropertyId();
    if (!pid) return out;
    let mirror: string;
    try {
      mirror = path.join(this.config.mirrorRoot(), pid);
    } catch {
      return out;
    }
    if (!fs.existsSync(mirror)) return out;
    let changes: Change[];
    try {
      changes = detectChanges(mirror, Manifest.load(mirror));
    } catch {
      return out;
    }
    for (const c of changes) {
      out.add(c.jsonPath);
      if (c.jsPath) out.add(c.jsPath);
      if (c.kind === 'rule_component') {
        // jsonPath = <ruleDir>/components/<stem>.json → badge the rule folder.
        out.add(path.dirname(path.dirname(c.jsonPath)));
      } else {
        // rule.json / data_element.json / extension.json → badge the folder.
        out.add(path.dirname(c.jsonPath));
      }
    }
    return out;
  }
}
