import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const SECRET_KEYS = {
  clientId: 'adobeLaunch.clientId',
  clientSecret: 'adobeLaunch.clientSecret',
} as const;

/** Credentials sourced from Secret Storage or .env fallback. */
export interface Credentials {
  clientId: string;
  clientSecret: string;
  scopes: string;
}

export class Config {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Where to save the active property / library. Per workspace when a folder
   * is open, so each project remembers its own property. With no folder open,
   * VS Code refuses a workspace write ("Unable to write to Workspace Settings
   * because no workspace is opened"), so fall back to user settings and let
   * sign-in and property selection work before a folder is chosen.
   */
  private settingsTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  mirrorRoot(): string {
    const cfg = vscode.workspace.getConfiguration('adobeLaunch');
    const override = (cfg.get<string>('mirrorPath') || '').trim();
    if (override) return override;
    const ws = this.workspaceRoot();
    if (!ws) throw new Error('Open a folder or workspace before pulling.');
    return path.join(ws, 'launch_property');
  }

  /** Where the read-only Platform / CJA snapshot lives. */
  platformMirrorRoot(): string {
    const cfg = vscode.workspace.getConfiguration('adobeLaunch');
    const override = (cfg.get<string>('platformMirrorPath') || '').trim();
    if (override) return override;
    const ws = this.workspaceRoot();
    if (!ws) throw new Error('Open a folder or workspace before pulling.');
    return path.join(ws, 'adobe_platform');
  }

  /** Whether a Platform pull includes generated ad-hoc schemas. */
  platformIncludeAdhocSchemas(): boolean {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<boolean>('platformIncludeAdhocSchemas', false);
  }

  /** Sandboxes to include in a Platform pull; empty means every active one. */
  platformSandboxes(): string[] {
    const raw = vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<unknown>('platformSandboxes', []);
    return Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
      : [];
  }

  activePropertyId(): string {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<string>('activePropertyId', '')
      .trim();
  }

  async setActivePropertyId(id: string): Promise<void> {
    const changed = id !== this.activePropertyId();
    await vscode.workspace
      .getConfiguration('adobeLaunch')
      .update('activePropertyId', id, this.settingsTarget());
    // Libraries belong to a property — a stale selection would be wrong.
    if (changed) await this.clearActiveLibrary();
  }

  activeLibraryId(): string {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<string>('activeLibraryId', '')
      .trim();
  }

  activeLibraryName(): string {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<string>('activeLibraryName', '')
      .trim();
  }

  async setActiveLibrary(id: string, name: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('adobeLaunch');
    await cfg.update('activeLibraryId', id, this.settingsTarget());
    await cfg.update('activeLibraryName', name, this.settingsTarget());
  }

  async clearActiveLibrary(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('adobeLaunch');
    await cfg.update('activeLibraryId', '', this.settingsTarget());
    await cfg.update('activeLibraryName', '', this.settingsTarget());
  }

  scopes(): string {
    return vscode.workspace.getConfiguration('adobeLaunch').get<string>('scopes')!;
  }

  /** Ceiling for a single Reactor/IMS request, in ms. */
  requestTimeoutMs(): number {
    const seconds = vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<number>('requestTimeoutSeconds', 30);
    // A sub-second ceiling would fail every call; clamp rather than trust it.
    return Math.max(1, seconds) * 1000;
  }

  pullConcurrency(): number {
    return vscode.workspace
      .getConfiguration('adobeLaunch')
      .get<number>('pullConcurrency', 12);
  }

  async credentials(): Promise<Credentials | undefined> {
    const clientId = await this.ctx.secrets.get(SECRET_KEYS.clientId);
    const clientSecret = await this.ctx.secrets.get(SECRET_KEYS.clientSecret);
    if (clientId && clientSecret) {
      return { clientId, clientSecret, scopes: this.scopes() };
    }
    // Fallback to .env in workspace root — for parity with the Python CLIs.
    const ws = this.workspaceRoot();
    if (ws) {
      const envPath = path.join(ws, '.env');
      if (fs.existsSync(envPath)) {
        const parsed = parseEnv(fs.readFileSync(envPath, 'utf-8'));
        const id = parsed.ADOBE_CLIENT_ID;
        const secret = parsed.ADOBE_CLIENT_SECRET;
        if (id && secret) {
          return {
            clientId: id,
            clientSecret: secret,
            scopes: parsed.ADOBE_SCOPES || this.scopes(),
          };
        }
      }
    }
    return undefined;
  }

  async storeCredentials(clientId: string, clientSecret: string): Promise<void> {
    await this.ctx.secrets.store(SECRET_KEYS.clientId, clientId);
    await this.ctx.secrets.store(SECRET_KEYS.clientSecret, clientSecret);
  }

  async clearCredentials(): Promise<void> {
    await this.ctx.secrets.delete(SECRET_KEYS.clientId);
    await this.ctx.secrets.delete(SECRET_KEYS.clientSecret);
  }

}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
