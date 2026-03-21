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
echo "▶  1/11  Applying schema migration..."
echo "   (drops v1 tables/functions, creates v2 schema + seed)"
supabase db push --linked --yes
echo "   ✓ Schema applied."
echo ""

# ── Step 2: Typecheck ─────────────────────────────────────────────────────────
echo "▶  2/11  Typechecking..."
npx tsc --noEmit
npx tsc --noEmit -p mcp/tsconfig.json
npx tsc --noEmit -p gardener/tsconfig.json
npx tsc --noEmit -p dashboard-api/tsconfig.json
echo "   ✓ No type errors."
echo ""

# ── Step 3: Unit tests ────────────────────────────────────────────────────────
echo "▶  3/11  Unit tests..."
npx vitest run tests/parser.test.ts tests/gardener-similarity.test.ts tests/gardener-config.test.ts tests/gardener-alert.test.ts tests/dashboard-api.test.ts
echo ""

# ── Step 4: Deploy MCP Worker (must deploy before Telegram — Service Binding target) ─
if grep -q 'YOUR_KV_NAMESPACE_ID\|YOUR_KV_PREVIEW_ID' mcp/wrangler.toml; then
  echo "❌  mcp/wrangler.toml still has placeholder KV namespace IDs."
  echo "   Create your KV namespace first — see docs/setup.md section 4."
  exit 1
fi
echo "▶  4/11  Deploying MCP Worker..."
wrangler deploy -c mcp/wrangler.toml
echo "   ✓ MCP Worker deployed."
echo ""

# ── Step 5: Deploy Telegram Worker ───────────────────────────────────────────
echo "▶  5/11  Deploying Telegram Worker..."
wrangler deploy
echo "   ✓ Telegram Worker deployed."
echo ""

# ── Step 6: Register Telegram bot commands ───────────────────────────────────
echo "▶  6/11  Registering bot commands..."
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
    -H "Content-Type: application/json" \
    -d '{"commands": [{"command": "start", "description": "Start the bot"}, {"command": "undo", "description": "Undo the most recent capture"}]}' \
    | grep -q '"ok":true' && echo "   ✓ Bot commands registered." || echo "   ⚠  Bot command registration failed (non-critical)."
else
  echo "   ⚠  TELEGRAM_BOT_TOKEN not set — skipping bot command registration."
fi
echo ""

# ── Step 7: Deploy Gardener Worker ───────────────────────────────────────────
echo "▶  7/11  Deploying Gardener Worker..."
wrangler deploy -c gardener/wrangler.toml
echo "   ✓ Gardener Worker deployed."
echo ""

# ── Step 8: Deploy Dashboard API Worker ──────────────────────────────────────
echo "▶  8/11  Deploying Dashboard API Worker..."
wrangler deploy -c dashboard-api/wrangler.toml
echo "   ✓ Dashboard API Worker deployed."
echo ""

# ── Step 9: Deploy Dashboard Pages ───────────────────────────────────────────
echo "▶  9/11  Deploying Dashboard..."
if [[ -z "${DASHBOARD_API_URL:-}" ]]; then
  echo "   ⚠  DASHBOARD_API_URL not set in .dev.vars — skipping dashboard deploy."
else
  echo "window.CONTEMPLACE_API_URL = \"${DASHBOARD_API_URL}\";" > dashboard/config.js
  wrangler pages deploy dashboard/ --project-name contemplace-dashboard --branch main
  echo "   ✓ Dashboard deployed."
fi
echo ""

# ── Step 10: Smoke tests ─────────────────────────────────────────────────────
if [ "$SKIP_SMOKE" = true ]; then
  echo "▶  10/11  Smoke tests skipped (--skip-smoke)."
else
  echo "▶  10/11  Running smoke tests against live Workers..."
  npx vitest run tests/smoke.test.ts tests/dashboard-smoke.test.ts
fi

# ── Step 11: Visual verification reminder ────────────────────────────────────
echo ""
echo "▶  11/11  Open the dashboard in a browser and verify visually."
echo "   URL: ${DASHBOARD_API_URL:-https://contemplace-dashboard.pages.dev}"

echo ""
echo "══════════════════════════════════════════"
echo "  ✅  Deploy complete."
echo "══════════════════════════════════════════"
