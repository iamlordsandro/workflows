# Adopt the shared workflows

## Configure one consumer

1. Allow the public `iamlordsandro/workflows` repository and the pinned official actions in the consumer's Actions policy.
2. Allow squash merging; disable merge commits and rebase merging. Select the PR title as the default squash commit title and optionally the PR description as its body. These are repository settings, not a rewrite of existing commits.
3. Copy [the PR caller](../examples/pull-request.yml) to `.github/workflows/pull-request.yml`. Remove or disable the consumer's previous normalizer, labeler and assignment callers in the same reviewed change to avoid competing writers.
4. Confirm that configured labels exist. The defaults use GitHub's standard `bug`, `enhancement` and `documentation` labels. To customize paths or label names, pass JSON inputs to the labeler.
5. Open a test PR and wait for the title policy, labels and assignment. Inspect the actual check names before configuring branch protection: reusable callers add job-name prefixes.
6. Require the successful title policy check and the project's normal CI on the default branch. Require pull requests and disallow force pushes. Keep the consumer's existing review policy.
7. Optionally copy [the quality caller](../examples/quality.yml). Its jobs run with read-only permissions and do not require secrets.

The title policy requests only metadata access and PR write permission. Labeling and assignment additionally need issue write permission. Never grant a privileged metadata workflow a checkout of PR code, a caller-provided shell command or inherited deployment credentials.

## Event behavior

Use `pull_request_target` for metadata updates, including fork PRs, only when allowed by the consumer's Actions security policy. The workflow never executes code from the PR. If that event is restricted, an owner must permit the safe metadata workflow or update the title manually and arrange an allowed validation path; fork write automation is not guaranteed by this library alone.

Normalization and validation happen in the same job. Updating a title with `GITHUB_TOKEN` does not trigger another workflow run, so a second `edited` workflow is not required to make the normalized result pass. The caller serializes metadata runs; the policy re-reads the live title and head before writing and after the settings lookup. Concurrent changes observed during those reads fail instead of certifying an earlier snapshot; the reads are not an atomic lock against later edits.

The final commit policy applies to the new squash commit. Intermediate commits may retain their original messages. No force push or history rewrite is performed. Configure `require_squash_settings: false` only for consumers that intentionally use a different merge policy.

## Versions and migration

Use `@v1` for compatible shared updates, or pin an exact release tag or commit SHA. The library must publish the referenced version before a consumer adopts it.

Start with one consumer, verify its real PR checks and final squash message, then migrate the remaining repositories in separate reviewed changes. Keep Igevia/Bostrom build, release, infrastructure and deployment workflows in their existing libraries.

## References

- [Reusable workflow access and permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [Squash merge message configuration](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)
- [The GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token)
