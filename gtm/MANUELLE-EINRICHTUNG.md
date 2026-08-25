# Google Tag Manager von Hand einrichten

Die Datei `container-export.json` daneben lässt sich im Tag Manager unter
**Verwaltung → Container importieren** einspielen. Das spart etwa zwanzig Minuten.

Container-Exporte sind allerdings an die Fassung des Tag Managers gebunden, in der sie entstanden
sind. Scheitert der Import, ist hier der Weg von Hand. Er dauert etwa zehn Minuten und führt zum
selben Ergebnis.

## 1. Variablen

**Verwaltung → Variablen → Nutzerdefinierte Variablen → Neu**

| Name | Typ | Einstellung |
|---|---|---|
| `Konstante – Messstream-ID` | Konstant | Wert: die eigene Messstream-ID, Form `G-XXXXXXXXXX` |
| `dlv – event_id` | Datenschichtvariable | Name der Variablen: `event_id`, Version 2 |
| `dlv – value` | Datenschichtvariable | Name der Variablen: `value`, Version 2 |
| `dlv – currency` | Datenschichtvariable | Name der Variablen: `currency`, Version 2 |

Die Konstante ist Bequemlichkeit, keine Notwendigkeit. Sie sorgt dafür, dass die Messstream-ID an
genau einer Stelle steht und nicht in jedem Tag einzeln.

## 2. Trigger

**Trigger → Neu → Benutzerdefiniertes Ereignis**

- Name: `Benutzerdefiniertes Ereignis – demo_conversion`
- Ereignisname: `demo_conversion`
- Dieser Trigger wird ausgelöst bei: **Allen benutzerdefinierten Ereignissen**

Der Name muss exakt dem entsprechen, was die Demoseite in den dataLayer schreibt. Steht im
Ereignisnamen-Feld der Seite etwas anderes, wird auch hier etwas anderes gebraucht.

## 3. Basis-Tag

**Tags → Neu → Google Tag**

- Name: `Google Tag – GA4`
- Tag-ID: `{{Konstante – Messstream-ID}}`
- Trigger: **Initialisierung – Alle Seiten** oder **Alle Seiten**

Ohne dieses Tag lädt gtag.js nicht, und das Ereignis-Tag darunter feuert ins Leere. Das ist der
häufigste Grund dafür, dass in DebugView gar nichts ankommt.

## 4. Ereignis-Tag

**Tags → Neu → Google Analytics: GA4-Ereignis**

- Name: `GA4 Ereignis – demo_conversion`
- Messungs-ID: `{{Konstante – Messstream-ID}}`
- Ereignisname: `demo_conversion`
- Ereignisparameter:

| Parametername | Wert |
|---|---|
| `event_id` | `{{dlv – event_id}}` |
| `relay_event_id` | `{{dlv – event_id}}` |
| `value` | `{{dlv – value}}` |
| `currency` | `{{dlv – currency}}` |
| `relay_source` | `browser` |

- Trigger: `Benutzerdefiniertes Ereignis – demo_conversion`

> Warum die Kennung zweimal steht: `event_id` hat bei Meta eine feste Bedeutung, dort läuft die
> Zusammenführung von Browser- und Serverereignis darüber. `relay_event_id` ist ein selbst
> vergebener Name ohne Sonderbedeutung bei irgendeinem Ziel. Damit hängt der Vergleich der beiden
> Wege nicht davon ab, wie ein Ziel `event_id` auslegt. In GA4 DebugView stehen beide Parameter.

## 5. Vorschau und Veröffentlichen

1. **Vorschau** anklicken, die Adresse der Demoseite eintragen, verbinden lassen.
2. Auf der Demoseite eine Konversion auslösen.
3. Im Tag Assistant muss links das Ereignis `demo_conversion` stehen und rechts das Tag unter
   **Tags Fired**. Unter **Variables** muss `dlv – event_id` einen Wert wie `evt_...` zeigen.
4. Erst danach **Senden** und veröffentlichen.

## Warum das Serverereignis anders heißt

Der Tag Manager schickt `demo_conversion`. Der Worker schickt `demo_conversion_server`. Beide tragen
denselben Parameter `event_id`.

Meta dedupliziert Browser- und Serverereignis anhand von `event_id` und `event_name` selbst.
**GA4 tut das nicht.** Wer dieselbe Konversion unter demselben Namen einmal über den Tag Manager und
einmal über das Measurement Protocol schickt, hat sie in GA4 zweimal und misst seine Kampagnen
doppelt so gut, wie sie sind.

Deshalb unterscheiden sich die Namen, und die Zusammengehörigkeit hängt am gemeinsamen Parameter.
In DebugView stehen beide nebeneinander und lassen sich über die `event_id` derselben Anfrage
zuordnen.
