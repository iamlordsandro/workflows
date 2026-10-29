# Repository guidance

Write code, comments, documentation and CLI output in English.

- Use Conventional Commit titles without a scope: `feat: subject`, `fix: subject`, `docs: subject`. Preserve `!` for breaking changes, as in `feat!: subject`.
- Normalize PR titles and validate the final squash policy. Never amend, rebase, force-push or validate individual contributor commits as part of normalization.
- Keep PR metadata workflows independent of pull request code: no checkout, installation, shell evaluation or inherited secrets in privileged jobs.
- Keep inputs generic and backward compatible within a major version. Repository-specific builds, deployments, secrets and release policies belong to consumers.
- Test the scripts actually embedded in workflow YAML, including stale metadata, forks, bots and hostile text.
- Run `node --test tests/*.test.cjs`, actionlint and local Markdown target validation before publishing.
- Pin third-party actions to reviewed commit SHAs. Publish an exact release tag and a compatible major alias only after the corresponding main commit passes CI.
- Update consumer examples and adoption documentation when a public input or required permission changes.
