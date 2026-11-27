const test = require('node:test');
const assert = require('node:assert/strict');
const { runWorkflow } = require('./helpers.cjs');

async function outputs(path, values) {
  const result = {};
  await runWorkflow('.github/workflows/release-please.yml', {
    env: { PACKAGE_PATH: path, RELEASE_OUTPUTS: JSON.stringify(values) },
    core: { setOutput: (key, value) => { result[key] = value; } },
  });
  return result;
}

test('preserves the version, tag, and commit reported by Release Please', async () => {
  const release = { release_created: 'true', version: '1.2.3', tag_name: 'v1.2.3', sha: 'tested-commit' };
  assert.deepEqual(await outputs('.', release), release);
});

test('selects a package without treating another package release as its own', async () => {
  const values = { release_created: 'true', 'packages/core--release_created': 'true',
    'packages/core--version': '0.3.0', 'packages/core--tag_name': 'core-v0.3.0',
    'packages/core--sha': 'core-commit' };
  assert.deepEqual(await outputs('packages/core', values), {
    release_created: 'true', version: '0.3.0', tag_name: 'core-v0.3.0', sha: 'core-commit',
  });
  assert.deepEqual(await outputs('packages/web', values), {
    release_created: 'false', version: '', tag_name: '', sha: '',
  });
});
