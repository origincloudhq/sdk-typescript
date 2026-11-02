# Contributing

Thank you for helping improve Origin Cloud's SDK for TypeScript.

## Issues

Open an issue for anything that is wrong, unclear or missing: a method that
behaves differently from its description, an option you need, documentation that
doesn't explain enough. Say which package and method it is about, and include
the request and response where you can, with tokens and account details
removed.

To report a security vulnerability, don't open an issue: use **Report a
vulnerability** on this repository's Security tab, which reaches us privately.

## Pull requests

Pull requests are reviewed and merged here. For anything larger than a small
fix, open an issue first, so that we can agree on the change before you spend
time on it. CI must pass: the checks below, run on every pull request.

## How the SDK is built

The service packages' sources (`packages/<service>/src`) are generated from
the API definitions in [origincloudhq/api](https://github.com/origincloudhq/api),
at the commit `API_REVISION` names: buf builds the definitions into a
descriptor set, and this repository's generator, `generator/`, writes one
module per proto file from it, with an interface per message in its JSON form
and a client class per service, its methods sent as their `google.api.http`
bindings. `packages/core` is written by hand. So a change to what a service
offers starts in the API, which is why it is requested by opening an issue
rather than by editing a generated package; a change to how every client
behaves is a change to the generator or `core`.

A new service in the API gets its package scaffolded by
`scripts/generate.sh --write` (`generator/src/scaffold.ts`):
`packages/<service>` with a `package.json`, `tsconfig.json`, `README.md`,
`LICENSE` and a test of its client (`test/client.test.ts`) as
`packages/location` has them, listed in the root `package.json`'s workspaces,
`tsconfig.json`'s and `tsconfig.test.json`'s references, README.md's table and
`package-lock.json`. Its description says what the API's definitions do: the
first sentence of the package's comment (on a file's `package` statement), or
else of its one service's comment, or else the resources it serves, but those
within another of its resources, such as "ACLs, DNS policies, … and VPCs". A
better description starts in the API, with a package comment. Until a service
has its package, the check, and so CI, fails on it.

The regeneration workflow (`.github/workflows/regenerate.yml`) moves the SDK
to the newest API when it changes, and daily, and opens a pull request when
that changes anything, with the next version. Once its CI passes, it is
merged and released without anyone's hands, unless someone added commits to
it or it adds a service, which then wait for review: a new package needs its
first publish by hand ([RELEASING.md](RELEASING.md#a-new-package)).

## Checks

Node 20 or later, npm and network access are all you need; buf and the
TypeScript compiler are development dependencies.

```sh
npm ci
scripts/generate.sh --write   # generate the service packages again; without --write, check them
scripts/update.sh             # move to the newest API, and generate
npm run build                 # compile and typecheck everything
npm test                      # the live test skips without a zone
ORIGINCLOUD_LIVE_ZONE=projects/<project>/zones/<zone> \
  npm test                    # against the live API
```

CI also checks the scripts with `shellcheck`, tests `scripts/version.sh`
(`scripts/version.test.sh`), checks what each package would publish
(`npm pack --dry-run`), and runs the tests on Node 20, 22 and 24.
Releases are described in [RELEASING.md](RELEASING.md).

## License

By contributing, you agree that your contribution is licensed under the
Apache License 2.0, like the rest of this repository.
