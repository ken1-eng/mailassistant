const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test('dist/Code.gs が src/*.js と一致している（ずれていたら npm run build）', () => {
  const file = path.join(__dirname, '..', 'dist', 'Code.gs');
  const before = fs.readFileSync(file, 'utf8');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build.js')]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
