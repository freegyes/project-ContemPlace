#!/usr/bin/env bash
set -e
command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks not found. Install with: brew install gitleaks"; exit 1; }

HOOK=".git/hooks/pre-commit"
cat > "$HOOK" << 'HOOKEOF'
#!/usr/bin/env bash
gitleaks protect --staged --verbose
HOOKEOF
chmod +x "$HOOK"
echo "Pre-commit hook installed."
