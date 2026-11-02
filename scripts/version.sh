#!/usr/bin/env bash
#
# The SDK's version: the `version` of every package (packages/*/package.json),
# the `@origincloud/core` each service package depends on, and `VERSION` in
# packages/core/src/client.ts, which a release publishes and tags
# (RELEASING.md). Run `npm install --package-lock-only` after a bump, so that
# package-lock.json follows.
#
#   scripts/version.sh current          # print it
#   scripts/version.sh bump minor|patch # set it to the next version
#   scripts/version.sh unreleased       # exit 0 if it has no tag yet and is
#                                       # newer than every tag, 1 otherwise
#
# `bump` sets it to the next version after the newest tag, or after the
# version on origin/main when that is newer: a version merged but not
# tagged yet is taken too, so a pull request made before the release
# workflow tags it gets a version of its own. A minor version when the API
# moved (before 1.0 a minor version may change the API incompatibly, as the
# preview APIs may), a patch otherwise. A version that is already newer
# than that, a bump not released yet, stays, so bumping a branch again
# doesn't bump it twice: it counts from main's version, not the branch's.
# Without origin/main, as in a clone that hasn't fetched it, it counts from
# the newest tag alone. The regeneration workflow bumps it in its pull
# request, and the release workflow tags it once that is merged.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly CORE="${ROOT}/packages/core/package.json"
readonly CLIENT="${ROOT}/packages/core/src/client.ts"
readonly PATTERN='^  "version": "([0-9]+\.[0-9]+\.[0-9]+)",$'

# The version the core package's package.json holds, given its contents $1 and
# its name $2.
parse() {
  local line
  line="$(grep -m 1 -E "${PATTERN}" <<< "$1")" || { echo "no version in $2" >&2; exit 1; }
  [[ "${line}" =~ ${PATTERN} ]]
  echo "${BASH_REMATCH[1]}"
}

# The core package's version, which every package shares.
current() {
  parse "$(< "${CORE}")" "${CORE}"
}

# The version on main as origin/main has it; 0.0.0 without origin/main.
on_main() {
  local file
  if file="$(git -C "${ROOT}" show "origin/main:packages/core/package.json" 2>/dev/null)"; then
    parse "${file}" origin/main:packages/core/package.json
  else
    echo "0.0.0"
  fi
}

# Sets every package's version, its dependency on the core package, and
# VERSION to $1. A package's own `version` is the only one indented once.
set_version() {
  local manifest
  for manifest in "${ROOT}"/packages/*/package.json; do
    sed -i -E \
      -e "s/^(  \"version\": \")[0-9.]+(\",)$/\1$1\2/" \
      -e "s/^(    \"@origincloud\/core\": \"\^)[0-9.]+(\",?)$/\1$1\2/" \
      "${manifest}"
  done
  sed -i -E "s/^(export const VERSION = \")[0-9.]+(\";)$/\1$1\2/" "${CLIENT}"
}

# The newest release, without its `v`; 0.0.0 before the first.
newest_tag() {
  local tag
  tag="$(git -C "${ROOT}" tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)"
  if [[ -n "${tag}" ]]; then
    echo "${tag#v}"
  else
    echo "0.0.0"
  fi
}

# Whether version $1 is newer than $2.
newer() {
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" == "$1" ]]
}

case "${1:-}" in
  current)
    current
    ;;
  bump)
    kind="${2:-}"
    from="$(newest_tag)"
    main="$(on_main)"
    if newer "${main}" "${from}"; then
      from="${main}"
    fi
    IFS=. read -r major minor patch <<< "${from}"
    case "${kind}" in
      minor) next="${major}.$((minor + 1)).0" ;;
      patch) next="${major}.${minor}.$((patch + 1))" ;;
      *) echo "usage: $0 bump minor|patch" >&2; exit 2 ;;
    esac
    now="$(current)"
    if newer "${next}" "${now}"; then
      set_version "${next}"
      echo "${next}"
    else
      echo "${now}"
    fi
    ;;
  unreleased)
    now="$(current)"
    newer "${now}" "$(newest_tag)"
    ;;
  *)
    echo "usage: $0 current | bump minor|patch | unreleased" >&2
    exit 2
    ;;
esac
