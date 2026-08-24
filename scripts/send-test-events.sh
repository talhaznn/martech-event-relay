#!/usr/bin/env bash
#
# Ende-zu-Ende-Test des Relays.
#
# Prüft in neun Schritten alles, was die Demo verspricht: Annahme eines Browserereignisses,
# Deduplizierung, signierte Server-zu-Server-Aufrufe, Abweisung einer gefälschten Signatur,
# Abweisung eines fehlerhaften Schemas, den nachgebildeten CAPI-Empfänger einschließlich der
# Sperre gegen ungehashte Daten, den Wiederholversuch und die Tageszähler.
#
# Aufruf:
#   ./scripts/send-test-events.sh                                  gegen wrangler dev
#   ./scripts/send-test-events.sh https://relay.example.workers.dev gegen die veröffentlichte Fassung
#
# Das Geheimnis kommt aus RELAY_HMAC_SECRET oder aus der Datei .dev.vars.

set -uo pipefail

BASIS="${1:-http://127.0.0.1:8787}"
BASIS="${BASIS%/}"
HERKUNFT="${ORIGIN:-http://localhost:8788}"

if [[ -z "${RELAY_HMAC_SECRET:-}" && -f ".dev.vars" ]]; then
  RELAY_HMAC_SECRET="$(grep -E '^RELAY_HMAC_SECRET=' .dev.vars | head -1 | cut -d= -f2-)"
fi
GEHEIMNIS="${RELAY_HMAC_SECRET:-dev-secret-nur-lokal-bitte-ersetzen}"

if command -v tput >/dev/null 2>&1 && [[ -t 1 ]]; then
  ROT="$(tput setaf 1)"; GRUEN="$(tput setaf 2)"; GELB="$(tput setaf 3)"
  BLAU="$(tput setaf 4)"; FETT="$(tput bold)"; AUS="$(tput sgr0)"
else
  ROT=""; GRUEN=""; GELB=""; BLAU=""; FETT=""; AUS=""
fi

BESTANDEN=0
DURCHGEFALLEN=0

kopf() { printf '\n%s%s%s\n' "$FETT$BLAU" "$1" "$AUS"; }

pruefe() { # pruefe <beschreibung> <erwartet> <tatsächlich>
  if [[ "$2" == "$3" ]]; then
    printf '  %s✓%s %s  %s(%s)%s\n' "$GRUEN" "$AUS" "$1" "$GELB" "$3" "$AUS"
    BESTANDEN=$((BESTANDEN + 1))
  else
    printf '  %s✗%s %s  erwartet %s, bekommen %s\n' "$ROT" "$AUS" "$1" "$2" "$3"
    DURCHGEFALLEN=$((DURCHGEFALLEN + 1))
  fi
}

signiere() { # signiere <zeitstempel> <koerper>
  printf '%s' "$1.$2" | openssl dgst -sha256 -hmac "$GEHEIMNIS" | awk '{print "v1=" $NF}'
}

# ruft auf und legt Statuscode in ANTWORT_STATUS, Körper in ANTWORT_KOERPER ab
ruf() { # ruf <methode> <pfad> <koerper|""> <signiert:ja|nein> [zusatzkopf]
  local methode="$1" pfad="$2" koerper="$3" signiert="$4" zusatz="${5:-}"
  local zeit signatur ausgabe
  zeit="$(date +%s)"
  local -a argumente=(-sS -w $'\n%{http_code}' -X "$methode" "$BASIS$pfad" -H "Origin: $HERKUNFT")
  if [[ -n "$koerper" ]]; then
    argumente+=(-H 'content-type: application/json' --data-binary "$koerper")
  fi
  if [[ "$signiert" == "ja" ]]; then
    signatur="$(signiere "$zeit" "$koerper")"
    argumente+=(-H "x-relay-timestamp: $zeit" -H "x-relay-signature: $signatur")
  fi
  if [[ -n "$zusatz" ]]; then argumente+=(-H "$zusatz"); fi

  ausgabe="$(curl "${argumente[@]}" 2>/dev/null)"
  ANTWORT_STATUS="$(printf '%s' "$ausgabe" | tail -n1)"
  ANTWORT_KOERPER="$(printf '%s' "$ausgabe" | sed '$d')"
}

zeige() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$ANTWORT_KOERPER" | jq -C "${1:-.}" 2>/dev/null | sed 's/^/    /' || printf '    %s\n' "$ANTWORT_KOERPER"
  else
    printf '    %s\n' "$ANTWORT_KOERPER"
  fi
}

EVENT_ID="evt_$(openssl rand -hex 12)"
JETZT="$(date +%s)"

printf '%s\n' "$FETT=== MarTech Event Relay, Ende-zu-Ende-Test ===$AUS"
printf 'Ziel:      %s\n' "$BASIS"
printf 'Herkunft:  %s\n' "$HERKUNFT"
printf 'event_id:  %s\n' "$EVENT_ID"

# ---------------------------------------------------------------------------
kopf "1. Betriebszustand"
ruf GET /health "" nein
pruefe "GET /health antwortet 200" "200" "$ANTWORT_STATUS"
zeige '.config'

# ---------------------------------------------------------------------------
kopf "2. Browserereignis ohne Signatur, dafür mit erlaubter Herkunft"
EREIGNIS=$(cat <<JSON
{
  "event_id": "$EVENT_ID",
  "event_name": "demo_conversion_server",
  "event_time": $JETZT,
  "action_source": "website",
  "event_source_url": "https://beispiel.test/danke",
  "client_id": "1234567890.$JETZT",
  "user_data": {
    "email": "Max.Mustermann@Example.COM",
    "phone": "0151 51834055",
    "first_name": "Max",
    "last_name": "Mustermann",
    "country": "DE"
  },
  "custom_data": { "value": 49.9, "currency": "EUR", "content_name": "Demo" },
  "consent": { "analytics": true, "marketing": true }
}
JSON
)
ruf POST /collect "$EREIGNIS" nein
pruefe "wird angenommen" "200" "$ANTWORT_STATUS"
pruefe "gilt nicht als Duplikat" "false" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.duplicate' 2>/dev/null)"
zeige '{status, event_id, duplicate, sinks: [.sinks[] | {sink, status, http_status, duration_ms}]}'

# ---------------------------------------------------------------------------
kopf "3. Dasselbe Ereignis noch einmal, unverändert"
ruf POST /collect "$EREIGNIS" nein
pruefe "wird angenommen" "200" "$ANTWORT_STATUS"
pruefe "gilt jetzt als Duplikat" "true" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.duplicate' 2>/dev/null)"
pruefe "es wurde an kein Ziel weitergeleitet" "0" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.sinks | length' 2>/dev/null)"
zeige '.'

# ---------------------------------------------------------------------------
kopf "4. Signierter Server-zu-Server-Aufruf mit eigener event_id"
EVENT_ID_2="evt_$(openssl rand -hex 12)"
EREIGNIS_2="${EREIGNIS/$EVENT_ID/$EVENT_ID_2}"
ruf POST /collect "$EREIGNIS_2" ja
pruefe "wird angenommen" "200" "$ANTWORT_STATUS"
pruefe "wird als Serverquelle gezählt" "accepted" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.status' 2>/dev/null)"

# ---------------------------------------------------------------------------
kopf "5. Gefälschte Signatur"
ZEIT="$(date +%s)"
ruf_gefaelscht() {
  local ausgabe
  ausgabe="$(curl -sS -w $'\n%{http_code}' -X POST "$BASIS/collect" \
    -H 'content-type: application/json' \
    -H "x-relay-timestamp: $ZEIT" \
    -H "x-relay-signature: v1=$(printf '0%.0s' {1..64})" \
    --data-binary "$EREIGNIS_2" 2>/dev/null)"
  ANTWORT_STATUS="$(printf '%s' "$ausgabe" | tail -n1)"
  ANTWORT_KOERPER="$(printf '%s' "$ausgabe" | sed '$d')"
}
ruf_gefaelscht
pruefe "wird mit 401 abgewiesen" "401" "$ANTWORT_STATUS"
pruefe "Grund wird benannt" "bad_signature" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.reason' 2>/dev/null)"

# ---------------------------------------------------------------------------
kopf "6. Fehlerhaftes Schema"
KAPUTT='{"event_id":"evt_kaputt12345","evnet_name":"tippfehler","event_time":'"$JETZT"',"action_source":"website"}'
ruf POST /collect "$KAPUTT" nein
pruefe "wird mit 422 abgewiesen" "422" "$ANTWORT_STATUS"
zeige '.errors'

# ---------------------------------------------------------------------------
kopf "7. CAPI-Empfänger: ungehashte Daten werden nicht durchgelassen"
KLARTEXT='{"data":[{"event_name":"Lead","event_time":'"$JETZT"',"event_id":"evt_klartext001","action_source":"website","user_data":{"em":["max.mustermann@example.com"]}}]}'
ruf POST /capi/events "$KLARTEXT" ja
pruefe "wird mit 422 abgewiesen" "422" "$ANTWORT_STATUS"
zeige '.problems'

# ---------------------------------------------------------------------------
kopf "8. Wiederholversuch für einen Umschlag, den es nicht gibt"
ruf POST /replay '{"event_id":"evt_gibtesnicht9","sink":"ga4"}' ja
pruefe "wird mit 404 beantwortet" "404" "$ANTWORT_STATUS"
pruefe "ist als Endzustand gekennzeichnet" "true" "$(printf '%s' "$ANTWORT_KOERPER" | jq -r '.terminal' 2>/dev/null)"

# ---------------------------------------------------------------------------
kopf "9. Tageszähler"
ruf GET "/stats?days=1" "" nein
pruefe "GET /stats antwortet 200" "200" "$ANTWORT_STATUS"
zeige '.totals'

# ---------------------------------------------------------------------------
printf '\n%s' "$FETT"
if [[ $DURCHGEFALLEN -eq 0 ]]; then
  printf '%sAlle %d Prüfungen bestanden.%s\n\n' "$GRUEN" "$BESTANDEN" "$AUS"
  exit 0
else
  printf '%s%d bestanden, %d durchgefallen.%s\n\n' "$ROT" "$BESTANDEN" "$DURCHGEFALLEN" "$AUS"
  exit 1
fi
