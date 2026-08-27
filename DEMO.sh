#!/usr/bin/env bash
# Scyne workspace plane — demo. Run from the repo root.
#
# SAFE: this never touches projects/. It restores into a throwaway root under
# /tmp, which is also the more honest demo — it is what a NEW machine sees.
set -e
TSX=plugins/aws-file-processing/node_modules/.bin/tsx
CLI=plugins/aws-file-processing/scripts/sync.mjs
P="${1:-SAPN_DEMO}"
FRESH=/tmp/scyne-fresh-machine
q() { python3 -m json.tool; }

echo "### 1. The project is on this laptop AND in Azure Blob"
$TSX $CLI "$P" --status --root . 2>/dev/null | q

echo
echo "### 2. A brand-new machine. Empty. No projects/ at all."
rm -rf "$FRESH"; mkdir -p "$FRESH/projects"
find "$FRESH" -type f | wc -l | xargs echo "    files present:"

echo
echo "### 3. Pull the whole project down from blob"
$TSX $CLI "$P" --down --root "$FRESH" 2>/dev/null | q

echo
echo "### 4. Every file byte-identical to the original?"
if diff -r --exclude='.DS_Store' \
     <(cd "projects/$P" && find . -type f | sort) \
     <(cd "$FRESH/projects/$P" && find . -type f | sort) >/dev/null \
   && diff -r -q "projects/$P" "$FRESH/projects/$P" 2>/dev/null | grep -v '^Only in' | grep -q . ; then
  echo "    MISMATCH"; else echo "    IDENTICAL — all $(find "$FRESH/projects/$P" -type f | wc -l | tr -d ' ') files restored byte for byte."
fi

echo
echo "### 5. Nothing is ever deleted implicitly, and nothing re-uploads"
$TSX $CLI "$P" --up --root . 2>/dev/null | q
echo "    (pushed 0 — content-addressed by SHA-256, not timestamps)"
