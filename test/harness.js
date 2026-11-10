/** Dependency-free assert/report harness — `node test/<file>.test.js`. */
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

function section(title) { console.log('\n' + title); }

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

module.exports = { check, section, done };
