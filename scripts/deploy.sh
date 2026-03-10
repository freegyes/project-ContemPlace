#!/usr/bin/env bash
# Full automated deploy for ContemPlace v2.
# Reads secrets from .dev.vars — no manual steps required.
#
# Usage: bash scripts/deploy.sh [--skip-smoke]
#
# The --skip-smoke flag skips the end-to-end smoke tests (useful when
# you want to deploy fast and test manually).

set -euo pipefail

SKIP_SMOKE=false
for arg in "$@"; do
  [[ "$arg" == "--skip-smoke" ]] && SKIP_SMOKE=true
done

# ── Load .dev.vars ────────────────────────────────────────────────────────────
if [ ! -f .dev.vars ]; then
  echo "❌  .dev.vars not found. Copy .dev.vars.example and fill in values."
  exit 1
fi

# Export all non-comment, non-blank lines from .dev.vars
set -a
# shellcheck disable=SC1091
source .dev.vars
set +a

# ── Check required secrets ────────────────────────────────────────────────────
MISSING=()
[[ -z "${WORKER_URL:-}" ]] && MISSING+=("WORKER_URL")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌  Missing required vars in .dev.vars: ${MISSING[*]}"
  exit 1
fi

# ── Ensure project is linked ─────────────────────────────────────────────────
# Uses `supabase db push --linked` which connects via the management API /
# connection pooler — no direct port 5432 access required.
if [ ! -f supabase/.temp/project-ref ]; then
  echo "❌  Supabase project not linked. Run: supabase link --project-ref <ref>"
  exit 1
fi

echo ""
echo "══════════════════════════════════════════"
echo "  ContemPlace v2 deploy"
echo "══════════════════════════════════════════"
echo ""

# ── Step 1: Schema migration ──────────────────────────────────────────────────
echo "▶  1/6  Applying schema migration..."
echo "   (drops v1 tables/functions, creates v2 schema + seed)"
supabase db push --linked --yes
echo "   ✓ Schema applied."
echo ""

# ── Step 2: Typecheck ─────────────────────────────────────────────────────────
echo "▶  2/6  Typechecking..."
npx tsc --noEmit
npx tsc --noEmit -p gardener/tsconfig.json
echo "   ✓ No type errors."
echo ""

# ── Step 3: Unit tests ────────────────────────────────────────────────────────
echo "▶  3/6  Unit tests..."
npx vitest run tests/parser.test.ts tests/gardener-similarity.test.ts
echo ""

# ── Step 4: Deploy Telegram Worker ───────────────────────────────────────────
echo "▶  4/6  Deploying Telegram Worker..."
wrangler deploy
echo "   ✓ Telegram Worker deployed."
echo ""

# ── Step 5: Deploy Gardener Worker ───────────────────────────────────────────
echo "▶  5/6  Deploying Gardener Worker..."
wrangler deploy -c gardener/wrangler.toml
echo "   ✓ Gardener Worker deployed."
echo ""

# ── Step 6: Smoke tests ───────────────────────────────────────────────────────
if [ "$SKIP_SMOKE" = true ]; then
  echo "▶  6/6  Smoke tests skipped (--skip-smoke)."
else
  echo "▶  6/6  Running smoke tests against live Worker..."
  npx vitest run tests/smoke.test.ts
fi

echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Deploy complete."
echo "══════════════════════════════════════════"
