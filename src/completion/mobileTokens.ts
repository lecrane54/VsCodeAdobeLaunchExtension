/**
 * Mobile data element tokens in a pulled mobile property's JSON.
 *
 * Mobile rules have no JavaScript — data elements are referenced as
 * `{%%name%%}` inside component and extension settings. This offers names after
 * `{%%`, and warns on references that won't resolve (see
 * `findMobileTokenIssues`). It stays silent for web properties, whose JSON
 * legitimately carries `%name%`.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { Config } from '../config';
import { readPropertyInfo } from '../local/layout';
import { findMobileTokenIssues, platformOf } from '../reactor/platform';
import { loadDataElements } from './dataElements';

const TRIGGER_RE = /\{%%([^%"\n]*)$/;

/** The active mirror, when it's a mobile property and `doc` lives inside it. */
function mobileMirrorFor(config: Config, doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme !== 'file' || !/^jsonc?$/.test(doc.languageId)) return undefined;
  const pid = config.activePropertyId();
  if (!pid) return undefined;
  let mirror: string;
  try {
    mirror = path.join(config.mirrorRoot(), pid);
  } catch {
    return undefined;
  }
  const rel = path.relative(mirror, doc.uri.fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return platformOf(readPropertyInfo(mirror).platform) === 'mobile' ? mirror : undefined;
}

export class MobileTokenCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly config: Config) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const line = doc.lineAt(pos).text;
    const m = TRIGGER_RE.exec(line.substring(0, pos.character));
    if (!m || !mobileMirrorFor(this.config, doc)) return undefined;
    const des = loadDataElements(this.config);
    if (!des) return [];
    // Replace what's been typed after `{%%`, and close the token unless it
    // already is.
    const range = new vscode.Range(pos.line, pos.character - m[1].length, pos.line, pos.character);
    const closed = line.substring(pos.character).startsWith('%%}');
    return des
      .map((de) => {
        const item = new vscode.CompletionItem(de.name, vscode.CompletionItemKind.Variable);
        item.detail = `${de.id} · ${de.kind}`;
        item.insertText = closed ? de.name : `${de.name}%%}`;
        item.range = range;
        return item;
      })
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }
}

export class MobileTokenDiagnostics {
  private readonly collection = vscode.languages.createDiagnosticCollection('adobeLaunch.mobileTokens');

  constructor(private readonly config: Config) {}

  activate(subscriptions: vscode.Disposable[]): void {
    subscriptions.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((doc) => this.scan(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scan(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri))
    );
    this.refreshAll();
  }

  /** Re-scan every open document — call when the mirror or active property changes. */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.scan(doc);
  }

  private scan(doc: vscode.TextDocument): void {
    const enabled = vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<boolean>('validateDataElementRefs', true);
    const des = enabled && mobileMirrorFor(this.config, doc) ? loadDataElements(this.config) : undefined;
    // undefined = not a mobile mirror file (or can't tell); empty = nothing to validate against.
    if (!des || des.length === 0) {
      this.collection.delete(doc.uri);
      return;
    }
    const known = new Set(des.map((d) => d.name));
    const diagnostics = findMobileTokenIssues(doc.getText(), known).map((issue) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(issue.start), doc.positionAt(issue.end)),
        issue.message,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'Adobe Launch';
      return d;
    });
    this.collection.set(doc.uri, diagnostics);
  }
}
