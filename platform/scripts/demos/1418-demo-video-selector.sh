#!/usr/bin/env bash
set -euo pipefail

echo "Demo-video selector proof"
echo
echo "This proves CI records changed demos from platform/scripts/demos from the platform working directory."
echo

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

git init -q
git config user.email "demo-video@example.com"
git config user.name "Demo Video"
mkdir -p platform/scripts/demos platform/docs/demos
cat > platform/scripts/record-demo.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
slug="$1"
test -f "scripts/demos/$slug.sh"
mkdir -p docs/demos
printf 'recorded %s\n' "$slug" > "docs/demos/$slug.mp4"
SH
chmod +x platform/scripts/record-demo.sh
cat > platform/scripts/demos/existing.sh <<'SH'
#!/usr/bin/env bash
echo existing
SH
git add .
git commit -qm "base demo layout"
BASE="$(git rev-parse HEAD)"

cat > platform/scripts/demos/1418-demo-video-selector.sh <<'SH'
#!/usr/bin/env bash
echo changed demo
SH
git add platform/scripts/demos/1418-demo-video-selector.sh
git commit -qm "change one platform demo"

changed="$(cd platform && git diff --name-only "$BASE...HEAD" -- 'scripts/demos/*.sh' 'scripts/record-demo.sh' || true)"
printf 'Changed files seen by selector:\n%s\n' "$changed"

demos_file="$(mktemp)"
printf '%s\n' "$changed" | awk '/^platform\/scripts\/demos\/.*\.sh$/ { print }' | sort -u > "$demos_file"

expected="platform/scripts/demos/1418-demo-video-selector.sh"
if ! grep -qx "$expected" "$demos_file"; then
  echo "Expected changed platform demo to be selected" >&2
  exit 1
fi

while IFS= read -r f; do
  [ -n "$f" ] || continue
  slug="$(basename "$f" .sh)"
  (cd platform && bash scripts/record-demo.sh "$slug")
done < "$demos_file"

test -s platform/docs/demos/1418-demo-video-selector.mp4

echo
echo "Selected demo:"
sed 's/^/  /' "$demos_file"
echo
echo "Recorder output:"
sed 's/^/  /' platform/docs/demos/1418-demo-video-selector.mp4
echo
echo "Video selector proof complete."
