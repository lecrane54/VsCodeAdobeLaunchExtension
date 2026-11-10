/** Completion provider: `_satellite.getVar("<cursor>")` shows all data element names. */

import * as vscode from 'vscode';

import { Config } from '../config';
import { loadDataElements } from './dataElements';

const TRIGGER_RE = /_satellite\.(getVar|setVar)\s*\(\s*(['"])[^'"]*$/;

export class SatelliteVarCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly config: Config) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const linePrefix = doc.lineAt(pos).text.substring(0, pos.character);
    if (!TRIGGER_RE.test(linePrefix)) return undefined;
    const des = loadDataElements(this.config);
    if (!des) return [];
    return des
      .map((de) => {
        const item = new vscode.CompletionItem(de.name, vscode.CompletionItemKind.Variable);
        item.detail = `${de.id} · ${de.kind}`;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${de.name}**\n\n`);
        md.appendMarkdown(`- id: \`${de.id}\`\n`);
        if (de.storageDuration) md.appendMarkdown(`- storage: \`${de.storageDuration}\`\n`);
        if (de.defaultValue) md.appendMarkdown(`- default: \`${de.defaultValue}\`\n`);
        if (de.kind === 'custom-code') md.appendMarkdown('- source in adjacent `settings.js`');
        item.documentation = md;
        // Insert just the identifier — surrounding quotes are already present in code.
        item.insertText = de.name;
        return item;
      })
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }
}
