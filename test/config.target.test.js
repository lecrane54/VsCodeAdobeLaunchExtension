/** Saving the active property/library works with and without an open folder. */

const Module = require('module');
const path = require('path');

const { check, section, done } = require('./harness');

// Minimal vscode stub: records every settings write and its target, and — like
// the real API — rejects a Workspace write when no folder is open.
const Target = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const state = { folders: undefined, writes: [], values: {} };
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req !== 'vscode') return origLoad.call(this, req, ...rest);
  return {
    ConfigurationTarget: Target,
    workspace: {
      get workspaceFolders() { return state.folders; },
      getConfiguration: () => ({
        get: (key, def) => (key in state.values ? state.values[key] : def),
        update: async (key, value, target) => {
          if (target === Target.Workspace && !state.folders?.length) {
            throw new Error('Unable to write to Workspace Settings because no workspace is opened.');
          }
          state.writes.push({ key, value, target });
          state.values[key] = value;
        },
      }),
    },
  };
};

const { Config } = require(path.join(__dirname, '..', 'out', 'config.js'));
const PID = 'PR' + 'a'.repeat(32);

(async () => {
section('1. no folder open: selections go to user settings instead of failing');
{
  state.folders = undefined; state.writes = []; state.values = {};
  const config = new Config({});
  let error;
  try {
    await config.setActivePropertyId(PID);
    await config.setActiveLibrary('LB1', 'Dev library');
  } catch (err) { error = err; }
  check('no error', error === undefined, error && error.message);
  check('property saved', config.activePropertyId() === PID);
  check('library saved', config.activeLibraryId() === 'LB1' && config.activeLibraryName() === 'Dev library');
  check('every write went to user settings', state.writes.length > 0 && state.writes.every((w) => w.target === Target.Global), state.writes);
}

section('2. folder open: selections stay per workspace');
{
  state.folders = [{ uri: { fsPath: '/tmp/project' } }]; state.writes = []; state.values = {};
  const config = new Config({});
  await config.setActivePropertyId(PID);
  await config.setActiveLibrary('LB2', 'Other');
  check('every write went to workspace settings', state.writes.length > 0 && state.writes.every((w) => w.target === Target.Workspace), state.writes);
}

section('3. switching property clears the library in the same scope');
{
  state.folders = undefined; state.writes = []; state.values = { activePropertyId: PID, activeLibraryId: 'LB1', activeLibraryName: 'Dev' };
  const config = new Config({});
  await config.setActivePropertyId('PR' + 'b'.repeat(32));
  check('library cleared', config.activeLibraryId() === '' && config.activeLibraryName() === '');
  check('cleared in user settings', state.writes.filter((w) => w.key.startsWith('activeLibrary')).every((w) => w.target === Target.Global), state.writes);
}

done();
})();
