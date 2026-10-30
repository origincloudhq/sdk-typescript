# Releasing

A release publishes every package of the repository to npm at one version,
from a commit on `main` whose CI passed, and tags that commit. The packages
share their version, so `@origincloud/pvs` always depends on the
`@origincloud/core` released with it.

1. On a branch, set the next version in `packages/*/package.json`, in the
   `@origincloud/core` peer and development dependency of every service
   package, and in `VERSION` (`packages/core/src/client.ts`; a test checks
   they agree), then run `npm install` to update `package-lock.json`. Merge
   it once CI passes.

2. From a clean checkout of that commit, build and check what will be
   published:

   ```sh
   git switch --detach origin/main
   git status --porcelain   # must print nothing
   npm ci
   scripts/generate.sh
   npm test
   npm pack --dry-run --workspaces
   ```

3. Publish, `@origincloud/core` first, as a member of the `@origincloud` npm
   organisation with two-factor authentication:

   ```sh
   npm publish --workspace @origincloud/core --access public
   npm publish --workspace @origincloud/pvs --access public
   ```

   A preview release takes `--tag next` on both, so that `latest` stays on
   the last stable release.

4. Tag the commit and push the tag:

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

5. Check that the versions resolve:

   ```sh
   npm view @origincloud/core@0.2.0 version
   npm view @origincloud/pvs@0.2.0 dependencies
   ```

Versions follow semantic versioning. Before 1.0, a minor version may change
the API incompatibly, as the preview APIs themselves may (a `v1beta1`
import). A version is never unpublished or reused once released: deprecate
it with `npm deprecate` and release the next one instead.
