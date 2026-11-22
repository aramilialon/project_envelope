Changed

- Changelog: each pull request now adds its entry as one file in `changes/unreleased/` instead of editing `CHANGELOG.md`, and `pnpm --filter @envelope/scripts changelog:release <version>` compiles them under the new version at release time (`#738`), so pull requests that land together no longer conflict over the changelog.
