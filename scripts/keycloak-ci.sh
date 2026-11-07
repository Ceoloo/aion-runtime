#!/usr/bin/env bash
# Disposable GitHub Actions ONLY. Loopback HTTPS, ephemeral credentials.
set -euo pipefail
: "$GITHUB_ACTIONS"
: "$AION_PROOF_DB_DISPOSABLE"
[ "$GITHUB_ACTIONS" = "true" ] && [ "$AION_PROOF_DB_DISPOSABLE" = "1" ] &&
  [ "$GITHUB_EVENT_NAME" = "pull_request" ] || { echo "PR-only disposable proof" >&2; exit 3; }
: "$RUNNER_TEMP"
: "$GITHUB_ENV"
mkdir -p "$RUNNER_TEMP/forge-keycloak-tls"
chmod 755 "$RUNNER_TEMP/forge-keycloak-tls"
cd "$RUNNER_TEMP/forge-keycloak-tls"
openssl req -x509 -nodes -newkey rsa:3072 -sha256 \
  -keyout tls.key -out tls.crt -days 1 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  >/dev/null 2>&1
chmod 644 tls.key tls.crt
for key in FORGE_CI_ADMIN_PASSWORD FORGE_CI_CLIENT_SECRET FORGE_CI_USER_PASSWORD; do
  val="$(openssl rand -hex 32)"
  echo "::add-mask::$val"
  printf "%s=%s\n" "$key" "$val" >> "$GITHUB_ENV"
  export "$key=$val"
done
echo "NODE_EXTRA_CA_CERTS=$RUNNER_TEMP/forge-keycloak-tls/tls.crt" >> "$GITHUB_ENV"
echo "FORGE_CI_KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.2" >> "$GITHUB_ENV"
docker pull quay.io/keycloak/keycloak:26.8.2 >/dev/null
docker run --rm -d \
  --name aion-forge-keycloak-ci \
  -p 127.0.0.1:18443:8443 \
  --mount "type=bind,src=$RUNNER_TEMP/forge-keycloak-tls,dst=/opt/keycloak/certs,readonly" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=forge-proof-admin \
  -e "KC_BOOTSTRAP_ADMIN_PASSWORD=$FORGE_CI_ADMIN_PASSWORD" \
  -e KC_HEALTH_ENABLED=true \
  quay.io/keycloak/keycloak:26.8.2 \
  start-dev \
  --hostname=https://localhost:18443 \
  --hostname-strict=true \
  --http-enabled=false \
  --https-port=8443 \
  --https-certificate-file=/opt/keycloak/certs/tls.crt \
  --https-certificate-key-file=/opt/keycloak/certs/tls.key >/dev/null
ready=0
for i in $(seq 1 75); do
  if curl --silent --fail --cacert tls.crt \
    https://localhost:18443/realms/master > /dev/null; then
    ready=1; break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "[forge-keycloak] HTTPS startup unavailable" >&2
  docker logs --tail 55 aion-forge-keycloak-ci >&2 || true
  exit 1
fi
echo "[forge-keycloak] isolated HTTPS identity provider ready (loopback only)"
