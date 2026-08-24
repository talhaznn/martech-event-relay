# Runbook: von null auf laufende Demo

Diese Anleitung führt von einem frisch geklonten Verzeichnis zu einer öffentlich erreichbaren Demo
mit echten Daten in GA4 und einem grün durchgelaufenen n8n-Workflow. Zeitbedarf ungefähr eine Stunde,
mit Pausen an den Stellen, an denen Google auf sich warten lässt.

Reihenfolge einhalten. Jeder Schritt setzt den vorherigen voraus.

---

## 0. Vorbereitung

**Nur private Konten verwenden.** Kein Konto des Arbeitgebers, weder bei Google noch bei Cloudflare,
weder für die Property noch für den Worker. Das ist keine Formalie, sondern der Grund, warum sich
später jeder Screenshot bedenkenlos zeigen lässt.

Gebraucht werden:

- ein privates Google-Konto für GA4 und den Tag Manager
- ein privates Cloudflare-Konto
- Node ab Version 22, `openssl`, `jq`

Prüfen:

```bash
node --version && openssl version && jq --version
```

---

## 1. Cloudflare, ungefähr 15 Minuten

```bash
cd martech-event-relay
npx wrangler login
```

Der Browser öffnet sich und fragt nach der Freigabe. Danach den Speicher anlegen:

```bash
npx wrangler kv namespace create RELAY
```

Die Ausgabe enthält eine `id`. Diese in `wrangler.toml` eintragen und den Platzhalter
`0000000000000000000000000000ffff` ersetzen.

Ein Geheimnis erzeugen und setzen:

```bash
openssl rand -hex 32          # Ausgabe merken, sie wird später in n8n noch einmal gebraucht
npx wrangler secret put RELAY_HMAC_SECRET
```

Veröffentlichen:

```bash
npx wrangler deploy
```

Die Ausgabe nennt eine Adresse der Form `https://martech-event-relay.<name>.workers.dev`. Diese
Adresse wird ab hier **BASIS** genannt.

Prüfen, dass sie von außen antwortet:

```bash
curl -s https://martech-event-relay.<name>.workers.dev/health | jq .
```

> **Achtung beim Cloudflare-Dashboard.** Auf demselben Konto liegen andere Projekte. Beim
> Screenshotten später nie die Übersichtsseite mit der Liste aller Worker aufnehmen, sondern immer
> nur die Detailseite dieses einen Workers.

---

## 2. Google Analytics 4, ungefähr 15 Minuten

1. <https://analytics.google.com> → **Verwaltung → Property erstellen**
   Name zum Beispiel `MarTech Event Relay Demo`, Zeitzone Deutschland, Währung Euro.
2. **Datenstream erstellen → Web**, als Adresse die BASIS eintragen.
3. Die **Messstream-ID** der Form `G-XXXXXXXXXX` notieren.
4. Im Datenstream nach unten scrollen → **Measurement Protocol API secrets → Erstellen**,
   Name zum Beispiel `relay`. Den Wert notieren.

Dann in `wrangler.toml`:

```toml
GA4_MEASUREMENT_ID = "G-XXXXXXXXXX"
GA4_DEBUG = "true"
```

Und das Geheimnis setzen:

```bash
npx wrangler secret put GA4_API_SECRET
npx wrangler deploy
```

Sofort prüfen, ob GA4 die Nutzlast akzeptiert:

```bash
./scripts/send-test-events.sh https://martech-event-relay.<name>.workers.dev
```

Bei `GA4_DEBUG = "true"` enthält die Antwort des GA4-Sinks ein Feld `validation_messages`. Ist es
eine leere Liste, ist die Nutzlast fachlich in Ordnung. Steht dort etwas, benennt Google das Problem
im Klartext.

> Ein Statuscode 204 vom Measurement Protocol heißt **nicht**, dass die Nutzlast stimmt. Google
> antwortet auch auf Unsinn mit 204. Nur `validation_messages` gibt darüber Auskunft.

**In GA4 nachsehen:** Verwaltung → **DebugView**. Dort muss `demo_conversion_server` erscheinen. Bis
zum ersten Ereignis können ein bis zwei Minuten vergehen.

---

## 3. Google Tag Manager, ungefähr 15 Minuten

1. <https://tagmanager.google.com> → **Konto erstellen**, Containertyp **Web**.
2. Die Container-ID der Form `GTM-XXXXXXX` notieren.
3. **Verwaltung → Container importieren** → Datei `gtm/container-export.json` wählen,
   Arbeitsbereich **Default Workspace**, Option **Überschreiben**.
4. Danach **Variablen → `Konstante – Messstream-ID`** öffnen und die eigene `G-XXXXXXXXXX` eintragen.
5. **Senden** und veröffentlichen.

Scheitert der Import, steht in [../gtm/MANUELLE-EINRICHTUNG.md](../gtm/MANUELLE-EINRICHTUNG.md)
derselbe Aufbau von Hand. Das dauert zehn Minuten und ist nicht schlimmer.

**Die Demoseite verbinden.** Auf `BASIS` gehen, unten in der Karte **Einstellungen** die
Container-ID und die Messstream-ID eintragen, dann **Speichern und Seite neu laden**. Die drei
Anzeigen oben müssen danach grün sein.

**Vorschau prüfen.** Im Tag Manager auf **Vorschau**, die BASIS eintragen, verbinden lassen. Auf der
Demoseite eine Konversion auslösen. Im Tag Assistant muss links `demo_conversion` stehen, rechts das
Tag unter **Tags Fired**, und unter **Variables** muss `dlv – event_id` einen Wert der Form `evt_...`
zeigen.

---

## 4. n8n, ungefähr 20 Minuten

```bash
npx n8n
```

Beim ersten Start fragt n8n nach einem Konto. Das ist eine rein lokale Anmeldung, die Zugangsdaten
verlassen den Rechner nicht.

**Workflow 1, retry-failed-events**

1. **Workflows → Import from File** → `n8n/retry-failed-events.json`
2. Knoten **HMAC bilden** öffnen, unter **Secret** dasselbe Geheimnis eintragen wie in
   `RELAY_HMAC_SECRET`.
3. Workflow speichern und aktivieren. Die Produktiv-Adresse des Webhooks aus dem ersten Knoten
   kopieren.
4. Diese Adresse in den Worker eintragen:

```bash
npx wrangler secret put N8N_RETRY_WEBHOOK
npx wrangler deploy
```

**Workflow 2, daily-summary**

1. **Import from File** → `n8n/daily-summary.json`
2. Knoten **Einstellungen** öffnen, bei `relay_basis` die BASIS eintragen.
3. **Test workflow** anklicken. Der Lauf muss grün durchgehen und im Knoten **Bericht bauen** eine
   Zeile mit Zustell- und Dublettenquote zeigen.

Der Google-Sheets-Knoten am Ende ist absichtlich deaktiviert, damit der Workflow ohne Zugangsdaten
läuft. Wer ihn will: Tabelle anlegen, Zugangsdaten verbinden, Haken bei **Disabled** entfernen.

**Den Wiederholweg einmal echt auslösen.** Dafür wird ein Fehlschlag erzwungen:

```bash
# 1. Ziel absichtlich kaputt machen. Die Endung .invalid loest per Norm nie auf.
npx wrangler deploy --var CAPI_ENDPOINT:https://kein-empfaenger.invalid/events

# 2. Ereignis senden, das jetzt scheitern muss
./scripts/send-test-events.sh https://martech-event-relay.<name>.workers.dev

# 3. Ziel wieder heil machen
npx wrangler deploy
```

Nach Schritt zwei steht in n8n unter **Executions** ein Lauf von `retry-failed-events`. Er wartet
fünfzehn Sekunden und versucht es dann erneut. Läuft Schritt drei rechtzeitig, endet der Lauf grün
bei **Zugestellt**. Wenn nicht, zählt er hoch und endet nach dem dritten Versuch bei **Alarm**.
Beides ist ein gutes Bild, das erste ist das bessere.

---

## 5. Die sechs Screenshots

Vor dem ersten Screenshot einmal aufräumen. Diese Punkte sind die häufigste Stelle, an der etwas
durchrutscht, das niemanden etwas angeht:

- **Alle anderen Browser-Tabs schließen.** Tab-Titel sind lesbar.
- **Lesezeichenleiste ausblenden** mit `Cmd + Shift + B`.
- **Kein Cloudflare-Dashboard mit der Worker-Übersicht.** Nur die Detailseite dieses Workers.
- **Terminal-Eingabeaufforderung prüfen.** Zeigt sie einen Verzeichnispfad mit anderen Projektnamen,
  vorher `cd` in dieses Verzeichnis und das Fenster maximieren, sodass nur der relevante Teil zu
  sehen ist.
- **Keine Benachrichtigungen.** Nicht-stören-Modus einschalten.
- **Ausschnitt so klein wie möglich.** `Cmd + Shift + 4` statt Vollbild.

Dann der Reihe nach:

| Nr. | Was | Wo | Worauf es ankommt |
|---|---|---|---|
| 1 | GA4 **DebugView** mit `demo_conversion` und `demo_conversion_server` nebeneinander | GA4 → Verwaltung → DebugView | Beide Ereignisse sichtbar, der Parameter `event_id` aufgeklappt und in beiden identisch |
| 2 | **Tag Assistant** mit gefeuertem Tag | GTM-Vorschau | Links `demo_conversion`, rechts unter **Tags Fired**, unter **Variables** die `event_id` |
| 3 | **Demoseite mit Duplikat** | BASIS | Zwei Einträge im Protokoll: oben `DUPLIKAT`, darunter `ANGENOMMEN`, beide mit derselben `event_id` |
| 4 | **Terminal mit dem Ende-zu-Ende-Test** | `./scripts/send-test-events.sh BASIS` | Die grünen Haken und die Schlusszeile `Alle 15 Prüfungen bestanden` |
| 5 | **n8n-Canvas** `retry-failed-events` mit grünem Lauf | n8n → Executions | Der Pfad bis **Zugestellt** grün eingefärbt |
| 6 | **n8n-Canvas** `daily-summary` mit der Ausgabe von **Bericht bauen** | n8n | Die Zeile mit Zustell- und Dublettenquote lesbar |

Screenshot 3 ist der wichtigste. Er zeigt in einem Bild, worum es in dem ganzen Projekt geht.

---

## 6. Wenn etwas nicht geht

**In DebugView kommt nichts an.**
Reihenfolge prüfen: Antwortet `/health`? Steht `ga4_api_secret_set: true`? Ist `GA4_DEBUG` auf
`"true"`? DebugView zeigt nur Ereignisse mit dem Parameter `debug_mode`, den der Worker genau dann
setzt. Und ein frisch angelegter Datenstream braucht manchmal ein paar Minuten.

**Der Tag feuert nicht.**
Fast immer stimmt der Ereignisname nicht überein. Der Trigger im Tag Manager horcht auf
`demo_conversion`. Auf der Demoseite steht der Name im Feld **Ereignisname**. Beide müssen exakt
gleich sein.

**Der Browser meldet einen CORS-Fehler.**
`ALLOWED_ORIGINS` steht auf `*`, solange die Demoseite und der Worker unter derselben Adresse liegen,
ist CORS gar nicht im Spiel. Tritt der Fehler trotzdem auf, wird die Seite von einer anderen Adresse
aus aufgerufen, zum Beispiel `localhost:8788` gegen den veröffentlichten Worker. Dann entweder die
Adresse in `ALLOWED_ORIGINS` eintragen oder beides von derselben Adresse laden.

**n8n bekommt kein Ticket.**
`curl -s BASIS/health | jq .config.n8n_retry_webhook_set` muss `true` liefern. Und der Workflow muss
**aktiviert** sein, sonst antwortet nur die Test-Adresse des Webhooks, nicht die Produktiv-Adresse.

**Der Wiederholversuch endet mit 404.**
Dann ist der zwischengelagerte Umschlag abgelaufen, standardmäßig nach vierundzwanzig Stunden. Das
ist ein Endzustand und kein Fehler. Der Workflow erkennt das am Feld `terminal` und hört auf, statt
sinnlos weiterzuprobieren.
