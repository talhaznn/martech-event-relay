/** Kleine Helfer für Antworten und CORS. Bewusst knapp gehalten, damit die Handler lesbar bleiben. */

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

/**
 * Origin-Prüfung für Browseraufrufe.
 *
 * ALLOWED_ORIGINS ist eine kommagetrennte Liste. Der Wert "*" ist für die öffentliche Demo gedacht.
 * In einem Kundenprojekt stünden hier die tatsächlichen Shopdomains, denn CORS ist kein
 * Sicherheitsmerkmal gegen einen Angreifer mit curl, aber es hält fremde Webseiten davon ab, im
 * Namen des Nutzers Ereignisse einzuwerfen.
 */
export function isOriginAllowed(origin: string | null, allowed: string): boolean {
  const list = allowed.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (list.includes('*')) return true;
  if (!origin) return false;
  return list.includes(origin);
}

export function corsHeaders(origin: string | null, allowed: string): Record<string, string> {
  const list = allowed.split(',').map((entry) => entry.trim()).filter(Boolean);
  const value = list.includes('*') ? '*' : origin && list.includes(origin) ? origin : '';
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, x-relay-timestamp, x-relay-signature',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (value) headers['access-control-allow-origin'] = value;
  return headers;
}

/**
 * Antwort, wenn RELAY_HMAC_SECRET nicht gesetzt ist.
 *
 * Ohne Geheimnis kann weder signiert noch geprüft werden. Statt beim Signieren in einen
 * unbehandelten Fehler zu laufen und dem Aufrufer ein nichtssagendes 500 zu geben, sagt der Relay
 * hier klar, was fehlt und wie es zu beheben ist.
 */
export function fehlendesGeheimnis(): Response {
  return jsonResponse(
    {
      error: 'hmac_secret_missing',
      detail: 'RELAY_HMAC_SECRET ist nicht gesetzt. Setzen mit: npx wrangler secret put RELAY_HMAC_SECRET',
    },
    503,
  );
}
