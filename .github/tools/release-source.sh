#!/usr/bin/env bash
# Resolve once; create a new tag only after all checks and signed packaging.
set -euo pipefail
[[ "${RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]
case "${1:-}" in
  resolve)
    requested=${REQUESTED_SHA:-}
    [[ -z "$requested" || "$requested" =~ ^[0-9a-f]{40}$ ]]
    tagged=$(git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}" 2>/dev/null || true)
    if [[ -n "$tagged" ]]; then
      [[ -z "$requested" || "$requested" = "$tagged" ]]
      sha=$tagged
    else
      [[ -n "$requested" ]]
      sha=$(git rev-parse --verify "$requested^{commit}")
      [[ "$sha" = "$requested" ]]
    fi
    # Only release source already reachable from this repository's default branch.
    git merge-base --is-ancestor "$sha" origin/master
    [[ "$(git show "$sha:module.prop" | sed -n 's/^version=//p')" = "$RELEASE_TAG" ]]
    printf 'sha=%s\ntag=%s\n' "$sha" "$RELEASE_TAG" >> "$GITHUB_OUTPUT"
    ;;
  tag)
    [[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
    [[ "$(git rev-parse HEAD)" = "$RELEASE_SHA" ]]
    [[ "$(sed -n 's/^version=//p' module.prop)" = "$RELEASE_TAG" ]]
    if git ls-remote --exit-code --refs origin "refs/tags/$RELEASE_TAG" > /dev/null; then
      git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
      [[ "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$RELEASE_SHA" ]]
    else
      rc=$?
      [[ "$rc" = 2 ]] # Network/auth failures are not evidence of an absent tag.
      git push origin "$RELEASE_SHA:refs/tags/$RELEASE_TAG" # No force; collision fails.
    fi
    ;;
  *) exit 2 ;;
esac
