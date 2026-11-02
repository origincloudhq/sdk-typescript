# Releasing

A release publishes every package of the repository to npm at one version,
from a commit on `main` whose CI passed, and tags that commit `v<version>`.
The packages share their version, so `@origincloud/pvs` always depends on the
`@origincloud/core` released with it. The version is in
`packages/*/package.json`, in the `@origincloud/core` peer and development
dependency of every service package, and in `VERSION`
(`packages/core/src/client.ts`; a test checks they agree).

Versions follow semantic versioning. Before 1.0, a minor version may change
the API incompatibly, as the preview APIs themselves may (a `v1beta1`
import). A version is never unpublished or reused once released: deprecate
it with `npm deprecate` and release the next one instead.

## The automatic path

1. **Regeneration.** When the API changes, `regenerate.yml` opens or refreshes
   the pull request from the branch `regenerate`, and sets the next version in
   it with `scripts/version.sh bump`: a minor version when `API_REVISION` moved,
   a patch for a change of the generator alone.
2. **Merge.** Once CI passes on that pull request's head commit,
   `merge-regeneration.yml` merges it, if every commit in it is the
   regeneration workflow's. A pull request someone added commits to waits for
   review.
3. **Release.** Once CI passes on `main`, `release.yml` publishes the version if
   it has no tag yet (`scripts/version.sh unreleased`): `@origincloud/core`
   first, then the service packages, skipping any whose version is on npm
   already, so that a release that failed half way finishes when it runs
   again. Then it tags the commit.

It publishes with npm's trusted publishing, from the environment `release`:
no npm token is stored here, and npm attaches each package's provenance. The
merge uses the regeneration App's token, whose ID is the variable
`REGENERATE_APP_ID` and whose key is the secret `REGENERATE_APP_PRIVATE_KEY`;
a merge with the workflow token would start no CI on `main`, and so no
release. Without the App, step 1 still opens the pull request, and the merge
is done by hand.

## A new package

Trusted publishing reaches only packages that exist, so a package's first
version is published by hand, by a member of the `@origincloud` npm
organisation with two-factor authentication; until then the release fails,
naming the package. For each new package:

1. Publish its first version from the commit on `main` that has it:

   ```sh
   git switch --detach origin/main
   npm ci
   npm run build
   npm publish --workspace @origincloud/<service> --access public
   ```

2. On npmjs.com, add this repository as the package's trusted publisher:
   workflow `release.yml`, environment `release`.
3. Run `release.yml` again (re-run its last run), which publishes the other
   packages and tags the commit.

## By hand

A change outside a regeneration is released by setting the version in the
same pull request: `scripts/version.sh bump minor` or `scripts/version.sh bump
patch`, then `npm install --package-lock-only`. `release.yml` publishes it
once the pull request is merged and CI passes on `main`.

Without the workflow, a member of the `@origincloud` npm organisation
publishes and tags from that commit:

```sh
git switch --detach origin/main
git status --porcelain   # must print nothing
npm ci
scripts/generate.sh
npm test
npm pack --dry-run --workspaces
npm publish --workspace @origincloud/core --access public
npm publish --workspace @origincloud/pvs --access public
npm publish --workspace @origincloud/location --access public
git tag -a v0.2.0 -m v0.2.0
git push origin v0.2.0
```

Then check that the versions resolve:

```sh
npm view @origincloud/core@0.2.0 version
npm view @origincloud/pvs@0.2.0 peerDependencies
npm view @origincloud/location@0.2.0 peerDependencies
```
