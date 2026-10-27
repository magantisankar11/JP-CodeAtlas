#!/usr/bin/env bash
# Engine bake-off: runs each parser engine in its own JVM against the same scope and the fixture golden file.
# Usage: scripts/bakeoff.sh <repo-dir> <repo-id> <include-package>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$1"; REPO_ID="$2"; INCLUDE="$3"
JAR="$ROOT/analyzer-java/target/jci-analyzer.jar"
OUT="$ROOT/workspace/bakeoff/$REPO_ID"
mkdir -p "$OUT"
for ENGINE in spoon spoon-lombok javaparser; do
  echo "== $ENGINE on $REPO_ID ($INCLUDE)"
  java -Xmx6g -jar "$JAR" probe --engine "$ENGINE" --repo "$REPO" --repo-id "$REPO_ID" --include "$INCLUDE" \
    --workspace "$ROOT/workspace" --out "$OUT/$ENGINE.json" > /dev/null
  echo "== $ENGINE on fixture"
  java -Xmx2g -jar "$JAR" probe --engine "$ENGINE" --repo "$ROOT/fixtures/simple-rest" --repo-id simple-rest \
    --workspace "$ROOT/workspace" --golden "$ROOT/fixtures/simple-rest.expected.json" --out "$OUT/fixture-$ENGINE.json" > /dev/null
done
echo "reports in $OUT"
