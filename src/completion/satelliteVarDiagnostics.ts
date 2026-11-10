/**
 * Diagnostics: flag `_satellite.getVar('X')` / `setVar('X', …)` where `X` is not
 * a known data element in the active property's mirror.
 *
 * Conservative by design — only runs when the mirror actually contains data
 * elements, and only validates plain string literals (skips interpolation/
 * escapes) so we never warn on something we can't be sure about.
 */

import * as vscode from 'vscode';

import { Config } from '../config';
import { loadDataElements } from './dataElements';

// Capture the call, the quote char (grp 2), and the literal content (grp 3).
const CALL_RE = /_satellite\.(?:getVar|setVar)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
const LANGS = ['javascript', 'typescript'];

export class SatelliteVarDiagnostics {
  private readonly collection = vscode.languages.createDiagnosticCollection('adobeLaunch.dataElements');

  constructor(private readonly config: Config) {}

  activate(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(this.collection, vscode.workspace.onDidOpenTextDocument((doc) => this.scan(doc)), vscode.workspace.onDidChangeTextDocument((e) => this.scan(e.document)), vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)));
    this.refreshAll();
  }

  /** Re-scan every open document — call when the mirror or active property changes. */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.scan(doc);
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<boolean>('validateDataElementRefs', true);
  }

  private scan(doc: vscode.TextDocument): void {
    if (!LANGS.includes(doc.languageId) || !this.enabled()) {
      this.collection.delete(doc.uri);
      return;
    }
    const des = loadDataElements(this.config);
    // undefined = no mirror/property (can't tell); empty = nothing to validate against.
    if (!des || des.length === 0) {
      this.collection.delete(doc.uri);
      return;
    }
    const known = new Set(des.map((d) => d.name));
    const text = doc.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    for (const m of text.matchAll(CALL_RE)) {
      const content = m[2];
      // Only judge plain names; skip empty, Launch tokens (%…%), and escapes.
      if (!content || content.includes('%') || content.includes('\\')) continue;
      if (known.has(content)) continue;
      const contentStart = m.index + m[0].indexOf(m[1]) + 1;
      const range = new vscode.Range(doc.positionAt(contentStart), doc.positionAt(contentStart + content.length));
      const d = new vscode.Diagnostic(range, `Unknown data element "${content}" — no data element with this name in the pulled property.`, vscode.DiagnosticSeverity.Warning);
      d.source = 'Launch Tags';
      diagnostics.push(d);
    }
    this.collection.set(doc.uri, diagnostics);
  }
}
