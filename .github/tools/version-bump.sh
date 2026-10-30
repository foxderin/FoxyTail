#!/usr/bin/env bash
# FoxyTail version bumper.
#
# Usage: version-bump.sh [major|minor|patch]   (default: patch)
#
# Bumps the three-part semver in module.prop (version=vX.Y.Z) and
# update.json, and prepends a git-log generated entry to CHANGELOG.md.
#
# versionCode formula: X*10000 + Y*100 + Z   (e.g. 1.2.3 -> 10203)
# Limits: X <= 999, Y <= 99, Z <= 99. The code is a plain monotonically
# increasing integer, as Magisk/KernelSU OTA requires.
set -euo pipefail

cd "$(dirname "$0")/../.."

BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: $0 [major|minor|patch]" >&2
  exit 1
fi

CURRENT=$(grep '^version=' module.prop | cut -d'=' -f2)
if [[ "$CURRENT" =~ ^v[0-9]+\.[0-9]+\.[0-9]+- ]]; then
  echo "WARNING: current version '${CURRENT}' carries a prerelease suffix, but" >&2
  echo "         versionCode ignores it, so it shares a code with the final release" >&2
  echo "         and OTA cannot tell them apart. Bump to a clean release before shipping." >&2
fi
VERSION_NUM="${CURRENT#v}"
VERSION_NUM="${VERSION_NUM%%-*}" # drop any -rc suffix for the math
IFS='.' read -r MAJOR MINOR PATCH <<<"$VERSION_NUM"

case $BUMP_TYPE in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

if (( MAJOR > 999 || MINOR > 99 || PATCH > 99 )); then
  echo "error: version exceeds versionCode component limits" >&2
  exit 1
fi
NEW_VERSION="v${MAJOR}.${MINOR}.${PATCH}"
NEW_VERSION_CODE=$((MAJOR * 10000 + MINOR * 100 + PATCH))

# --- CHANGELOG entry from git log (bot commits filtered out) -----------------

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$LAST_TAG" ]; then
  RANGE="${LAST_TAG}..HEAD"
else
  RANGE=""
fi
COMMITS=$(git log --pretty=format:'- %h %s' $RANGE |
  grep -v -E 'github-actions|\[bot\]|Bump version|chore\(release\)' || true)

if [ -n "$COMMITS" ]; then
  TEMP_CHANGELOG=$(mktemp)
  if [ "$(head -n 1 CHANGELOG.md 2>/dev/null)" = "# Changelog" ]; then
    {
      echo "# Changelog"
      echo ""
      echo "## ${NEW_VERSION}"
      echo ""
      echo "$COMMITS"
      echo ""
      tail -n +2 CHANGELOG.md
    } >"$TEMP_CHANGELOG"
  else
    {
      echo "## ${NEW_VERSION}"
      echo ""
      echo "$COMMITS"
      echo ""
      cat CHANGELOG.md
    } >"$TEMP_CHANGELOG"
  fi
  mv "$TEMP_CHANGELOG" CHANGELOG.md
  echo "Added CHANGELOG.md entry for ${NEW_VERSION}"
fi

# --- Version files ------------------------------------------------------------

# Set all metadata before the version commit and tag; release never rewrites it.
python3 - "$NEW_VERSION" "$NEW_VERSION_CODE" <<'PYVERSION'
import json, re, sys
from pathlib import Path
version, code = sys.argv[1], int(sys.argv[2])
p = Path('module.prop')
s = re.sub(r'^version=.*$', 'version=' + version, p.read_text(), flags=re.M)
s = re.sub(r'^versionCode=.*$', 'versionCode=' + str(code), s, flags=re.M)
p.write_text(s)
p = Path('update.json'); d = json.loads(p.read_text())
d.update(version=version, versionCode=code,
         zipUrl=f'https://github.com/foxderin/FoxyTail/releases/download/{version}/FoxyTail-{version}.zip')
p.write_text(json.dumps(d, indent=2) + '\n')
PYVERSION

echo "Bumped ${BUMP_TYPE}: ${CURRENT} -> ${NEW_VERSION} (versionCode: ${NEW_VERSION_CODE})"
echo ""
echo "Next steps:"
echo "  git add module.prop update.json CHANGELOG.md"
echo "  git commit -m 'Bump version to ${NEW_VERSION}'"
echo "  git tag ${NEW_VERSION}"
echo "  git push && git push --tags"
