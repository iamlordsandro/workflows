# Shared GitHub workflows

Versioned repository automation for projects owned by `iamlordsandro`. This public library contains generic workflow code; credentials stay in consumer repositories or environments.

## Workflows

| Workflow | Purpose |
| --- | --- |
| [`pr-title-normalize.yml`](.github/workflows/pr-title-normalize.yml) | Normalize and validate the live PR title and final squash merge configuration in one job. |
| [`pr-labeler.yml`](.github/workflows/pr-labeler.yml) | Apply configurable type and path labels without changing unrelated labels. |
| [`pr-assignment.yml`](.github/workflows/pr-assignment.yml) | Assign the author and configured eligible users; skip bots. |
| [`workflow-quality.yml`](.github/workflows/workflow-quality.yml) | Run actionlint and check local file targets in Markdown. |
| [`release-please.yml`](.github/workflows/release-please.yml) | Run Release Please with the caller's manifest, optional auto-merge, and release outputs. |

## Final commits on main

PR titles use `type: subject` or `type!: subject`, without a scope. For example, `feat(sharing): add request handling` becomes `feat: add request handling`, while `feat(sharing)!: replace the API` becomes `feat!: replace the API`.

The normalizer trims WIP/Draft/fixup/squash prefixes, whitespace and known type aliases. For an untyped title, a clear leading verb takes precedence over the branch type, then an unambiguous type from commit subjects, then `chore`. It preserves the subject language and does not invent a product summary.

Configure the consumer to allow **only squash merges**, with the **PR title** as the default squash commit title, including single-commit PRs. Make the title policy a required check on the default branch. The workflow validates those repository settings by default. GitHub proposes the normalized title for the squash commit and lets the person merging edit the message. The workflow preserves all contributor commits and their SHAs.

## Adoption

Follow [the adoption guide](docs/ADOPTION.md). Each consumer installs a small [PR caller](examples/pull-request.yml) and optionally a [quality caller](examples/quality.yml); creating this library does not activate workflows in other repositories.

Use the [default-branch ruleset](.github/ruleset/default-branch-ruleset.json) to start with pull requests, squash-only merges, protection against deletion and force pushes, and this repository's three required checks. Review the check names for the destination repository before enabling it.

Consumers can use a public library from public or private repositories. `@v1` tracks compatible releases; use an exact release tag or commit SHA when explicit upgrades are required. New features must be tested against an actual consumer before updating the major alias.

Use the [Release Please guide](docs/RELEASE.md) for versioning and publication. Builds and deployments remain with each consumer.

## Inputs

The title policy accepts `default_type` (`chore`), `require_description` (`false`), `require_issue_reference` (`false`) and `require_squash_settings` (`true`). Unsupported types, empty subjects, malformed scopes or metadata changed during validation fail clearly.

The labeler accepts `type_labels_json` and `path_labels_json`; use existing labels and configure project-specific paths. Assignment accepts `extra_assignees_json` (`[]`). Quality accepts `docs_root` (`.`). See each workflow for its input schema.

The labeler, assignment, and quality workflows accept an optional `job_name` in versions that declare it. The defaults are `Apply PR Labels`, `Assign the PR`, and `Workflow Syntax and Markdown Local File Targets`. Changing a job name changes its status check context.

## Validation and releases

Run `node --test tests/*.test.cjs`. Tests execute the scripts embedded in the YAML rather than a separate implementation. CI also runs actionlint and local Markdown target validation. The local link check does not verify external URLs or heading anchors.

After CI passes on `main`, the library calls the shared Release Please workflow to prepare release PRs and draft releases. GitHub auto-merges release PRs once the required checks and reviews pass. The library publishes a draft and its exact `vX.Y.Z` tag when the draft targets the commit tested by that run.

The library uses `RELEASE_PLEASE_TOKEN` and repository auto-merge as a one-time setup. Consumers of the new release workflow can pin its exact release tag. Major aliases are promoted separately after consumer validation.
