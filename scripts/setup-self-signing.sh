#!/usr/bin/env bash
#
# One-time setup: create a STABLE self-signed code-signing identity for Artemis.
#
# Why: an unsigned (ad-hoc) build gets a different signature every rebuild, so macOS
# treats each build as a "new app" — re-prompting for Screen Recording and losing
# safeStorage secrets (API key, GA creds). A *stable* self-signed identity keeps the
# signature constant across rebuilds, so permissions and secrets persist through updates.
#
# Run once:   bash scripts/setup-self-signing.sh
# Then:       npm run package
#
# Replace with a real Apple Developer ID when the Livana developer account exists —
# just change mac.identity in electron-builder.yml (and add notarization).

set -euo pipefail

IDENTITY="Artemis Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning -v "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ '$IDENTITY' already exists in your login keychain — nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.conf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $IDENTITY
[ v3 ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF

echo "→ Generating a 10-year self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.conf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/cert.p12" -passout pass: >/dev/null 2>&1

echo "→ Importing into your login keychain (granting codesign access)…"
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "" -T /usr/bin/codesign

echo "→ Trusting it for code signing (you may be asked for your login password)…"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null \
  || echo "  (auto-trust skipped — codesign still works; click 'Always Allow' if prompted during the build)"

echo
echo "✓ '$IDENTITY' is ready."
echo "  Next:   npm run package"
echo "  • If macOS prompts 'codesign wants to use a key in your keychain', click Always Allow (once)."
echo "  • The first launch after this re-asks for Screen Recording (the signature changed);"
echo "    after that, every rebuild keeps the same identity and your permissions + key persist."
