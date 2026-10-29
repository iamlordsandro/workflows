const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorkflow } = require('./helpers.cjs');

const workflow = '.github/workflows/pr-title-normalize.yml';

function fixture(title, options = {}) {
  const pull = { number: 7, title, state: 'open', body: 'Refs #12',
    head: { sha: 'head-1', ref: options.branch || 'topic' }, ...options.pull };
  const calls = [];
  let reads = 0;
  const settings = { allow_squash_merge: true, allow_merge_commit: false,
    allow_rebase_merge: false, squash_merge_commit_title: 'PR_TITLE', ...options.settings };
  const github = {
    rest: {
      pulls: {
        async get() {
          reads++;
          if (options.onRead) options.onRead(pull, reads);
          return { data: structuredClone(pull) };
        },
        async update(value) { calls.push(value); pull.title = value.title; return { data: pull }; },
        listCommits() {},
      },
    },
    async graphql() {
      return { repository: { squashMergeAllowed: settings.allow_squash_merge,
        mergeCommitAllowed: settings.allow_merge_commit, rebaseMergeAllowed: settings.allow_rebase_merge,
        squashMergeCommitTitle: settings.squash_merge_commit_title } };
    },
    async paginate() {
      return (options.commits || []).map((message) => ({ commit: { message } }));
    },
  };
  const context = { repo: { owner: 'example', repo: 'consumer' },
    payload: { pull_request: { number: 7, title: 'stale payload title' } } };
  return { pull, calls, github, context,
    run: (env = {}) => runWorkflow(workflow, { github, context, env }) };
}

for (const [before, after] of [
  ['feat(sharing): add access', 'feat: add access'],
  ['feat(api)!: replace contract', 'feat!: replace contract'],
  ['FIX!: repair crash', 'fix!: repair crash'],
  ['Draft: WIP: fixup! squash! docs(api):  update   guide ', 'docs: update guide'],
  ['feature: add access', 'feat: add access'],
  ['documentation(readme): update guide', 'docs: update guide'],
  ['fix - repair crash', 'fix: repair crash'],
  ['docs: describe scope (sharing)', 'docs: describe scope (sharing)'],
  ["fix(parser): preserve user's value", "fix: preserve user's value"],
  ['feat: literal $(touch /tmp/never) `text`', 'feat: literal $(touch /tmp/never) `text`'],
]) {
  test(`normalizes ${JSON.stringify(before)}`, async () => {
    const f = fixture(before);
    await f.run();
    assert.equal(f.pull.title, after);
    assert.ok(f.calls.every((call) => Object.keys(call).sort().join() === 'owner,pull_number,repo,title'));
  });
}

test('an already normalized title is idempotent', async () => {
  const f = fixture('docs: update guide');
  await f.run();
  await f.run();
  assert.equal(f.calls.length, 0);
});
test('uses a clear title verb before the branch type', async () => {
  const f = fixture('fix the crash', { branch: 'feat/new-screen' });
  await f.run();
  assert.equal(f.pull.title, 'fix: fix the crash');
});
test('uses a recognized branch for an untyped title', async () => {
  const f = fixture('refresh the interface', { branch: 'feature/interface' });
  await f.run();
  assert.equal(f.pull.title, 'feat: refresh the interface');
});
test('uses one unambiguous commit type without rewriting commits', async () => {
  const commits = ['fix(parser): repair date', 'fix: cover boundary'];
  const f = fixture('refresh behavior', { commits });
  await f.run();
  assert.equal(f.pull.title, 'fix: refresh behavior');
  assert.deepEqual(commits, ['fix(parser): repair date', 'fix: cover boundary']);
});
test('mixed commit types use the configured fallback', async () => {
  const f = fixture('refresh behavior', { commits: ['fix: repair', 'docs: describe'] });
  await f.run({ DEFAULT_TYPE: 'refactor' });
  assert.equal(f.pull.title, 'refactor: refresh behavior');
});
test('the default fallback is chore', async () => {
  const f = fixture('refresh behavior');
  await f.run();
  assert.equal(f.pull.title, 'chore: refresh behavior');
});
test('a hyphenated plain title is not an unsupported type', async () => {
  const f = fixture('Cross-platform compatibility');
  await f.run();
  assert.equal(f.pull.title, 'chore: Cross-platform compatibility');
});
for (const title of ['feat(api): ', 'WIP: Draft: ', 'release: next version', 'feat(api: invalid']) {
  test(`rejects an invalid title ${JSON.stringify(title)}`, async () => {
    const f = fixture(title);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  });
}
test('rejects an invalid default type before mutation', async () => {
  const f = fixture('refresh behavior');
  await assert.rejects(f.run({ DEFAULT_TYPE: 'arbitrary' }), /default_type/);
  assert.equal(f.calls.length, 0);
});
test('closed PRs are not modified', async () => {
  const f = fixture('feat(api): old change', { pull: { state: 'closed' } });
  await f.run();
  assert.equal(f.calls.length, 0);
});
test('requires a pull request event', async () => {
  await assert.rejects(runWorkflow(workflow, { github: {}, context: { payload: {} } }), /pull request event/);
});
for (const field of ['title', 'head', 'state']) {
  test(`does not overwrite a concurrent ${field} change`, async () => {
    const f = fixture('feat(api): change', { onRead(pull, read) {
      if (read === 2) {
        if (field === 'head') pull.head.sha = 'head-2';
        else pull[field] = field === 'state' ? 'closed' : 'fix: newer human decision';
      }
    } });
    await assert.rejects(f.run(), /changed before normalization/);
    assert.equal(f.calls.length, 0);
  });
}
test('does not certify a changed head after the update', async () => {
  const f = fixture('feat(api): change', { onRead(pull, read) {
    if (read === 3) pull.head.sha = 'head-2';
  } });
  await assert.rejects(f.run(), /changed during validation/);
});
test('does not certify a changed title when no mutation was needed', async () => {
  const f = fixture('feat: change', { onRead(pull, read) {
    if (read === 2) pull.title = 'feat(api): newer title';
  } });
  await assert.rejects(f.run(), /changed during validation/);
});
test('rechecks the head after the repository settings lookup', async () => {
  const f = fixture('feat: change');
  const get = f.github.graphql;
  f.github.graphql = async () => {
    f.pull.head.sha = 'head-after-settings';
    return get();
  };
  await assert.rejects(f.run(), /changed during validation/);
});
for (const settings of [
  { allow_squash_merge: false }, { allow_merge_commit: true },
  { allow_rebase_merge: true }, { squash_merge_commit_title: 'COMMIT_OR_PR_TITLE' },
]) {
  test(`requires the final squash policy ${JSON.stringify(settings)}`, async () => {
    const f = fixture('feat: change', { settings });
    await assert.rejects(f.run(), /squash-only/);
  });
}
test('consumers may explicitly opt out of the squash setting check', async () => {
  const f = fixture('docs: guide', { settings: { allow_merge_commit: true } });
  await f.run({ REQUIRE_SQUASH_SETTINGS: 'false' });
});
test('optional body validation is applied to current metadata', async () => {
  const f = fixture('docs: guide', { pull: { body: ' ' } });
  await assert.rejects(f.run({ REQUIRE_DESCRIPTION: 'true' }), /description/);
});
test('optional issue validation rejects an unrelated description', async () => {
  const f = fixture('docs: guide', { pull: { body: 'No issue reference.' } });
  await assert.rejects(f.run({ REQUIRE_ISSUE_REFERENCE: 'true' }), /issue reference/);
});
test('optional issue validation accepts a cross-repository issue URL', async () => {
  const f = fixture('docs: guide', { pull: { body: 'Refs https://github.com/example/other/issues/25' } });
  await f.run({ REQUIRE_ISSUE_REFERENCE: 'true' });
});
test('boolean input errors cannot silently disable a policy', async () => {
  const f = fixture('docs: guide');
  await assert.rejects(f.run({ REQUIRE_SQUASH_SETTINGS: 'yes' }), /true or false/);
});
