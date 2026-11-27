# Release Please

The shared [Release Please workflow](../.github/workflows/release-please.yml) uses the official engine for versions, changelogs, release pull requests, and GitHub Releases. Use the same per-repository manifest and configuration model as Igevia and Bostrom.

1. Commit `release-please-config.json` and `.release-please-manifest.json`. Seed the manifest with the current released version when migrating an existing project.
2. Configure a repository-scoped GitHub App token or fine-grained PAT as `RELEASE_PLEASE_TOKEN`. Grant Contents, Issues, and Pull requests write access on that repository. A separate token lets the generated release PR start normal CI without an extra workflow approval. See the [Release Please credentials documentation](https://github.com/googleapis/release-please-action#github-credentials).
3. Start from the [caller example](../examples/release-please.yml). Reference a library version that includes the workflow. Select the protected release branch and only grant the workflow the intended release secret.
4. Enable repository auto-merge before opting in to `auto_merge`. Require the release PR to pass the repository's CI and existing review rules. The caller works with manual merges when `auto_merge` is false.

The default `both` mode creates a release for an eligible merged release PR and prepares the next release PR when changes qualify. Use `prepare` and `publish` as separate calls if the caller must build and verify an artifact before publishing. The publish phase returns `release_created`, `tag_name`, `version`, and `sha` for `package_path`, which defaults to the repository root. A manifest can manage multiple packages. Selecting a path only filters the returned outputs.

Repository-specific checks, artifact attachment, signing, and deployment belong to the caller. Use draft releases and verify the release tag matches the tested artifact before publishing when the project requires an asset to be present on release.
