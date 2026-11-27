const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-please.yml'), 'utf8');
const step = workflow.match(/^      - name: Enable Auto-Merge for Generated Release PRs\n([\s\S]*?)(?=^      - name:)/m)?.[1];
assert.ok(step, 'The embedded auto-merge step must exist.');
const command = step.split('        run: |\n')[1].trimEnd().split('\n').map((line) => line.slice(10)).join('\n');
const repository = 'example/workflows';
const branch = 'release/main';
const branchPrefix = 'release-please--branches--' + branch;
const sha = 'a'.repeat(40);

function pull(number, { author = 'release-bot[bot]', head = branchPrefix, labels = ['autorelease: pending'],
  draft = false, state = 'open', repoId = 10 } = {}) {
  return {
    number, state, draft, user: { login: author },
    base: { ref: branch, repo: { id: 10 } },
    head: { ref: head, repo: { id: repoId }, sha },
    labels: labels.map((name) => ({ name })),
  };
}

function run(t, fixture, reported = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-auto-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(process.env.GH_FIXTURE);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const print = (value) => console.log(JSON.stringify(value));
if (args[0] === 'api' && args[1] === 'graphql') {
  print({ data: { viewer: fixture.viewer ?? { login: 'release-bot[bot]' } } });
} else if (args.some((arg) => arg.endsWith('/pulls'))) {
  print(fixture.pages || [fixture.pulls || []]);
} else if (args.some((arg) => arg.includes('/contents/'))) {
  print({ content: Buffer.from(JSON.stringify(fixture.config || {})).toString('base64') });
} else if (args.some((arg) => /\\/pulls\\/\\d+\\/files\\?/.test(arg))) {
  print([[{ filename: fixture.changedFile || '.release-please-manifest.json', status: 'modified' }]]);
} else if (args[0] === 'pr' && args[1] === 'view') {
  print({ state: 'OPEN', isDraft: false, baseRefName: process.env.TARGET_BRANCH, headRefOid: '${sha}',
    ...(fixture.live?.[args[2]] || {}) });
} else if (args[0] === 'pr' && args[1] === 'merge') {
  if (fixture.failMerge) process.exitCode = 1;
} else {
  throw new Error('Unexpected gh arguments: ' + JSON.stringify(args));
}
`, { mode: 0o755 });
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env, PATH: dir + path.delimiter + process.env.PATH,
      GITHUB_REPOSITORY: repository, TARGET_BRANCH: branch,
      RELEASE_PULL_REQUESTS: reported.length ? JSON.stringify(reported) : '',
      CONFIG_FILE: fixture.configFile || '', MANIFEST_FILE: fixture.manifestFile || '',
      GH_FIXTURE: JSON.stringify(fixture), GH_LOG: log,
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const merges = calls.filter(([command, verb]) => command === 'pr' && verb === 'merge');
  return { ...result, calls, merges };
}

function expectedMerge(number) {
  return ['pr', 'merge', String(number), '--repo', repository, '--auto', '--squash', '--match-head-commit', sha];
}

test('reconciles an unchanged Release Please PR after an auto-merge failure', (t) => {
  const reported = [{ number: 7, baseBranchName: branch, headBranchName: branchPrefix }];
  const failed = run(t, { pulls: [pull(7)], failMerge: true }, reported);
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.merges, [expectedMerge(7)]);
  const retried = run(t, { pulls: [pull(7)] });
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(retried.merges, [expectedMerge(7)]);
});

test('uses configured labels and manifest for component and group PRs across pages', (t) => {
  const author = 'release-owner';
  const labels = ['release', 'ready'];
  const component = pull(4, { author, labels, head: branchPrefix + '--components--example' });
  const group = pull(8, { author, labels, head: branchPrefix + '--groups--example' });
  const result = run(t, {
    pages: [[component], [group]],
    viewer: { login: author },
    config: { label: labels.join(',') },
    configFile: 'config/release config.json',
    manifestFile: 'config/versions.json',
    changedFile: 'config/versions.json',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.merges, [expectedMerge(4), expectedMerge(8)]);
  assert.ok(result.calls.some((args) => args.includes('repos/' + repository + '/contents/config/release%20config.json')));
});

test('ignores unrelated authors, forks, non-release branch names, closed and draft PRs', (t) => {
  const result = run(t, { pulls: [
    pull(1, { author: 'contributor' }),
    pull(2, { repoId: 33 }),
    pull(3, { head: branchPrefix + '-unrelated' }),
    pull(4, { state: 'closed' }),
    pull(5, { draft: true }),
    pull(6, { labels: ['unrelated'] }),
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.merges, []);
});

test('rejects a reported PR if its head or author changed', (t) => {
  const result = run(t, { pulls: [pull(5, { author: 'contributor' })] },
    [{ number: 5, baseBranchName: branch, headBranchName: branchPrefix }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected head or author/);
  assert.deepEqual(result.merges, []);
});

test('fails visibly if a pending release candidate has no verified manifest change', (t) => {
  const result = run(t, { pulls: [pull(9)], changedFile: 'README.md' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not verify the release manifest change/);
  assert.deepEqual(result.merges, []);
});

test('fails on changed heads and leaves existing squash auto-merge alone', (t) => {
  const result = run(t, { pulls: [pull(1), pull(2)], live: {
    1: { autoMergeRequest: { mergeMethod: 'SQUASH' } },
    2: { headRefOid: 'b'.repeat(40) },
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pull request changed during verification/);
  assert.deepEqual(result.merges, []);
});
