#!/usr/bin/env bash
#
# Wiederholtest: erzwungener Fehlschlag, dann Zustellung im zweiten Anlauf.
#
# Der Test fährt alles selbst hoch, was er braucht, und räumt am Ende wieder auf:
# einen nachgebauten CAPI-Empfänger, der die ersten Aufrufe mit 503 beantwortet, und
# den Worker über wrangler dev mit einem frisch erzeugten Wegwerf-Geheimnis. Ein
# echtes Geheimnis wird nirgends gebraucht und nirgends gelesen.
#
# Ohne GA4_API_SECRET läuft der GA4-Sink im Trockenlauf. Es geht also nichts an Google.
#
# Aufruf:
#   ./scripts/wiederholtest.sh              nur der Relay, Wiederholung direkt signiert
#   ./scripts/wiederholtest.sh --mit-n8n    Wiederholung über eine laufende n8n-Instanz
#
# Für --mit-n8n muss n8n auf N8N_BASIS laufen, der Workflow aus n8n/retry-failed-events.json
# importiert und veröffentlicht sein, und im Knoten "HMAC bilden" muss dasselbe Geheimnis
# stehen, das dieses Skript ausgibt.

set -uo pipefail

EMPFAENGER_PORT="${EMPFAENGER_PORT:-8788}"
RELAY_PORT="${RELAY_PORT:-8790}"
N8N_BASIS="${N8N_BASIS:-http://127.0.0.1:5678}"
WEBHOOK="$N8N_BASIS/webhook/relay-retry"
BASIS="http://127.0.0.1:$RELAY_PORT"
MIT_N8N="nein"
[[ "${1:-}" == "--mit-n8n" ]] && MIT_N8N="ja"

if command -v tput >/dev/null 2>&1 && [[ -t 1 ]]; then
  ROT="$(tput setaf 1)"; GRUEN="$(tput setaf 2)"; GELB="$(tput setaf 3)"
  BLAU="$(tput setaf 4)"; FETT="$(tput bold)"; AUS="$(tput sgr0)"
else
  ROT=""; GRUEN=""; GELB=""; BLAU=""; FETT=""; AUS=""
fi

BESTANDEN=0
DURCHGEFALLEN=0
ARBEIT="$(mktemp -d)"
PID_EMPFAENGER=""
PID_RELAY=""

kopf() { printf '\n%s%s%s\n' "$FETT$BLAU" "$1" "$AUS"; }
hinweis() { printf '  %s%s%s\n' "$GELB" "$1" "$AUS"; }

pruefe() { # pruefe <beschreibung> <erwartet> <tatsächlich>
  if [[ "$2" == "$3" ]]; then
    printf '  %s✓%s %s  %s(%s)%s\n' "$GRUEN" "$AUS" "$1" "$GELB" "$3" "$AUS"
    BESTANDEN=$((BESTANDEN + 1))
  else
    printf '  %s✗%s %s  erwartet %s, bekommen %s\n' "$ROT" "$AUS" "$1" "$2" "$3"
    DURCHGEFALLEN=$((DURCHGEFALLEN + 1))
  fi
}

aufraeumen() {
  [[ -n "$PID_RELAY" ]] && kill "$PID_RELAY" 2>/dev/null
  [[ -n "$PID_EMPFAENGER" ]] && kill "$PID_EMPFAENGER" 2>/dev/null
  sleep 1
  rm -rf "$ARBEIT"
}
trap aufraeumen EXIT INT TERM

signiere() { # signiere <zeitstempel> <koerper>
  printf '%s' "$1.$2" | openssl dgst -sha256 -hmac "$GEHEIMNIS" | awk '{print "v1=" $NF}'
}

warte_auf() { # warte_auf <url> <sekunden>
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    curl -s -o /dev/null -m 2 "$1" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

# ---------------------------------------------------------------------------
kopf "1. Umgebung hochfahren"

GEHEIMNIS="$(openssl rand -hex 32)"
printf '  Wegwerf-Geheimnis: %s%s…%s  (gilt nur für diesen Lauf)\n' "$GELB" "${GEHEIMNIS:0:16}" "$AUS"

node scripts/wiederhol-empfaenger.mjs "$EMPFAENGER_PORT" 1 > "$ARBEIT/empfaenger.log" 2>&1 &
PID_EMPFAENGER=$!
warte_auf "http://127.0.0.1:$EMPFAENGER_PORT/status" 10
pruefe "CAPI-Empfänger antwortet" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$EMPFAENGER_PORT/status")"

npx wrangler dev \
  --port "$RELAY_PORT" \
  --var RELAY_HMAC_SECRET:"$GEHEIMNIS" \
  --var CAPI_ENDPOINT:"http://127.0.0.1:$EMPFAENGER_PORT/capi" \
  --var N8N_RETRY_WEBHOOK:"$WEBHOOK" \
  > "$ARBEIT/relay.log" 2>&1 &
PID_RELAY=$!

if ! warte_auf "$BASIS/health" 90; then
  printf '  %s✗%s wrangler dev kam nicht hoch. Log: %s\n' "$ROT" "$AUS" "$ARBEIT/relay.log"
  exit 1
fi
pruefe "Relay antwortet auf /health" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASIS/health")"
pruefe "GA4 läuft im Trockenlauf" "false" "$(curl -s "$BASIS/health" | tr -d ' \n' | grep -o '"ga4_api_secret_set":[a-z]*' | cut -d: -f2)"

# ---------------------------------------------------------------------------
kopf "2. Erster Zustellversuch, er muss scheitern"

JETZT="$(date +%s)"
EVENT_ID="evt_$(openssl rand -hex 16)"
EREIGNIS=$(cat <<JSON
{
  "event_id": "$EVENT_ID",
  "event_name": "demo_conversion_server",
  "event_time": $JETZT,
  "action_source": "website",
  "event_source_url": "https://beispiel.test/danke",
  "client_id": "1234567890.$JETZT",
  "user_data": { "email": "Max.Mustermann@Example.COM", "country": "DE" },
  "custom_data": { "value": 49.9, "currency": "EUR" },
  "consent": { "analytics": true, "marketing": true }
}
JSON
)
printf '  event_id: %s%s%s\n' "$GELB" "$EVENT_ID" "$AUS"
ANTWORT="$(curl -s -X POST "$BASIS/collect" -H 'content-type: application/json' --data-binary "$EREIGNIS")"
# Die Antwort ist eingerückt. Vor dem Auswerten Leerzeichen und Umbrüche entfernen.
ANTWORT_ENG="$(printf '%s' "$ANTWORT" | tr -d ' \n')"
pruefe "Ereignis wird angenommen" "accepted" "$(printf '%s' "$ANTWORT_ENG" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)"
pruefe "CAPI-Sink scheitert wie geplant" "503" "$(printf '%s' "$ANTWORT_ENG" | grep -o '"http_status":503' | head -1 | cut -d: -f2)"
pruefe "Umschlag liegt für die Wiederholung bereit" "1" "$(printf '%s' "$ANTWORT_ENG" | grep -c 'Wiederholversuch')"

# ---------------------------------------------------------------------------
if [[ "$MIT_N8N" == "ja" ]]; then
  kopf "3. Wiederholung über n8n"
  if ! curl -s -o /dev/null -m 3 "$N8N_BASIS" 2>/dev/null; then
    printf '  %s✗%s n8n ist unter %s nicht erreichbar.\n' "$ROT" "$AUS" "$N8N_BASIS"
    DURCHGEFALLEN=$((DURCHGEFALLEN + 1))
  else
    hinweis "Der Worker hat das Ticket abgesetzt. n8n wartet fünfzehn Sekunden, dann signiert es."
    hinweis "Im Knoten \"HMAC bilden\" muss das oben ausgegebene Geheimnis stehen."
    sleep 25
    pruefe "Wiederholung wurde zugestellt" "1" "$(grep -c '"msg":"replay_result".*"status":"sent"' "$ARBEIT/relay.log")"
  fi
else
  kopf "3. Wiederholung ohne n8n, direkt signiert"
  hinweis "Dies ist derselbe Aufruf, den n8n macht. Wer den Weg über n8n sehen will,"
  hinweis "startet das Skript mit --mit-n8n."
  KOERPER="{\"event_id\":\"$EVENT_ID\",\"sink\":\"capi\"}"
  ZEIT="$(date +%s)"
  STATUS="$(curl -s -o "$ARBEIT/replay.json" -w '%{http_code}' -X POST "$BASIS/replay" \
    -H 'content-type: application/json' \
    -H "x-relay-timestamp: $ZEIT" \
    -H "x-relay-signature: $(signiere "$ZEIT" "$KOERPER")" \
    --data-binary "$KOERPER")"
  pruefe "Signatur wird akzeptiert, Wiederholung läuft" "200" "$STATUS"
  pruefe "Ziel meldet Zustellung" "sent" "$(tr -d ' \n' < "$ARBEIT/replay.json" | grep -o '"status":"[a-z]*"' | tail -1 | cut -d'"' -f4)"

  ZEIT2="$(date +%s)"
  pruefe "gefälschte Signatur wird abgewiesen" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASIS/replay" \
    -H 'content-type: application/json' \
    -H "x-relay-timestamp: $ZEIT2" \
    -H "x-relay-signature: v1=$(printf '%064d' 0)" \
    --data-binary "$KOERPER")"
fi

# ---------------------------------------------------------------------------
kopf "4. Was der Empfänger gesehen hat"
sed 's/^/  /' "$ARBEIT/empfaenger.log"

kopf "Ergebnis"
printf '  %s%s bestanden%s' "$GRUEN" "$BESTANDEN" "$AUS"
if [[ "$DURCHGEFALLEN" -gt 0 ]]; then
  printf ', %s%s durchgefallen%s\n\n' "$ROT" "$DURCHGEFALLEN" "$AUS"
  exit 1
fi
printf ', keine Fehlschläge\n\n'
