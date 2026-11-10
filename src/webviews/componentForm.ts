/**
 * Config editor for a rule component (trigger / condition / action).
 *
 * Custom-code components live in `.js` sidecars and open as code; this webview
 * handles the *config* components whose `settings` is a plain-JSON object. It
 * renders a delegate-aware form (bespoke for the delegates this property uses,
 * generic auto-form otherwise) plus a raw-JSON escape hatch, and writes the
 * edited `settings` back into the component `.json` using the same canonical
 * serialization as pull so the existing diff/push path picks it up.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { canonicalJson } from '../local/layout';

/** One rendered control in the form. */
interface Field {
  key: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select' | 'pathList' | 'stringList';
  placeholder?: string;
  hint?: string;
  options?: string[];
  datalist?: string[];
}

/** The form for one delegate: its controls plus an optional standing note. */
interface Descriptor {
  fields: Field[];
  note?: string;
}

/** Everything the webview needs, serialized into the page. */
interface FormSpec {
  title: string;
  componentName: string;
  delegateId: string;
  kindLabel: string;
  note?: string;
  fields: Field[];
  settings: Record<string, any>;
  generic: boolean;
}

export function showComponentForm(
  context: vscode.ExtensionContext,
  jsonPath: string,
  onSaved: () => void
): void {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  }
  catch (err) {
    vscode.window.showErrorMessage(`Launch Tags: could not read ${path.basename(jsonPath)}: ${(err as Error).message}`);
    return;
  }
  const attrs = parsed?.attributes ?? {};
  const delegateId: string = attrs.delegate_descriptor_id ?? '';
  const settings = attrs.settings && typeof attrs.settings === 'object' && !Array.isArray(attrs.settings)
    ? attrs.settings
    : {};
  const componentName: string = attrs.name ?? path.basename(jsonPath);
  const bespoke = descriptorFor(delegateId, jsonPath);
  const descriptor: Descriptor = bespoke ?? { fields: genericFields(settings) };
  const spec: FormSpec = {
    title: componentName,
    componentName,
    delegateId,
    kindLabel: kindLabel(delegateId),
    note: descriptor.note,
    fields: descriptor.fields,
    settings,
    generic: !bespoke,
  };
  const panel = vscode.window.createWebviewPanel('adobeLaunchComponentForm', `Config: ${componentName}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = renderHtml(panel.webview, spec);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'submit') {
      const newSettings = msg.settings;
      if (newSettings === null || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
        panel.webview.postMessage({ type: 'error', message: 'Settings must be a JSON object.' });
        return;
      }
      try {
        // Re-read to avoid clobbering out-of-band edits, then swap in settings.
        const current = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        current.attributes = current.attributes ?? {};
        current.attributes.settings = newSettings;
        fs.writeFileSync(jsonPath, canonicalJson(current), 'utf-8');
        panel.webview.postMessage({ type: 'success' });
        vscode.window.showInformationMessage(`Launch Tags: saved config for "${componentName}".`);
        onSaved();
        setTimeout(() => panel.dispose(), 600);
      }
      catch (err) {
        panel.webview.postMessage({
          type: 'error',
          message: `Save failed: ${(err as Error).message}`,
        });
      }
    }
    else if (msg.type === 'cancel') {
      panel.dispose();
    }
    else if (msg.type === 'openRaw') {
      vscode.window.showTextDocument(vscode.Uri.file(jsonPath));
    }
  }, undefined, context.subscriptions);
}

/** Human-friendly "Trigger" / "Condition" / "Action" from the delegate id. */
function kindLabel(delegateId: string): string {
  const kind = delegateId.split('::')[1];
  if (kind === 'events')
    return 'Trigger';
  if (kind === 'conditions')
    return 'Condition';
  if (kind === 'actions')
    return 'Action';
  return 'Component';
}

/** Standard value-comparison operators (Core "Value Comparison" condition). */
const VALUE_COMPARISON_OPERATORS = [
  'equals',
  'doesNotEqual',
  'contains',
  'doesNotContain',
  'startsWith',
  'doesNotStartWith',
  'endsWith',
  'doesNotEndWith',
  'matchesRegex',
  'doesNotMatchRegex',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'isTrue',
  'isFalse',
];

/** Bespoke form for the delegates this property actually uses, else null. */
function descriptorFor(delegateId: string, jsonPath: string): Descriptor | null {
  switch (delegateId) {
    case 'core::events::direct-call':
      return {
        fields: [
          {
            key: 'identifier',
            label: 'Direct call identifier',
            type: 'text',
            placeholder: 'e.g. bookButtonMRPAM',
            hint: 'Fires when _satellite.track("<identifier>") is called.',
          },
        ],
      };
    case 'core::events::click':
      return {
        fields: [
          { key: 'elementSelector', label: 'Element selector (CSS)', type: 'text', placeholder: '.large.blue.button' },
          { key: 'anchorDelay', label: 'Anchor delay (ms)', type: 'number', placeholder: '100' },
          { key: 'bubbleFireIfParent', label: 'Fire if a parent element also matches', type: 'checkbox' },
          { key: 'bubbleFireIfChildFired', label: 'Fire if a child element already fired', type: 'checkbox' },
        ],
      };
    case 'core::events::data-element-change':
      return {
        fields: [
          {
            key: 'name',
            label: 'Data element',
            type: 'text',
            placeholder: 'Data element name',
            datalist: dataElementNames(jsonPath),
            hint: 'Fires when this data element’s value changes.',
          },
        ],
      };
    case 'core::events::dom-ready':
    case 'core::events::window-loaded':
    case 'core::events::library-loaded':
    case 'core::events::page-bottom':
      return { fields: [], note: 'This trigger has no configuration.' };
    case 'core::conditions::value-comparison':
      return {
        fields: [
          { key: 'leftOperand', label: 'Left operand', type: 'text', placeholder: '%Data Element%' },
          { key: 'comparison.operator', label: 'Operator', type: 'select', options: VALUE_COMPARISON_OPERATORS },
          { key: 'comparison.caseInsensitive', label: 'Case insensitive', type: 'checkbox' },
          { key: 'rightOperand', label: 'Right operand', type: 'text', placeholder: 'value to compare against' },
        ],
      };
    case 'core::conditions::path-and-querystring':
    case 'core::conditions::path':
      return {
        fields: [
          {
            key: 'paths',
            label: 'Paths',
            type: 'pathList',
            hint: 'Matches the URL path (and query string). Tick “regex” to treat the value as a regular expression.',
          },
        ],
      };
    case 'core::conditions::domain':
      return {
        fields: [{ key: 'domains', label: 'Domains', type: 'stringList', placeholder: 'example.com' }],
      };
    default:
      return null;
  }
}

/** Auto-build fields from the settings object for delegates without a bespoke form. */
function genericFields(settings: Record<string, any>): Field[] {
  const fields: Field[] = [];
  for (const [key, val] of Object.entries(settings)) {
    if (typeof val === 'boolean')
      fields.push({ key, label: key, type: 'checkbox' });
    else if (typeof val === 'number')
      fields.push({ key, label: key, type: 'number' });
    else if (typeof val === 'string')
      fields.push({ key, label: key, type: 'text' });
    // Arrays / nested objects are left to the Raw JSON editor.
  }
  return fields;
}

/** Names of data elements in the same mirror, for autocomplete datalists. */
function dataElementNames(jsonPath: string): string[] {
  // jsonPath = <mirror>/rules/<rule>/components/<file>.json → up four levels.
  const mirror = path.resolve(path.dirname(jsonPath), '..', '..', '..');
  const deDir = path.join(mirror, 'data_elements');
  try {
    return fs
      .readdirSync(deDir)
      .map((d) => d.replace(/__[A-Za-z0-9]+$/, ''))
      .sort();
  }
  catch {
    return [];
  }
}

function renderHtml(webview: vscode.Webview, spec: FormSpec): string {
  const nonce = randomNonce();
  const csp = [
    "default-src 'none'",
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  const specJson = JSON.stringify(spec).replace(/</g, '\\u003c');
  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Component config</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 28px 36px;
      max-width: 640px;
      margin: 0 auto;
    }
    h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 2px 0; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 22px 0; font-size: 0.9em; }
    .subtitle code { font-size: 0.95em; }
    label.field { display: block; font-weight: 500; margin-top: 18px; margin-bottom: 6px; }
    .hint { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 0.85em; margin-top: 3px; }
    input[type=text], input[type=number], select, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 1em;
    }
    textarea { font-family: var(--vscode-editor-font-family, monospace); min-height: 200px; resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .checkrow { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
    .checkrow input { width: auto; }
    .checkrow label { font-weight: 500; margin: 0; }
    .listrow { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .listrow input[type=text] { flex: 1; }
    .listrow .regex { display: flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    .listrow .regex input { width: auto; }
    .iconbtn {
      background: none; border: 1px solid var(--vscode-button-border, var(--vscode-descriptionForeground));
      color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; padding: 4px 9px;
    }
    .addbtn { margin-top: 4px; }
    .note { color: var(--vscode-descriptionForeground); margin-top: 16px; font-style: italic; }
    .actions { display: flex; gap: 12px; margin-top: 28px; justify-content: flex-end; align-items: center; }
    .actions .spacer { flex: 1; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 18px; border-radius: 3px; cursor: pointer; font-size: 1em; }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-button-border, var(--vscode-descriptionForeground)); padding: 8px 18px; border-radius: 3px; cursor: pointer; font-size: 1em; }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, transparent); }
    button[disabled] { opacity: 0.5; cursor: default; }
    .linkbtn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 4px 0; font-size: 0.9em; }
    .msg { margin-top: 18px; padding: 10px 12px; border-radius: 3px; display: none; }
    .msg.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-inputValidation-errorForeground, inherit); }
    .msg.success { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
    #raw { margin-top: 16px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1 id="title"></h1>
  <p class="subtitle" id="subtitle"></p>

  <form id="form" autocomplete="off">
    <div id="fields"></div>
    <p class="note hidden" id="note"></p>

    <div id="raw" class="hidden">
      <label class="field" for="rawInput">Raw settings JSON</label>
      <textarea id="rawInput" spellcheck="false"></textarea>
    </div>

    <div id="msg" class="msg"></div>

    <div class="actions">
      <button type="button" class="linkbtn" id="toggleRaw">Edit raw JSON</button>
      <div class="spacer"></div>
      <button type="button" class="secondary" id="cancel">Cancel</button>
      <button type="submit" class="primary" id="submit">Save</button>
    </div>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const SPEC = ${specJson};
    let rawMode = false;

    document.getElementById('title').textContent = SPEC.componentName;
    const sub = document.getElementById('subtitle');
    sub.innerHTML = SPEC.kindLabel + ' · <code>' + escapeHtml(SPEC.delegateId || 'unknown delegate') + '</code>'
      + (SPEC.generic ? ' · <em>generic form</em>' : '');

    // ---- value helpers ---------------------------------------------------
    function clone(o) { return JSON.parse(JSON.stringify(o == null ? {} : o)); }
    function getPath(obj, key) {
      return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    }
    function setPath(obj, key, val) {
      const parts = key.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = val;
    }
    function deletePath(obj, key) {
      const parts = key.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null) return;
        cur = cur[parts[i]];
      }
      delete cur[parts[parts.length - 1]];
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ---- render fields ---------------------------------------------------
    const fieldsEl = document.getElementById('fields');
    const controls = []; // { field, collect() -> applies onto settings }

    for (const field of SPEC.fields) {
      const cur = getPath(SPEC.settings, field.key);
      if (field.type === 'checkbox') {
        const row = document.createElement('div');
        row.className = 'checkrow';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'f_' + controls.length;
        input.checked = cur === true;
        const lab = document.createElement('label');
        lab.setAttribute('for', input.id);
        lab.textContent = field.label;
        row.appendChild(input);
        row.appendChild(lab);
        fieldsEl.appendChild(row);
        if (field.hint) fieldsEl.appendChild(hintEl(field.hint));
        controls.push({
          field,
          collect: (s) => {
            // Preserve absence: an unchecked box whose key wasn't in the
            // original settings stays absent (avoids spurious false-value diffs).
            if (input.checked) setPath(s, field.key, true);
            else if (getPath(SPEC.settings, field.key) !== undefined) setPath(s, field.key, false);
            else deletePath(s, field.key);
          },
        });
      } else if (field.type === 'select') {
        fieldsEl.appendChild(labelEl(field));
        const sel = document.createElement('select');
        for (const opt of field.options || []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (opt === cur) o.selected = true;
          sel.appendChild(o);
        }
        fieldsEl.appendChild(sel);
        if (field.hint) fieldsEl.appendChild(hintEl(field.hint));
        controls.push({ field, collect: (s) => setPath(s, field.key, sel.value) });
      } else if (field.type === 'pathList') {
        fieldsEl.appendChild(labelEl(field));
        if (field.hint) fieldsEl.appendChild(hintEl(field.hint));
        const container = document.createElement('div');
        fieldsEl.appendChild(container);
        const rows = [];
        const addRow = (value, isRegex) => {
          const row = document.createElement('div');
          row.className = 'listrow';
          const txt = document.createElement('input');
          txt.type = 'text'; txt.value = value || ''; txt.placeholder = '/path/';
          const regexWrap = document.createElement('label');
          regexWrap.className = 'regex';
          const chk = document.createElement('input');
          chk.type = 'checkbox'; chk.checked = !!isRegex;
          regexWrap.appendChild(chk);
          regexWrap.appendChild(document.createTextNode('regex'));
          const del = document.createElement('button');
          del.type = 'button'; del.className = 'iconbtn'; del.textContent = '✕';
          del.addEventListener('click', () => { container.removeChild(row); const i = rows.indexOf(entry); if (i >= 0) rows.splice(i, 1); });
          row.appendChild(txt); row.appendChild(regexWrap); row.appendChild(del);
          container.appendChild(row);
          const entry = { txt, chk };
          rows.push(entry);
        };
        const list = Array.isArray(cur) ? cur : [];
        if (list.length === 0) addRow('', true);
        for (const p of list) addRow(p && p.value, p && p.valueIsRegex);
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'iconbtn addbtn'; add.textContent = '+ Add path';
        add.addEventListener('click', () => addRow('', true));
        fieldsEl.appendChild(add);
        controls.push({ field, collect: (s) => setPath(s, field.key, rows.map((r) => ({ value: r.txt.value, valueIsRegex: r.chk.checked }))) });
      } else if (field.type === 'stringList') {
        fieldsEl.appendChild(labelEl(field));
        if (field.hint) fieldsEl.appendChild(hintEl(field.hint));
        const container = document.createElement('div');
        fieldsEl.appendChild(container);
        const rows = [];
        const addRow = (value) => {
          const row = document.createElement('div');
          row.className = 'listrow';
          const txt = document.createElement('input');
          txt.type = 'text'; txt.value = value || ''; txt.placeholder = field.placeholder || '';
          const del = document.createElement('button');
          del.type = 'button'; del.className = 'iconbtn'; del.textContent = '✕';
          del.addEventListener('click', () => { container.removeChild(row); const i = rows.indexOf(entry); if (i >= 0) rows.splice(i, 1); });
          row.appendChild(txt); row.appendChild(del);
          container.appendChild(row);
          const entry = { txt };
          rows.push(entry);
        };
        const list = Array.isArray(cur) ? cur : [];
        if (list.length === 0) addRow('');
        for (const v of list) addRow(v);
        const add = document.createElement('button');
        add.type = 'button'; add.className = 'iconbtn addbtn'; add.textContent = '+ Add';
        add.addEventListener('click', () => addRow(''));
        fieldsEl.appendChild(add);
        controls.push({ field, collect: (s) => setPath(s, field.key, rows.map((r) => r.txt.value).filter((v) => v !== '')) });
      } else {
        // text or number
        fieldsEl.appendChild(labelEl(field));
        const input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : 'text';
        input.value = cur == null ? '' : String(cur);
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.datalist && field.datalist.length) {
          const dlId = 'dl_' + controls.length;
          const dl = document.createElement('datalist');
          dl.id = dlId;
          for (const opt of field.datalist) { const o = document.createElement('option'); o.value = opt; dl.appendChild(o); }
          fieldsEl.appendChild(dl);
          input.setAttribute('list', dlId);
        }
        fieldsEl.appendChild(input);
        if (field.hint) fieldsEl.appendChild(hintEl(field.hint));
        controls.push({
          field,
          collect: (s) => {
            const v = input.value;
            if (field.type === 'number') {
              if (v.trim() === '') deletePath(s, field.key);
              else setPath(s, field.key, Number(v));
            } else if (v === '' && getPath(SPEC.settings, field.key) === undefined) {
              // Empty text for a key that wasn't present stays absent (no spurious "": diff).
              deletePath(s, field.key);
            } else {
              setPath(s, field.key, v);
            }
          },
        });
      }
    }

    if (SPEC.note) { const n = document.getElementById('note'); n.textContent = SPEC.note; n.classList.remove('hidden'); }

    function labelEl(field) {
      const l = document.createElement('label');
      l.className = 'field';
      l.textContent = field.label;
      return l;
    }
    function hintEl(text) {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = text;
      return p;
    }

    // ---- settings assembly ----------------------------------------------
    function settingsFromForm() {
      const s = clone(SPEC.settings);
      for (const c of controls) c.collect(s);
      return s;
    }

    // ---- raw JSON toggle -------------------------------------------------
    const rawWrap = document.getElementById('raw');
    const rawInput = document.getElementById('rawInput');
    const toggleRaw = document.getElementById('toggleRaw');
    toggleRaw.addEventListener('click', () => {
      rawMode = !rawMode;
      if (rawMode) {
        rawInput.value = JSON.stringify(settingsFromForm(), null, 2);
        rawWrap.classList.remove('hidden');
        fieldsEl.classList.add('hidden');
        document.getElementById('note').classList.add('hidden');
        toggleRaw.textContent = 'Back to form';
      } else {
        rawWrap.classList.add('hidden');
        fieldsEl.classList.remove('hidden');
        if (SPEC.note) document.getElementById('note').classList.remove('hidden');
        toggleRaw.textContent = 'Edit raw JSON';
      }
      hideMsg();
    });

    // ---- submit / cancel -------------------------------------------------
    const form = document.getElementById('form');
    const submitBtn = document.getElementById('submit');
    const msg = document.getElementById('msg');

    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      hideMsg();
      let settings;
      if (rawMode) {
        try {
          settings = JSON.parse(rawInput.value || '{}');
        } catch (err) {
          showError('Invalid JSON: ' + err.message);
          return;
        }
        if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
          showError('Settings must be a JSON object, e.g. { }.');
          return;
        }
      } else {
        settings = settingsFromForm();
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      vscode.postMessage({ type: 'submit', settings });
    });

    function showError(text) {
      msg.textContent = text; msg.className = 'msg error'; msg.style.display = 'block';
      submitBtn.disabled = false; submitBtn.textContent = 'Save';
    }
    function hideMsg() { msg.style.display = 'none'; }

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.type === 'error') showError(m.message);
      else if (m.type === 'success') { msg.textContent = 'Saved.'; msg.className = 'msg success'; msg.style.display = 'block'; }
    });
  </script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
