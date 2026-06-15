#!/bin/bash
# setup.sh — run once to configure the anthropic intercept
# Needs sudo for /etc/hosts and pfctl

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$SCRIPT_DIR/certs"

echo "=== Anthropic Intercept Setup ==="

# ── 1. mkcert CA ──────────────────────────────────────────────────────────────
echo "[1/4] Installing mkcert CA to system keychain..."
mkcert -install

# ── 2. Generate cert ──────────────────────────────────────────────────────────
echo "[2/4] Generating cert for api.anthropic.com..."
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"
mkcert api.anthropic.com
echo "Certs saved to $CERT_DIR"

# ── 3. /etc/hosts ─────────────────────────────────────────────────────────────
echo "[3/4] Adding api.anthropic.com to /etc/hosts..."
if grep -q "api.anthropic.com" /etc/hosts; then
  echo "  already present, skipping"
else
  echo "127.0.0.1 api.anthropic.com" | sudo tee -a /etc/hosts
  echo "  added"
fi

# ── 4. pfctl port redirect: 443 → 8443 ──────────────────────────────────────
echo "[4/4] Setting up pfctl redirect 443 → 8443 on lo0..."
sudo bash -c 'cat > /etc/pf.anchors/anthropic-intercept << "EOF"
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port 8443
EOF'
# Load anchor
sudo bash -c 'cat > /tmp/pf-intercept.conf << "EOF"
rdr-anchor "anthropic-intercept"
load anchor "anthropic-intercept" from "/etc/pf.anchors/anthropic-intercept"
EOF'
sudo pfctl -f /tmp/pf-intercept.conf -e 2>/dev/null || sudo pfctl -f /tmp/pf-intercept.conf
echo "  pfctl redirect active"

echo ""
echo "=== Setup complete ==="
echo "Start the proxy:  node $SCRIPT_DIR/proxy.js"
echo "Or use:           $SCRIPT_DIR/start.sh"
