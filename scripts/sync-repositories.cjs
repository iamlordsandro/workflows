const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const rulesetTemplate = require('../.github/ruleset/default-branch-ruleset.json');

const mergeMethods = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
};

const settings = {
  delete_branch_on_merge: true,
  ...mergeMethods,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
};

const usage = 'Usage: node scripts/sync-repositories.cjs --owner OWNER [--repo REPO ...] [--apply]';
const listRepositories = '/user/repos?affiliation=owner&per_page=100';

function sameName(first, second) {
  return first.toLowerCase() === second.toLowerCase();
}

function skipReason(repo) {
  if (repo.archived) return 'archived';
  if (repo.fork) return 'fork';
  if (repo.disabled) return 'disabled';
  if (repo.permissions?.admin !== true) return 'requires repository admin access';
}

async function syncRepository(repo, { apply, api }) {
  const route = `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
  const result = { repository: repo.full_name, settings: {}, ruleset: null };
  const skip = skipReason(repo);
  if (skip) return { ...result, skip };

  try {
    const current = await api('GET', route);
    if (!sameName(current.full_name, repo.full_name) || current.id !== repo.id) {
      throw new Error('Repository owner, name, or ID changed during discovery.');
    }
    const reason = skipReason(current);
    if (reason) return { ...result, skip: reason };

    const rulesets = await api('GET', `${route}/rulesets?includes_parents=false&per_page=100`);
    const existing = rulesets.find(({ name }) => sameName(name, rulesetTemplate.name));
    result.ruleset = existing
      ? { action: 'preserve', id: existing.id, enforcement: existing.enforcement }
      : { action: 'create', enforcement: rulesetTemplate.enforcement };

    for (const [key, value] of Object.entries(settings)) {
      if (typeof current[key] !== typeof value) {
        throw new Error(`GitHub did not return the current value of ${key}.`);
      }
      if (current[key] !== value) result.settings[key] = { from: current[key], to: value };
    }

    if (Object.keys(mergeMethods).some((key) => key in result.settings)) {
      const activeBranchRulesets = rulesets.filter(({ enforcement, target }) =>
        enforcement === 'active' && target === 'branch');
      for (const ruleset of activeBranchRulesets) {
        const { rules } = await api('GET', `${route}/rulesets/${ruleset.id}`);
        if (!Array.isArray(rules)) throw new Error(`GitHub did not return the rules in ${ruleset.name}.`);
        if (rules.some(({ type, parameters }) => type === 'pull_request' &&
          parameters?.allowed_merge_methods?.includes('squash') === false)) {
          result.mergeConflict = `Active ruleset ${ruleset.name} disallows squash merging.`;
          for (const key of Object.keys(result.settings)) {
            if (key !== 'delete_branch_on_merge') delete result.settings[key];
          }
          break;
        }
      }
    }

    if (apply) {
      const patch = Object.fromEntries(Object.entries(result.settings).map(([key, { to }]) => [key, to]));
      if ('squash_merge_commit_message' in patch) {
        patch.squash_merge_commit_title = settings.squash_merge_commit_title;
      }
      if (Object.keys(patch).length) {
        const updated = await api('PATCH', route, patch);
        if (!Object.entries(patch).every(([key, value]) => updated[key] === value)) {
          throw new Error('GitHub did not confirm all repository settings.');
        }
        result.settingsApplied = true;
      }
      if (!existing) {
        const created = await api('POST', `${route}/rulesets`, rulesetTemplate);
        if (created.name !== rulesetTemplate.name || created.enforcement !== rulesetTemplate.enforcement) {
          throw new Error('GitHub did not confirm creation of the disabled ruleset.');
        }
        result.ruleset = { ...result.ruleset, action: 'created', id: created.id };
      }
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function syncRepositories({ owner, repos = [], apply = false, api }) {
  if (rulesetTemplate.enforcement !== 'disabled') {
    throw new Error('The shared ruleset must be disabled before importing it.');
  }
  const viewer = await api('GET', '/user');
  if (!sameName(viewer.login, owner) || viewer.type !== 'User') {
    throw new Error(`Authenticate as ${owner} to synchronize repositories owned by that personal account.`);
  }

  const owned = (await api('GET', listRepositories)).filter((repo) => sameName(repo.owner.login, owner));
  const requested = new Set(repos.map((name) => name.toLowerCase()));
  const selected = owned.filter((repo) => requested.size === 0 || requested.has(repo.name.toLowerCase()));
  for (const repo of selected) requested.delete(repo.name.toLowerCase());
  if (requested.size) throw new Error(`Repositories not found for ${owner}: ${[...requested].join(', ')}`);

  const results = [];
  for (const repo of selected) {
    results.push(await syncRepository(repo, { apply, api }));
  }
  return results;
}

let lastWrite = 0;

async function githubApi(method, route, body) {
  const args = ['api', '--hostname', 'github.com', '--method', method, route.slice(1)];
  const paginated = route.endsWith('per_page=100');
  if (paginated) args.push('--paginate', '--slurp');
  if (body) {
    args.push('--input', '-');
    const wait = lastWrite + 1000 - Date.now();
    if (wait > 0) await delay(wait);
  }
  let output;
  try {
    output = execFileSync('gh', args, {
      input: body && JSON.stringify(body),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 45000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`${method} ${route}: ${detail}`);
  } finally {
    if (body) lastWrite = Date.now();
  }
  const response = JSON.parse(output);
  return paginated ? response.flat() : response;
}

async function main() {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      repo: { type: 'string', multiple: true },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.owner) throw new Error(usage);

  const results = await syncRepositories({
    owner: values.owner,
    repos: values.repo,
    apply: values.apply,
    api: githubApi,
  });
  console.log(JSON.stringify({ owner: values.owner, mode: values.apply ? 'apply' : 'dry-run', results }, null, 2));
  if (results.some(({ error, mergeConflict }) => error || mergeConflict)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { syncRepositories };
