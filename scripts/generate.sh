#!/usr/bin/env bash
#
# Generates the service packages' sources (packages/<service>/src) from the
# API definitions in origincloudhq/api at the commit API_REVISION names:
# buf builds the definitions into a descriptor set, and this repository's
# generator (generator/) writes the TypeScript, both at the versions
# package-lock.json pins.
#
#   scripts/generate.sh           # check the checked-in code is current
#   scripts/generate.sh --write   # generate it again
#
# The API's origincloud/<service> is the package @origincloud/<service> in
# packages/<service>, whose src/ is generated whole; the shared
# origincloud/longrunning is generated into each package that uses it.
# A new service gets its package scaffolded by --write
# (generator/src/scaffold.ts): package.json, tsconfig.json, README.md, LICENSE
# and a test of its client, as packages/location has them, its place in the
# root package.json, tsconfig.json, tsconfig.test.json and README.md, and in
# package-lock.json. Until then, the check fails.
#
# Needs node, npm (`npm ci` run), git and network access.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT
readonly API_REPOSITORY="https://github.com/origincloudhq/api.git"

revision="$(tr -d '[:space:]' < "${ROOT}/API_REVISION")"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || { echo "API_REVISION must hold a full commit hash" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

git init --quiet "${tmp}/api"
git -C "${tmp}/api" fetch --quiet --depth 1 "${API_REPOSITORY}" "${revision}"
git -C "${tmp}/api" checkout --quiet FETCH_HEAD
(
  cd "${ROOT}"
  npx --no-install tsc -p generator
  npx --no-install buf build "${tmp}/api" --as-file-descriptor-set -o "${tmp}/descriptors.json"
  node generator/dist/main.js "${tmp}/descriptors.json" "${tmp}/gen"
  node generator/dist/scaffold.js "${tmp}/descriptors.json" "${ROOT}" "${tmp}/scaffold"
)

# A service the API has but this repository has no package for yet:
# --write scaffolds its package; the check fails.
if [[ "${1:-}" == "--write" && -d "${tmp}/scaffold" ]]; then
  cp -R "${tmp}/scaffold/." "${ROOT}/"
  # Links the new packages into node_modules and adds them to
  # package-lock.json; twice, as npm leaves a new workspace's name out of the
  # lock file until the next install.
  for _ in 1 2; do
    (cd "${ROOT}" && npm install --ignore-scripts --no-audit --no-fund >/dev/null)
  done
  echo "scaffolded:"
  (cd "${tmp}/scaffold" && find . -type f | sed 's|^\./|  |' | LC_ALL=C sort)
fi
missing=()
for dir in "${tmp}/gen"/*/; do
  service="$(basename "${dir}")"
  if [[ ! -f "${ROOT}/packages/${service}/package.json" ]]; then
    echo "WARNING: the API has the service ${service}, which has no package yet: run $0 --write to scaffold it" >&2
    missing+=("${service}")
    rm -rf "${dir}"
  fi
done

# The generated sources, relative to the repository: every service
# package's src/.
generated() {
  (cd "$1" && find . -path './packages/*/src/*' -type f -not -path './packages/core/*' | LC_ALL=C sort)
}
mkdir -p "${tmp}/out/packages"
cp -R "${tmp}/gen/." "${tmp}/out/packages/"

if [[ "${1:-}" == "--write" ]]; then
  for dir in "${ROOT}"/packages/*/; do
    [[ "$(basename "${dir}")" == "core" ]] || rm -rf "${dir}src"
  done
  cp -R "${tmp}/out/packages/." "${ROOT}/packages/"
  echo "wrote $(generated "${ROOT}" | wc -l) files from origincloudhq/api@${revision:0:12}"
  exit 0
fi

failed=0
if [[ "${#missing[@]}" -gt 0 ]]; then
  failed=1
elif ! diff <(generated "${ROOT}") <(generated "${tmp}/out") >/dev/null; then
  failed=1
else
  while read -r file; do
    cmp -s "${ROOT}/${file}" "${tmp}/out/${file}" || failed=1
  done < <(generated "${ROOT}")
fi
if [[ "${failed}" -eq 1 ]]; then
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "FAILED: the API has services without a package: ${missing[*]}; run $0 --write to scaffold them"
  else
    echo "FAILED: the generated code isn't what origincloudhq/api@${revision:0:12} generates; run $0 --write"
  fi
  exit 1
fi
echo "ok - the generated code is current (origincloudhq/api@${revision:0:12})"
