# Adopt the shared workflows

## Configure one consumer

1. Allow the public `iamlordsandro/workflows` repository and the pinned official actions in the consumer's Actions policy.
2. Allow squash merging; disable merge commits and rebase merging. Select the PR title as the default squash commit title and optionally the PR description as its body. These are repository settings, not a rewrite of existing commits.
3. Enable **Automatically delete head branches** under **Settings → General → Pull Requests**, or run `gh repo edit OWNER/REPOSITORY --delete-branch-on-merge`. GitHub applies this repository setting to merged PR head branches where branch protections allow deletion. See [automatic branch deletion](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches).
4. Copy [the PR caller](../examples/pull-request.yml) to `.github/workflows/pull-request.yml`. Remove or disable the consumer's previous normalizer, labeler and assignment callers in the same reviewed change to avoid competing writers.
5. Confirm that configured labels exist. The defaults use GitHub's standard `bug`, `enhancement` and `documentation` labels. To customize paths or label names, pass JSON inputs to the labeler.
6. Open a test PR and wait for the title policy, labels and assignment. Inspect the actual check names before configuring branch protection: reusable callers add job-name prefixes.
7. Require the successful title policy check and the project's normal CI on the default branch. Require pull requests and disallow force pushes. Keep the consumer's existing review policy.
8. Optionally copy [the quality caller](../examples/quality.yml). Its jobs run with read-only permissions and do not require secrets.

The title policy requests only metadata access and PR write permission. Labeling and assignment additionally need issue write permission. Never grant a privileged metadata workflow a checkout of PR code, a caller-provided shell command or inherited deployment credentials.

## Import the default-branch ruleset

1. Open **Settings → Rules → Rulesets → New ruleset → Import a ruleset** in the consumer repository and select [the ruleset JSON](../.github/ruleset/default-branch-ruleset.json).
2. Review the disabled ruleset against existing protections. It targets the default branch, requires a pull request and squash merge, blocks force pushes and deletion, and has no bypass actors. Preserve the existing review requirements.
3. Configure the repository to use the PR title for squash commit titles. Run a test PR and match each required check to an actual job in the destination repository before enabling the ruleset.

For personal repositories, you can import the file in bulk with the script below. An eligible organization can target multiple repositories through an [organization ruleset](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization). GitHub documents [plan availability and import steps](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository).

The template preconfigures the same three GitHub Actions checks as this library and requires branches to be up to date.

| Check | Consumer setup |
| --- | --- |
| `Policy / Normalize and Validate PR` | The [PR caller](../examples/pull-request.yml) uses the `Policy` prefix. With the published `@v1` pin, select `Policy / Normalize and Validate PR`. |
| `Quality / Workflow Syntax and Markdown Local File Targets` | The [quality caller](../examples/quality.yml) uses the `Quality` prefix. With the published `@v1` pin, select `Quality / Workflow syntax and Markdown local file targets`. |
| `Workflow Contract Tests` | Select the destination project's required test job if it has a different name. |

Use the title policy to validate the PR title. GitHub applies [commit-message rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#adding-metadata-restrictions) to every branch commit in a squash merge.

## Synchronize personal repositories

Run [the sync script](../scripts/sync-repositories.cjs) with Node.js 20 or later and a current GitHub CLI authenticated as the personal account owner. It uses the CLI's existing authentication. Applying changes requires write access to repository administration.

```sh
node scripts/sync-repositories.cjs --owner iamlordsandro
node scripts/sync-repositories.cjs --owner iamlordsandro --repo cv-builder --apply
```

The first command prints a JSON preview. Repeat `--repo` to select multiple repositories, or omit it to include all repositories visible to the CLI that the account owns. The script skips forks, archived and disabled repositories, and repositories without admin access.

With `--apply`, the script enables automatic deletion of merged PR branches and configures squash-only merges using the PR title and description. If an active branch ruleset prevents squash merging, it reports the conflict and leaves that repository's merge settings as they are. It imports the shared ruleset disabled wherever a repository ruleset with the same name is absent. Existing rulesets are preserved. Review each repository's checks and enable its imported ruleset when ready.

The same report records applied settings, ruleset creation, and per-repository errors. The script continues with the remaining repositories and exits with a nonzero status if it detects any errors or merge conflicts.

## Event behavior

Use `pull_request_target` for metadata updates, including fork PRs, only when allowed by the consumer's Actions security policy. The workflow never executes code from the PR. If that event is restricted, an owner must permit the safe metadata workflow or update the title manually and arrange an allowed validation path; fork write automation is not guaranteed by this library alone.

For public repositories, check the [Actions event policy](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#default-policy-for-pull_request_target) before making the title check required. If the default policy blocks the event, scope any allowance to the metadata caller and verify it on a test PR.

Normalization and validation happen in the same job. Updating a title with `GITHUB_TOKEN` does not trigger another workflow run, so a second `edited` workflow is not required to make the normalized result pass. The caller serializes metadata runs; the policy re-reads the live title and head before writing and after the settings lookup. Concurrent changes observed during those reads fail instead of certifying an earlier snapshot; the reads are not an atomic lock against later edits.

The title policy checks the default squash commit title setting and the PR title. The proposed squash message is editable at merge time. The workflow preserves contributor commits and their original messages. Configure `require_squash_settings: false` only for consumers that intentionally use a different merge policy.

For large pull requests, title inference uses the configured default type when GitHub returns an incomplete commit list. Path labeling stops before changing labels when GitHub cannot return the complete changed-file list.

## Versions and migration

Use `@v1` for compatible shared updates, or pin an exact release tag or commit SHA. The library must publish the referenced version before a consumer adopts it.

GitHub uses the caller and called job names for a reusable check, such as `Policy / Normalize and Validate PR`. Before changing a workflow pin or job name, plan the required-check migration. Keep existing consumers on their current pins until they can verify and adopt the new contexts. See [GitHub's status check naming rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules#troubleshooting-required-status-checks).

For this library, replace the old Quality requirement after the renamed check passes on the rename PR. Keep the current Policy requirement for that merge because `pull_request_target` loads its workflow from the default branch. After the merge, open a test PR and replace the old Policy requirement once the renamed check passes.

Start with one consumer, verify its real PR checks and final squash message, then migrate the remaining repositories in separate reviewed changes. Use the [Release Please guide](RELEASE.md) when adopting shared versioning. Migrate existing release callers individually, preserving project-specific checks, infrastructure, and deployment workflows.

## References

- [Reusable workflow access and permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [Squash merge message configuration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)
- [The GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token)
