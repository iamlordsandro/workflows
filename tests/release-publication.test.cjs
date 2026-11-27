const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../release-please-config.json');
const { runWorkflow } = require('./helpers.cjs');

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const annotatedSha = 'c'.repeat(40);
const repo = { owner: 'owner', repo: 'workflows' };
const tag = 'v1.2.3';
const draft = { id: 42, draft: true, tag_name: tag, target_commitish: sha };

function mockPublication({ releases = [draft], existingTag, tagError } = {}) {
  const writes = [];
  const outputs = {};
  const github = {
    rest: {
      git: {
        async getRef(params) {
          assert.deepEqual(params, { ...repo, ref: `tags/${tag}` });
          if (tagError) throw tagError;
          if (existingTag) return { data: { object: existingTag } };
          throw Object.assign(new Error('Not found'), { status: 404 });
        },
        async getTag(params) {
          assert.deepEqual(params, { ...repo, tag_sha: annotatedSha });
          return { data: { object: { type: 'commit', sha } } };
        },
        async createRef(params) {
          writes.push(['createRef', params]);
          return { data: { object: { type: 'commit', sha } } };
        },
      },
      repos: {
        async getContent(params) {
          assert.deepEqual(params, { ...repo, path: '.release-please-manifest.json', ref: sha });
          return { data: { content: Buffer.from('{".":"1.2.3"}').toString('base64') } };
        },
        listReleases: Symbol('listReleases'),
        async updateRelease(params) {
          writes.push(['updateRelease', params]);
        },
      },
    },
    async paginate(method, params) {
      assert.equal(method, github.rest.repos.listReleases);
      assert.deepEqual(params, { ...repo, per_page: 100 });
      return releases;
    },
  };
  const run = () => runWorkflow('.github/workflows/ci.yml', {
    github, context: { repo, sha },
    core: { setOutput: (name, value) => { outputs[name] = value; } },
  });
  return { run, writes, outputs };
}

test('Release Please only stages drafts and leaves tags for the tested commit gate', () => {
  assert.equal(config.draft, true);
  assert.equal(config['force-tag-creation'], false);
  assert.deepEqual(Object.keys(config.packages), ['.']);
  for (const settings of Object.values(config.packages)) {
    assert.equal(settings.draft ?? config.draft, true);
    assert.equal(settings['force-tag-creation'] ?? config['force-tag-creation'], false);
  }
});

test('publishes a draft with an exact tag and SHA before preparing the next release', async () => {
  const { run, writes, outputs } = mockPublication();
  await run();
  assert.deepEqual(writes, [
    ['createRef', { ...repo, ref: `refs/tags/${tag}`, sha }],
    ['updateRelease', { ...repo, release_id: 42, tag_name: tag, target_commitish: sha, draft: false }],
  ]);
  assert.equal(outputs.prepare, 'true');
});

test('leaves drafts for other commits and versions untouched', async () => {
  const { run, writes, outputs } = mockPublication({ releases: [
    { ...draft, target_commitish: otherSha },
    { ...draft, tag_name: 'v1.2.4' },
    { ...draft, draft: false },
  ] });
  await run();
  assert.deepEqual(writes, []);
  assert.equal(outputs.prepare, 'false');
});

test('can prepare the next release without publishing when there is no pending draft', async () => {
  const { run, writes, outputs } = mockPublication({ releases: [{ ...draft, draft: false }] });
  await run();
  assert.deepEqual(writes, []);
  assert.equal(outputs.prepare, 'true');
});

test('publishes after a retry with an existing tag at the tested commit', async () => {
  const { run, writes } = mockPublication({ existingTag: { type: 'tag', sha: annotatedSha } });
  await run();
  assert.deepEqual(writes, [
    ['updateRelease', { ...repo, release_id: 42, tag_name: tag, target_commitish: sha, draft: false }],
  ]);
});

test('rejects a tag at a different commit before publishing', async () => {
  const { run, writes } = mockPublication({ existingTag: { type: 'commit', sha: otherSha } });
  await assert.rejects(run, /does not point to the tested commit/);
  assert.deepEqual(writes, []);
});

test('treats a tag lookup error as a failure', async () => {
  const { run, writes } = mockPublication({ tagError: new Error('Tag API unavailable') });
  await assert.rejects(run, /Tag API unavailable/);
  assert.deepEqual(writes, []);
});
