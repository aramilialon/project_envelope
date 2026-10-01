#!/usr/bin/env bash
# Creates the real "envelope" realm in the development Keycloak
# (infra/docker-compose.yml), distinct from the throwaway per-test realms
# apps/api/src/test-helpers/keycloak.ts provisions and tears down on every
# test run. Safe to run again: an existing realm or client is left alone.
#
# Requirements: Keycloak running and reachable at KEYCLOAK_URL (default
# http://127.0.0.1:8080), KEYCLOAK_ADMIN_PASSWORD in the environment (the
# value from infra/.env), and jq installed.
#
# Local username/password authentication (Keycloak's own user store) is
# enabled by default; no external identity provider is required to sign in.
# For an admin-created account (a family member, for example), set its
# password as "temporary" when creating it, so Keycloak requires the person
# to change it on first login.
#
# Adding a secondary external identity provider (Google, Facebook, Microsoft
# Entra ID, a company directory) later goes into this SAME realm, never a
# separate Keycloak realm per tenant or per workspace: envelope's own
# multi-tenancy boundary is the workspace (docs/design.md, "Workspace"), and
# the API only ever validates tokens from this one realm's issuer, unaware
# of which upstream provider a user actually signed in through.
#
# One registration per provider covers every user, not one per external
# tenant:
#   - Google: one OAuth 2.0 Client ID (Google Cloud Console, "Web
#     application"); Keycloak's built-in "Google" identity provider template
#     needs only the client id/secret. No tenant concept.
#   - Facebook: one Facebook App with the "Facebook Login" product
#     (developers.facebook.com); Keycloak's built-in "Facebook" template. No
#     tenant concept, but Meta requires a Privacy Policy URL and a Data
#     Deletion Callback even for basic login, and the app must go from
#     "Development" to "Live".
#   - Microsoft (Entra ID): register the App Registration as multi-tenant
#     ("accounts in any organizational directory and personal Microsoft
#     accounts", the `common` endpoint), not single-tenant, so one
#     registration covers every organization's tenant and personal accounts
#     alike — the only one of the three with a tenant concept, and this
#     setting is how to avoid a registration per customer.
# Redirect URI for all three, once the realm exists:
#   https://<keycloak-host>/realms/envelope/broker/<alias>/endpoint
set -euo pipefail

command -v jq >/dev/null || { echo "jq is not installed" >&2; exit 1; }

KEYCLOAK_URL="${KEYCLOAK_URL:-http://127.0.0.1:8080}"
REALM="envelope"
CLIENT_ID="${KEYCLOAK_AUDIENCE:-envelope-api}"
: "${KEYCLOAK_ADMIN_PASSWORD:?set KEYCLOAK_ADMIN_PASSWORD (the value from infra/.env)}"

# method path [extra curl args...]
kc() {
  local method=$1 path=$2
  shift 2
  curl -sS -X "$method" "$KEYCLOAK_URL$path" -H "Authorization: Bearer $TOKEN" "$@"
}

echo "== Waiting for Keycloak at $KEYCLOAK_URL"
until curl -fsS "$KEYCLOAK_URL/realms/master" >/dev/null 2>&1; do
  sleep 1
done

TOKEN=$(curl -fsS -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" -d "client_id=admin-cli" \
  -d "username=admin" -d "password=$KEYCLOAK_ADMIN_PASSWORD" | jq -r .access_token)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Could not get an admin token: check KEYCLOAK_ADMIN_PASSWORD" >&2
  exit 1
fi

REALM_STATUS=$(kc GET "/admin/realms/$REALM" -o /dev/null -w '%{http_code}')
if [[ "$REALM_STATUS" == "200" ]]; then
  echo "== Realm \"$REALM\" already exists, skipping creation"
else
  echo "== Creating realm \"$REALM\""
  REALM_JSON=$(jq -n --arg realm "$REALM" '{realm: $realm, enabled: true, verifyEmail: false, registrationAllowed: false}')
  kc POST /admin/realms -f -H "Content-Type: application/json" -d "$REALM_JSON" -o /dev/null
fi

CLIENT_INTERNAL_ID=$(kc GET "/admin/realms/$REALM/clients?clientId=$CLIENT_ID" -f | jq -r '.[0].id // empty')
if [[ -n "$CLIENT_INTERNAL_ID" ]]; then
  echo "== Client \"$CLIENT_ID\" already exists, skipping creation"
else
  echo "== Creating client \"$CLIENT_ID\""
  # Public (no secret) with PKCE: the web app is a browser-side SPA, not a
  # confidential backend service. redirectUris is a permissive dev-only default
  # (a wildcard port, in case the dev server ever runs on something other than
  # Vite's own 5173) — tighten it for any non-development realm.
  #
  # webOrigins CANNOT use "+" (Keycloak's "same as the redirect URIs" shorthand)
  # here: "+" does not expand a wildcard PORT in a redirect URI into a usable CORS
  # origin, so the token endpoint ends up allowing no origin at all and the
  # browser blocks the code-for-tokens exchange outright (#308, found after #49
  # shipped with only mocked tests). List the known dev origins explicitly
  # instead, and add to this list if the web app ever runs on another one.
  CLIENT_JSON=$(jq -n --arg clientId "$CLIENT_ID" '{
    clientId: $clientId,
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: ["http://localhost:*", "http://127.0.0.1:*"],
    webOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    attributes: {
      "pkce.code.challenge.method": "S256",
      # "+": same as the redirect URIs above — fine here, since the post-logout
      # redirect itself is a page navigation, not a CORS-checked fetch. Needed
      # for sign-out (#49): without it, Keycloak rejects the redirect outright.
      "post.logout.redirect.uris": "+"
    }
  }')
  CREATE_HEADERS=$(kc POST "/admin/realms/$REALM/clients" -f -H "Content-Type: application/json" -d "$CLIENT_JSON" -D - -o /dev/null)
  CLIENT_INTERNAL_ID=$(grep -i '^location:' <<<"$CREATE_HEADERS" | tr -d '\r' | sed 's#.*/##')

  echo "== Adding the audience mapper to \"$CLIENT_ID\""
  MAPPER_JSON=$(jq -n --arg audience "$CLIENT_ID" '{
    name: "audience-mapper",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": $audience,
      "id.token.claim": "false",
      "access.token.claim": "true"
    }
  }')
  kc POST "/admin/realms/$REALM/clients/$CLIENT_INTERNAL_ID/protocol-mappers/models" -f -H "Content-Type: application/json" -d "$MAPPER_JSON" -o /dev/null
fi

echo "== Done: realm \"$REALM\" with client \"$CLIENT_ID\" (KEYCLOAK_ISSUER=$KEYCLOAK_URL/realms/$REALM)"
