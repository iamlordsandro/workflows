const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'workflow-quality.yml'), 'utf8');
const lines = workflow.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === "python3 - <<'PY'");
if (start === -1) throw new Error('The workflow must contain an inline Python checker.');
const end = lines.findIndex((line, index) => index > start && line.trim() === 'PY');
if (end === -1) throw new Error('The inline Python checker must have a closing delimiter.');
const indent = lines[start].match(/^\s*/)[0].length;
const checker = lines.slice(start + 1, end).map((line) => line.slice(indent)).join('\n');

function fixture(t, files) {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-quality-'));
  const checkout = path.join(directory, 'checkout');
  mkdirSync(checkout);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(checkout, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  return { directory, checkout };
}

function check(checkout, docsRoot = '.') {
  return spawnSync('python3', ['-c', checker], {
    cwd: checkout,
    env: { ...process.env, GITHUB_WORKSPACE: checkout, DOCS_ROOT: docsRoot },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function expectSuccess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('existing local targets support optional titles and angle brackets', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '[Guide](docs/guide.md "Guide title")\n[Space](<docs/space guide.md> \'Space title\')\n[Parentheses](docs/guide(v2).md)\n',
    'docs/guide.md': 'Guide\n',
    'docs/space guide.md': 'Guide\n',
    'docs/guide(v2).md': 'Guide\n',
  });
  const result = check(checkout);
  expectSuccess(result);
  assert.match(result.stdout, /Checked 3 local file targets/);
});

test('a missing local target fails with its source location', (t) => {
  const { checkout } = fixture(t, { 'README.md': '[Missing](docs/missing.md)\n' });
  const result = check(checkout);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:1: missing local file target: docs\/missing\.md/);
});

test('anchors and external destinations are ignored without network access', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '[Anchor](#unvalidated)\n[Web](https://example.invalid/missing)\n[HTTP](http://example.invalid)\n[Email](mailto:synthetic@example.invalid)\n[Network](//example.invalid/missing)\n',
  });
  const result = check(checkout);
  expectSuccess(result);
  assert.match(result.stdout, /Checked 0 local file targets/);
});

test('URL-encoded paths are decoded and fragment existence is not validated', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '[Guide](docs/space%20guide.md#unknown-section)\n[Hash](docs/hash%23name.md#unknown)\n',
    'docs/space guide.md': 'Guide\n',
    'docs/hash#name.md': 'Guide\n',
  });
  expectSuccess(check(checkout));
});

test('links inside fenced, indented and inline code are ignored', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '```markdown\n[Missing](fenced.md)\n```\n~~~\n[Missing](tilde.md)\n~~~\n`[Missing](inline.md)`\n``[Missing](inline-long.md)``\n    [Missing](indented.md)\n\t[Missing](tab.md)\n[Present](present.txt)\n',
    'present.txt': 'Present\n',
  });
  const result = check(checkout);
  expectSuccess(result);
  assert.match(result.stdout, /Checked 1 local file targets/);
});

test('relative targets cannot escape the checkout even when they exist', (t) => {
  const { checkout, directory } = fixture(t, { 'README.md': '[Outside](..%2Foutside.md)\n' });
  writeFileSync(path.join(directory, 'outside.md'), 'Outside\n');
  const result = check(checkout);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local file target escapes the checkout/);
});

test('a local symlink cannot target a file outside the checkout', (t) => {
  const { checkout, directory } = fixture(t, { 'README.md': '[Outside](linked.txt)\n' });
  const outside = path.join(directory, 'outside.txt');
  writeFileSync(outside, 'Outside\n');
  symlinkSync(outside, path.join(checkout, 'linked.txt'));
  const result = check(checkout);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local file target escapes the checkout/);
});

test('docs_root limits scanning while relative targets may reach the rest of the checkout', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '[Ignored missing link](missing.md)\n',
    'docs/guide.md': '[Shared](../shared.txt)\n',
    'shared.txt': 'Shared\n',
  });
  const result = check(checkout, 'docs');
  expectSuccess(result);
  assert.match(result.stdout, /Checked 1 local file targets in 1 Markdown files/);
});

test('docs_root cannot escape the checkout', (t) => {
  const { checkout } = fixture(t, { 'README.md': 'Guide\n' });
  const result = check(checkout, '..');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs_root must be an existing directory inside the checkout/);
});

test('.git and node_modules are excluded from Markdown scanning', (t) => {
  const { checkout } = fixture(t, {
    'README.md': 'Guide\n',
    '.git/notes.md': '[Missing](missing.md)\n',
    'node_modules/package/README.md': '[Missing](missing.md)\n',
    'docs/node_modules/package/README.md': '[Missing](missing.md)\n',
  });
  const result = check(checkout);
  expectSuccess(result);
  assert.match(result.stdout, /in 1 Markdown files/);
});

test('reference definitions check local targets and ignore external references', (t) => {
  const { checkout } = fixture(t, {
    'README.md': '[Guide][guide]\n\n[guide]: docs/guide.md "Guide title"\n[external]: https://example.invalid/missing\n',
    'docs/guide.md': 'Guide\n',
  });
  const result = check(checkout);
  expectSuccess(result);
  assert.match(result.stdout, /Checked 1 local file targets/);
});
