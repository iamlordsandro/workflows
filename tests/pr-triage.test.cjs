const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorkflow } = require('./helpers.cjs');

const labeler = '.github/workflows/pr-labeler.yml';
const assignment = '.github/workflows/pr-assignment.yml';

function apiError(status) {
  return Object.assign(new Error(`API status ${status}`), { status });
}

function fixture(options = {}) {
  const state = {
    title: options.title ?? 'fix: handle missing data',
    labels: (options.labels ?? ['keep-me']).map((name) => ({ name })),
    user: options.author ?? { login: 'alice', type: 'User' },
    assignees: (options.assignees ?? []).map((login) => ({ login })),
  };
  const calls = [];
  const context = {
    repo: { owner: 'example', repo: 'project' },
    payload: { pull_request: { number: 42, title: 'fix: stale event title' } },
  };
  const repoLabels = options.repoLabels ?? ['bug', 'enhancement', 'documentation'];
  const users = { bob: { login: 'bob', type: 'User' }, ...options.users };
  const record = (method, parameters) => calls.push({ method, parameters });
  const current = () => JSON.parse(JSON.stringify(state));
  const github = {
    rest: {
      pulls: {
        async get(parameters) {
          record('pulls.get', parameters);
          return { data: current() };
        },
        async listFiles() {},
      },
      issues: {
        async get(parameters) {
          record('issues.get', parameters);
          return { data: current() };
        },
        async getLabel(parameters) {
          record('issues.getLabel', parameters);
          if (options.labelError) throw apiError(options.labelError);
          const name = repoLabels.find((label) => label.toLowerCase() === parameters.name.toLowerCase());
          if (!name) throw apiError(404);
          return { data: { name } };
        },
        async addLabels(parameters) {
          record('issues.addLabels', parameters);
          state.labels.push(...parameters.labels.map((name) => ({ name })));
          return { data: state.labels };
        },
        async removeLabel(parameters) {
          record('issues.removeLabel', parameters);
          state.labels = state.labels.filter(({ name }) => name.toLowerCase() !== parameters.name.toLowerCase());
          return { data: state.labels };
        },
        async checkUserCanBeAssigned(parameters) {
          record('issues.checkUserCanBeAssigned', parameters);
          if (options.assignmentError) throw apiError(options.assignmentError);
          if ((options.unassignable ?? []).includes(parameters.assignee.toLowerCase())) throw apiError(404);
          return { status: 204 };
        },
        async addAssignees(parameters) {
          record('issues.addAssignees', parameters);
          state.assignees.push(...parameters.assignees.map((login) => ({ login })));
          return { data: current() };
        },
      },
      users: {
        async getByUsername(parameters) {
          record('users.getByUsername', parameters);
          const user = users[parameters.username.toLowerCase()];
          if (!user) throw apiError(404);
          return { data: user };
        },
      },
    },
    async paginate(endpoint, parameters) {
      assert.equal(endpoint, github.rest.pulls.listFiles);
      record('pulls.listFiles', parameters);
      return (options.files ?? ['Sources/App.swift']).map((filename) => ({ filename }));
    },
  };
  const mutations = () => calls.filter(({ method }) =>
    ['issues.addLabels', 'issues.removeLabel', 'issues.addAssignees'].includes(method));
  return { github, context, state, calls, mutations };
}

test('labeler applies existing type and Markdown labels idempotently', async () => {
  const mock = fixture({ title: 'feat: add sharing', files: ['README.md'] });
  await runWorkflow(labeler, mock);
  assert.deepEqual(mock.mutations(), [{
    method: 'issues.addLabels',
    parameters: { owner: 'example', repo: 'project', issue_number: 42, labels: ['enhancement', 'documentation'] },
  }]);
  assert.deepEqual(mock.state.labels.map(({ name }) => name), ['keep-me', 'enhancement', 'documentation']);
  await runWorkflow(labeler, mock);
  assert.equal(mock.mutations().length, 1);
});

test('labeler uses the live title and removes only obsolete controlled type labels', async () => {
  const mock = fixture({ title: 'feat(core)!: change the interface', labels: ['bug', 'keep-me', 'reviewed'] });
  await runWorkflow(labeler, mock);
  assert.deepEqual(mock.state.labels.map(({ name }) => name), ['keep-me', 'reviewed', 'enhancement']);
  assert.deepEqual(mock.mutations().map(({ method }) => method), ['issues.addLabels', 'issues.removeLabel']);
  assert.equal(mock.calls.filter(({ method }) => method === 'pulls.get').length, 1);
  assert.equal(mock.mutations()[1].parameters.name, 'bug');
});

test('documentation selected by paths survives a type change', async () => {
  const mock = fixture({ title: 'feat: add sharing', labels: ['documentation'], files: ['docs/sharing.md'] });
  await runWorkflow(labeler, mock);
  assert.deepEqual(mock.state.labels.map(({ name }) => name), ['documentation', 'enhancement']);
  assert.equal(mock.mutations().some(({ method }) => method === 'issues.removeLabel'), false);
});

test('custom paths support globstar, question marks and literal regex characters', async () => {
  const mock = fixture({
    title: 'perf: reduce allocations',
    labels: [],
    repoLabels: ['Performance', 'ci', 'configuration'],
    files: ['.github/workflows/check.yml', 'config/a+b1.json'],
  });
  await runWorkflow(labeler, {
    ...mock,
    env: {
      TYPE_LABELS_JSON: '{"perf":"performance"}',
      PATH_LABELS_JSON: '{"ci":[".github/workflows/**/*.y?l"],"configuration":["config/a+b?.json"]}',
    },
  });
  assert.deepEqual(mock.state.labels.map(({ name }) => name), ['Performance', 'ci', 'configuration']);
});

test('path-only labels and unmanaged labels are never removed', async () => {
  const mock = fixture({ title: 'Update the application', labels: ['documentation', 'keep-me'] });
  await runWorkflow(labeler, {
    ...mock, env: { TYPE_LABELS_JSON: '{}', PATH_LABELS_JSON: '{"documentation":["docs/**"]}' },
  });
  assert.deepEqual(mock.mutations(), []);
  assert.deepEqual(mock.state.labels.map(({ name }) => name), ['documentation', 'keep-me']);
});

test('labeler rejects malformed JSON and invalid configuration before API calls', async () => {
  const cases = [
    [{ TYPE_LABELS_JSON: '{' }, /TYPE_LABELS_JSON must contain valid JSON/],
    [{ PATH_LABELS_JSON: 'null' }, /PATH_LABELS_JSON must be a JSON object/],
    [{ TYPE_LABELS_JSON: '[]' }, /TYPE_LABELS_JSON must be a JSON object/],
    [{ TYPE_LABELS_JSON: '{"Fix":"bug"}' }, /type keys/],
    [{ TYPE_LABELS_JSON: '{"fix":42}' }, /label names/],
    [{ PATH_LABELS_JSON: '{"documentation":[]}' }, /non-empty array/],
    [{ PATH_LABELS_JSON: '{"documentation":["docs/{a,b}.md"]}' }, /Path globs support only/],
    [{ PATH_LABELS_JSON: '{"documentation":["docs/**/../secret"]}' }, /Path globs support only/],
  ];
  for (const [env, expected] of cases) {
    const mock = fixture();
    await assert.rejects(runWorkflow(labeler, { ...mock, env }), expected);
    assert.deepEqual(mock.calls, []);
  }
});

test('a missing configured label fails clearly without creating or changing labels', async () => {
  const mock = fixture({ repoLabels: ['enhancement', 'documentation'] });
  await assert.rejects(runWorkflow(labeler, mock), /Configured label "bug" does not exist.*Create it before/);
  assert.deepEqual(mock.mutations(), []);
});

test('label API errors other than 404 propagate without mutation', async () => {
  const mock = fixture({ labelError: 503 });
  await assert.rejects(runWorkflow(labeler, mock), { status: 503 });
  assert.deepEqual(mock.mutations(), []);
});

test('assignment adds the author and validated extras once and preserves existing assignees', async () => {
  const mock = fixture({ assignees: ['reviewer'] });
  const options = { ...mock, env: { EXTRA_ASSIGNEES_JSON: '["BOB","alice","bob"]' } };
  await runWorkflow(assignment, options);
  assert.deepEqual(mock.state.assignees.map(({ login }) => login), ['reviewer', 'alice', 'bob']);
  assert.deepEqual(mock.mutations(), [{
    method: 'issues.addAssignees',
    parameters: { owner: 'example', repo: 'project', issue_number: 42, assignees: ['alice', 'bob'] },
  }]);
  await runWorkflow(assignment, options);
  assert.equal(mock.mutations().length, 1);
  assert.equal(mock.calls.some(({ method }) => method === 'pulls.get'), false);
});

test('assignment skips a bot author and bot extras while assigning human extras', async () => {
  const messages = [];
  const mock = fixture({
    author: { login: 'renovate[bot]', type: 'Bot' },
    users: { robot: { login: 'robot', type: 'Bot' } },
  });
  await runWorkflow(assignment, {
    ...mock,
    env: { EXTRA_ASSIGNEES_JSON: '["bob","robot","dependabot[bot]"]' },
    core: { info: (message) => messages.push(message) },
  });
  assert.deepEqual(mock.state.assignees, [{ login: 'bob' }]);
  assert.equal(messages.length, 3);
  assert.deepEqual(mock.calls.filter(({ method }) => method === 'issues.checkUserCanBeAssigned')
    .map(({ parameters }) => parameters.assignee), ['bob']);
});

test('an unassignable author is skipped without dropping valid extras', async () => {
  const mock = fixture({ unassignable: ['alice'] });
  await runWorkflow(assignment, { ...mock, env: { EXTRA_ASSIGNEES_JSON: '["bob"]' } });
  assert.deepEqual(mock.state.assignees, [{ login: 'bob' }]);
});

test('assignment rejects invalid JSON and usernames before API calls', async () => {
  const cases = [
    ['[', /must contain valid JSON/],
    ['{}', /must be an array/],
    ['[42]', /must be an array/],
    ['["@bob"]', /Invalid extra assignee/],
    ['["bad name[bot]"]', /Invalid extra assignee/],
  ];
  for (const [value, expected] of cases) {
    const mock = fixture();
    await assert.rejects(runWorkflow(assignment, {
      ...mock, env: { EXTRA_ASSIGNEES_JSON: value },
    }), expected);
    assert.deepEqual(mock.calls, []);
  }
});

test('nonexistent and unassignable extras fail before adding any assignee', async () => {
  for (const [options, login, expected] of [
    [{}, 'missing', /Extra assignee "missing" does not exist/],
    [{ unassignable: ['bob'] }, 'bob', /Extra assignee "bob" cannot be assigned/],
  ]) {
    const mock = fixture(options);
    await assert.rejects(runWorkflow(assignment, {
      ...mock, env: { EXTRA_ASSIGNEES_JSON: JSON.stringify([login]) },
    }), expected);
    assert.deepEqual(mock.mutations(), []);
  }
});

test('assignment does not treat a server failure as an unassignable author', async () => {
  const mock = fixture({ assignmentError: 503 });
  await assert.rejects(runWorkflow(assignment, mock), { status: 503 });
  assert.deepEqual(mock.mutations(), []);
});

test('both reusable workflows require a pull request context', async () => {
  for (const workflow of [labeler, assignment]) {
    const mock = fixture();
    mock.context.payload = {};
    await assert.rejects(runWorkflow(workflow, mock), /requires a pull_request event/);
    assert.deepEqual(mock.calls, []);
  }
});
