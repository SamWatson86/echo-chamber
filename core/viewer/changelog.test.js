const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const context = { document: { getElementById() { return null; } }, setTimeout() {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'changelog.js'), 'utf8'), context);
  return context;
}

test('release-note identity changes with content without requiring an installer version bump', () => {
  const h = load();
  const entry = { version: 'v0.6.37', title: 'Sharing', notes: ['Audio fixed'] };
  const stamp = h.getChangelogStamp(entry);
  assert.equal(h.getChangelogStamp({ ...entry, notes: [...entry.notes] }), stamp);
  assert.notEqual(h.getChangelogStamp({ ...entry, notes: ['Audio and titles fixed'] }), stamp);
  assert.notEqual(h.getChangelogStamp({ ...entry, title: 'Audio' }), stamp);
  assert.equal(h.CHANGELOG_LATEST, h.getChangelogStamp(h.ECHO_CHANGELOG[0]));
});
