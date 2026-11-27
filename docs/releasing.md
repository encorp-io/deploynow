# Releasing

For maintainers. A release is a `vX.Y.Z` tag on `main`; GitHub Actions does the rest.

Workflows pin every action to a commit SHA (the version is in a comment beside it);
Dependabot opens monthly pull requests to move them.

1. Pick the version: patch for fixes, minor for features, major if users must do
   something by hand.
2. On a branch, set `"version"` in `package.json` (and `cli/package.json`), move the
   **Unreleased** notes in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading, update the links at the bottom, and merge the pull request.
3. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v1.1.0 -m "DeployNow 1.1.0"
   git push origin v1.1.0
   ```

What runs:

- **Docker — Build & Publish** builds `ghcr.io/encorp-io/deploynow` and
  `ghcr.io/encorp-io/deploynow-agent` for amd64 and arm64, tagged `1.1.0`, `1.1`, `1`
  (server) and `latest`. Each image is signed with cosign (keyless, through GitHub's
  OIDC token) and carries SLSA provenance and an SBOM. Its digests go on the GitHub
  release as `image-digests.txt`, which self-update checks against.
- **Release** runs CI, checks that the tag matches `package.json`, and creates the
  GitHub release with the changelog section and install commands.

Pre-releases (`v1.1.0-rc.1`) get version tags but not `latest`, and are marked as
pre-releases on GitHub.

After a release, check that `curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/v1.1.0/setup.sh | sudo DEPLOYNOW_TAG=1.1.0 bash`
works on a fresh VM, and that an upgrade from the previous version keeps its data.
