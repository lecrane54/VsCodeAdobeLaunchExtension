/** Sign-in webview: single form with Client ID + Client Secret. */

import * as vscode from 'vscode';

import { Config } from '../config';
import { IMSAuth } from '../auth/ims';
import { errorText, explainError } from '../reactor/errors';

export function showSignInPanel(context: vscode.ExtensionContext, config: Config, refresh: () => void): void {
  const panel = vscode.window.createWebviewPanel(
    'adobeLaunchSignIn',
    'Launch Tags: Sign in',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    }
  );

  panel.webview.html = renderHtml(panel.webview);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'submit') {
      const clientId = String(msg.clientId ?? '').trim();
      const clientSecret = String(msg.clientSecret ?? '').trim();
      if (!clientId || !clientSecret) {
        panel.webview.postMessage({ type: 'error', message: 'Both fields are required.' });
        return;
      }
      // Exchange them for a token before storing. A typo or a rotated secret
      // should fail here, naming the problem, rather than surfacing as a
      // confusing failure on whatever command the user runs next.
      try {
        await new IMSAuth(
          clientId,
          clientSecret,
          config.scopes(),
          config.requestTimeoutMs()
        ).accessToken();
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: errorText(explainError(err)) });
        return;
      }
      try {
        await config.storeCredentials(clientId, clientSecret);
        panel.webview.postMessage({ type: 'success' });
        vscode.window.showInformationMessage('Launch Tags: credentials verified and saved.');
        refresh();
        setTimeout(() => panel.dispose(), 900);
      } catch (err) {
        panel.webview.postMessage({
          type: 'error',
          message: `Save failed: ${(err as Error).message}`,
        });
      }
    } else if (msg.type === 'cancel') {
      panel.dispose();
    }
  }, undefined, context.subscriptions);
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = randomNonce();
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Launch Tags: Sign in</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 32px 40px;
      max-width: 560px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.4em;
      font-weight: 600;
      margin: 0 0 6px 0;
    }
    p.help {
      color: var(--vscode-descriptionForeground);
      margin: 0 0 24px 0;
      line-height: 1.5;
    }
    p.help a { color: var(--vscode-textLink-foreground); }
    label {
      display: block;
      font-weight: 500;
      margin-top: 18px;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 1em;
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 28px;
      justify-content: flex-end;
    }
    button {
      padding: 8px 18px;
      border: none;
      border-radius: 3px;
      font-family: inherit;
      font-size: 1em;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-border, var(--vscode-descriptionForeground));
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, transparent); }
    button[disabled] { opacity: 0.5; cursor: default; }
    .msg {
      margin-top: 18px;
      padding: 10px 12px;
      border-radius: 3px;
      display: none;
    }
    .msg.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground, inherit);
    }
    .msg.success {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .toggle {
      background: none;
      border: none;
      padding: 4px 6px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 0.85em;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <h1>Sign in to Adobe</h1>
  <p class="help">
    Paste your Adobe IMS OAuth Server-to-Server credentials.
    Get them from <span>developer.adobe.com/console</span> → your project → <em>OAuth Server-to-Server</em> credential.
    Credentials are stored in VS Code's Secret Storage (macOS Keychain).
  </p>

  <form id="form" autocomplete="off">
    <label for="clientId">Client ID</label>
    <input id="clientId" name="clientId" type="text" spellcheck="false" autocomplete="off" required />

    <label for="clientSecret">Client Secret</label>
    <input id="clientSecret" name="clientSecret" type="password" spellcheck="false" autocomplete="off" required />
    <button type="button" class="toggle" id="toggleSecret">Show secret</button>

    <div id="msg" class="msg"></div>

    <div class="actions">
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <button type="submit" class="primary" id="submit">Sign in</button>
    </div>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('form');
    const idInput = document.getElementById('clientId');
    const secretInput = document.getElementById('clientSecret');
    const msg = document.getElementById('msg');
    const submitBtn = document.getElementById('submit');
    const toggleBtn = document.getElementById('toggleSecret');

    toggleBtn.addEventListener('click', () => {
      const hidden = secretInput.type === 'password';
      secretInput.type = hidden ? 'text' : 'password';
      toggleBtn.textContent = hidden ? 'Hide secret' : 'Show secret';
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      msg.style.display = 'none';
      const clientId = idInput.value.trim();
      const clientSecret = secretInput.value.trim();
      if (!clientId || !clientSecret) {
        showError('Both fields are required.');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying with Adobe…';
      vscode.postMessage({ type: 'submit', clientId, clientSecret });
    });

    function showError(text) {
      msg.textContent = text;
      msg.className = 'msg error';
      msg.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
    function showSuccess() {
      msg.textContent = 'Verified with Adobe. Credentials saved.';
      msg.className = 'msg success';
      msg.style.display = 'block';
    }

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.type === 'error') showError(m.message);
      else if (m.type === 'success') showSuccess();
    });

    setTimeout(() => idInput.focus(), 100);
  </script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
