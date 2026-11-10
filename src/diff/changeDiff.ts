/**
 * "Show what changed" for an unpushed change — entirely local.
 *
 * Diffs the working file against its copy in the `.baseline/` snapshot (the last
 * pulled/pushed state, maintained in local/baseline.ts). No Reactor round-trip.
 * Config components diff their component `.json`; custom-code components diff
 * their `.js`. Because the baseline was written from the same pull, only real
 * edits show — no server-metadata noise.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Config } from '../config';
import { baselinePathFor, ensureBaseline, revertToBaseline } from '../local/baseline';
import { Change, detectChanges } from '../local/push';
import { Manifest } from '../local/manifest';

/** What the Changes view hands these commands: enough of a detected change to
 * find its working file, its baseline, and whether it was created locally. */
export interface ChangeRef {
  kind: Change['kind'];
  resourceId: string;
  jsonPath: string;
  jsPath: string | null;
  reason: Change['reason'];
}

/** Delete a locally-created (not-yet-pushed) resource: its files + manifest entries. */
function removeCreatedResource(
  root: string,
  manifest: Manifest,
  r: { kind: ChangeRef['kind']; resourceId: string; jsonPath: string; jsPath: string | null }
): boolean {
  if (r.kind === 'rule') {
    // rule.json lives in the rule folder; remove the whole folder + child entries.
    const ruleDir = path.dirname(r.jsonPath);
    try { fs.rmSync(ruleDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const [key, entry] of Object.entries(manifest.data.resources)) {
      if ((entry.id === r.resourceId && entry.kind === 'rule') || entry.parent_rule_id === r.resourceId) {
        delete manifest.data.resources[key];
      }
    }
    return true;
  }
  if (r.kind === 'rule_component') {
    for (const p of [r.jsonPath, r.jsPath]) {
      if (p) { try { if (fs.existsSync(p)) fs.rmSync(p); } catch { /* ignore */ } }
    }
    for (const [key, entry] of Object.entries(manifest.data.resources)) {
      if (entry.id === r.resourceId && entry.kind === 'rule_component') {
        delete manifest.data.resources[key];
      }
    }
    return true;
  }
  return false;
}

export function registerChangeDiff(
  context: vscode.ExtensionContext,
  config: Config,
  refresh: () => void
): void {
  const mirrorRoot = (): string | undefined => {
    try {
      const pid = config.activePropertyId();
      return pid ? path.join(config.mirrorRoot(), pid) : undefined;
    } catch {
      return undefined;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'adobeLaunch.revertChange',
      async (node?: { change?: ChangeRef; label?: string }) => {
        const ref = node?.change;
        const root = mirrorRoot();
        if (!ref || !root) {
          vscode.window.showWarningMessage('Launch Tags: nothing to revert for that item.');
          return;
        }
        const name = node?.label || path.basename(ref.jsPath ?? ref.jsonPath);

        // A locally-created resource has no baseline: reverting = removing it.
        if (ref.reason === 'created') {
          const ok = await vscode.window.showWarningMessage(
            `Remove the newly-created "${name}"?`,
            { modal: true, detail: 'It hasn’t been pushed, so it will be deleted locally.' },
            'Remove'
          );
          if (ok !== 'Remove') return;
          const manifest = Manifest.load(root);
          removeCreatedResource(root, manifest, ref);
          manifest.save(root);
          vscode.window.showInformationMessage(`Launch Tags: removed "${name}".`);
          refresh();
          return;
        }

        const ok = await vscode.window.showWarningMessage(
          `Revert "${name}" to the last pulled/pushed state?`,
          { modal: true, detail: 'Your local edits to it will be discarded.' },
          'Revert'
        );
        if (ok !== 'Revert') return;
        try {
          ensureBaseline(root);
        } catch {
          /* handled below */
        }
        if (!revertToBaseline(root, ref.jsonPath, ref.jsPath)) {
          vscode.window.showInformationMessage(
            'Launch Tags: no local baseline for this change (it predates tracking), so it can’t be reverted locally.'
          );
          return;
        }
        vscode.window.showInformationMessage(`Launch Tags: reverted "${name}".`);
        refresh();
      }
    ),

    vscode.commands.registerCommand('adobeLaunch.revertAllChanges', async () => {
      const root = mirrorRoot();
      if (!root) {
        vscode.window.showWarningMessage('Launch Tags: no active property mirror.');
        return;
      }
      const manifest = Manifest.load(root);
      let changes: Change[];
      try {
        changes = detectChanges(root, manifest);
      } catch {
        changes = [];
      }
      if (changes.length === 0) {
        vscode.window.showInformationMessage('Launch Tags: no local changes to revert.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Revert all ${changes.length} unpushed change(s)?`,
        { modal: true, detail: 'Every local edit is discarded and newly-created rules/components are removed. This cannot be undone.' },
        'Revert all'
      );
      if (ok !== 'Revert all') return;
      try {
        ensureBaseline(root);
      } catch {
        /* handled per-file below */
      }
      let reverted = 0;
      let removed = 0;
      let skipped = 0;
      for (const c of changes) {
        if (c.reason === 'created') {
          if (removeCreatedResource(root, manifest, c)) removed++;
        } else if (revertToBaseline(root, c.jsonPath, c.jsPath)) {
          reverted++;
        } else {
          skipped++;
        }
      }
      manifest.save(root);
      vscode.window.showInformationMessage(
        `Launch Tags: reverted ${reverted}` +
          (removed ? `, removed ${removed} new` : '') +
          ` change(s)` +
          (skipped ? `; ${skipped} had no baseline and were left as-is.` : '.')
      );
      refresh();
    }),

    vscode.commands.registerCommand('adobeLaunch.diffChange', async (node?: { change?: ChangeRef }) => {
      const ref = node?.change;
      if (!ref) {
        vscode.window.showWarningMessage('Launch Tags: nothing to compare for that item.');
        return;
      }

      let root: string;
      try {
        root = path.join(config.mirrorRoot(), config.activePropertyId());
      } catch {
        vscode.window.showWarningMessage('Launch Tags: no active property mirror.');
        return;
      }

      // The change node points at the file it represents: the .js for custom
      // code, otherwise the component/resource .json.
      const working = ref.jsPath ?? ref.jsonPath;
      if (!fs.existsSync(working)) {
        vscode.window.showWarningMessage('Launch Tags: the changed file no longer exists.');
        return;
      }

      // Seed a baseline on first use for mirrors pulled before this feature.
      try {
        ensureBaseline(root);
      } catch {
        /* non-fatal — handled by the missing-baseline branch below */
      }

      const basePath = baselinePathFor(root, working);
      if (!fs.existsSync(basePath)) {
        vscode.window.showInformationMessage(
          'Launch Tags: no local baseline for this change yet. Baselines are captured on pull and push — ' +
            'this edit predates tracking, so it will diff after your next pull.'
        );
        return;
      }

      const title = `${resourceLabel(ref)} — Baseline ↔ Local`;
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(basePath),
        vscode.Uri.file(working),
        title
      );
    })
  );
}

/** A readable name for the diff title: the resource name if we can read it, else the file. */
function resourceLabel(ref: ChangeRef): string {
  try {
    const name = JSON.parse(fs.readFileSync(ref.jsonPath, 'utf-8'))?.attributes?.name;
    if (typeof name === 'string' && name) return name;
  } catch {
    /* fall through */
  }
  return path.basename(ref.jsPath ?? ref.jsonPath);
}
