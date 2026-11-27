const assert = require('node:assert/strict');
const test = require('node:test');
const template = require('../.github/ruleset/default-branch-ruleset.json');
const { syncRepositories } = require('../scripts/sync-repositories.cjs');

const owner = 'octocat';
const inventoryRoute = '/user/repos?affiliation=owner&per_page=100';
const repositoryRoute = `/repos/${owner}/workflows`;
const rulesetsRoute = `${repositoryRoute}/rulesets`;
const listRulesetsRoute = `${rulesetsRoute}?includes_parents=false&per_page=100`;

function mockGitHub({
  settings, excluded = [], rulesets = [], rulesetsError,
} = {}) {
  const repository = {
    id: 123,
    name: 'workflows',
    full_name: `${owner}/workflows`,
    owner: { login: owner, type: 'User' },
    permissions: { admin: true },
    default_branch: 'main',
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'PR_BODY',
    ...settings,
  };
  const reads = [];
  const writes = [];
  const installedRulesets = [...rulesets];
  async function api(method, route, body) {
    if (method === 'GET') reads.push(route);
    else writes.push([method, route, body]);
    switch (`${method} ${route}`) {
      case 'GET /user':
        return { login: owner, type: 'User' };
      case `GET ${inventoryRoute}`:
        return [repository, ...excluded];
      case `GET ${repositoryRoute}`:
        return { ...repository };
      case `GET ${listRulesetsRoute}`:
        if (rulesetsError) throw rulesetsError;
        return installedRulesets.map(({ rules, ...summary }) => summary);
      case `PATCH ${repositoryRoute}`:
        Object.assign(repository, body);
        return { ...repository };
      case `POST ${rulesetsRoute}`: {
        const created = { ...body, id: 100, source_type: 'Repository', source: repository.full_name };
        installedRulesets.push(created);
        return created;
      }
      default: {
        const ruleset = installedRulesets.find(({ id }) => route === `${rulesetsRoute}/${id}`);
        if (method === 'GET' && ruleset) return ruleset;
        throw new Error(`Unexpected API request: ${method} ${route}`);
      }
    }
  }
  return { reads, writes, run: (options) => syncRepositories({ owner, api, ...options }) };
}

test('previews eligible personal repositories without changing GitHub', async () => {
  const excluded = [
    { name: 'fork', fork: true },
    { name: 'archive', archived: true },
    { name: 'disabled', disabled: true },
  ].map((repo) => ({
    ...repo,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, type: 'User' },
    permissions: { admin: true },
  }));
  const { reads, writes, run } = mockGitHub({
    excluded, settings: { delete_branch_on_merge: false },
  });

  await run();

  assert.ok(reads.includes(inventoryRoute));
  assert.ok(reads.includes(listRulesetsRoute));
  assert.ok(excluded.every(({ full_name }) => !reads.includes(`/repos/${full_name}`)));
  assert.deepEqual(writes, []);
});

test('rejects requests for another account before inspecting any repositories', async () => {
  const { reads, writes, run } = mockGitHub();

  await assert.rejects(run({ owner: 'somebody-else', apply: true }), /Authenticate as somebody-else/);

  assert.deepEqual(reads, ['/user']);
  assert.deepEqual(writes, []);
});

test('applies changed settings, installs the disabled template and leaves a second run with no work', async () => {
  const { writes, run } = mockGitHub({
    settings: { delete_branch_on_merge: false, allow_merge_commit: true },
  });

  await run({ apply: true });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.find(([method]) => method === 'PATCH'), [
    'PATCH', repositoryRoute, { delete_branch_on_merge: true, allow_merge_commit: false },
  ]);
  assert.deepEqual(writes.find(([method]) => method === 'POST'), [
    'POST', rulesetsRoute, template,
  ]);
  assert.equal(template.enforcement, 'disabled');

  writes.length = 0;
  await run({ apply: true });
  assert.deepEqual(writes, []);
});

test('preserves an existing active ruleset and sends the title with a new squash message', async () => {
  const { writes, run } = mockGitHub({
    settings: { squash_merge_commit_message: 'BLANK' },
    rulesets: [{
      name: template.name, id: 12, target: 'branch', enforcement: 'active',
      source_type: 'Repository', source: `${owner}/workflows`,
    }],
  });

  await run({ apply: true });

  assert.deepEqual(writes, [
    ['PATCH', repositoryRoute, {
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'PR_BODY',
    }],
  ]);
});

test('avoids enforcing squash-only when an active rule disallows squash', async () => {
  const { reads, writes, run } = mockGitHub({
    settings: { allow_squash_merge: false, allow_merge_commit: true, delete_branch_on_merge: false },
    rulesets: [{
      id: 42,
      name: 'Staff',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Repository',
      rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }],
    }],
  });

  await run({ apply: true });

  assert.ok(reads.includes(`${rulesetsRoute}/42`));
  assert.deepEqual(writes.filter(([method]) => method === 'PATCH'), [
    ['PATCH', repositoryRoute, { delete_branch_on_merge: true }],
  ]);
});

test('does not create a ruleset when existing rulesets could not be listed', async () => {
  const { reads, writes, run } = mockGitHub({
    rulesetsError: new Error('HTTP 403: Rulesets are unavailable'),
  });

  const [result] = await run({ apply: true });

  assert.ok(reads.includes(listRulesetsRoute));
  assert.match(result.error, /Rulesets are unavailable/);
  assert.deepEqual(writes, []);
});
