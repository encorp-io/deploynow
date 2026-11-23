# Releasing

For maintainers. A release is a `vX.Y.Z` tag on `main`; GitHub Actions does the rest.

1. Pick the version: patch for fixes, minor for features, major if users must do
   something by hand.
2. On a branch, set `"version"` in `package.json` (and `cli/package.json`), move the
   **Unreleased** notes in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading, update the links at the bottom, and merge the pull request.
3. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v2.1.0 -m "DeployNow 2.1.0"
   git push origin v2.1.0
   ```

What runs:

- **Docker — Build & Publish** builds `ghcr.io/encorp-io/deploynow` and
  `ghcr.io/encorp-io/deploynow-agent` for amd64 and arm64, tagged `2.1.0`, `2.1`, `2`
  (server) and `latest`.
- **Release** runs CI, checks that the tag matches `package.json`, and creates the
  GitHub release with the changelog section and install commands.

Pre-releases (`v2.1.0-rc.1`) get version tags but not `latest`, and are marked as
pre-releases on GitHub.

After a release, check that `curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/v2.1.0/install.sh | sudo DEPLOYNOW_TAG=2.1.0 bash`
works on a fresh VM, and that an upgrade from the previous version keeps its data.
