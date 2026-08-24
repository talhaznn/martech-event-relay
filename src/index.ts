import type { Env } from './types.ts';
import { handleCapiEvents } from './capi-receiver.ts';
import { handleCollect } from './collect.ts';
import { handleReplay } from './replay.ts';
import { corsHeaders, jsonResponse } from './http.ts';
import { readRing } from './log.ts';
import { summarize } from './stats.ts';

/**
 * Router des Relays.
 *
 * Der Worker ist bewusst klein gehalten. Statische Dateien liegen unter public und werden von
 * Cloudflare direkt ausgeliefert, ohne dass der Worker sie sieht. Alles, was hier ankommt, ist ein
 * echter API-Aufruf.
 *
 *   POST /collect       Haupteingang für Ereignisse
 *   POST /replay        Wiederholversuch für genau ein Ziel, immer signiert
 *   POST /capi/events   nachgebildeter Empfänger in der Form der Meta Conversions API
 *   GET  /stats         Tageszähler, Grundlage des n8n-Berichts
 *   GET  /health        Betriebszustand und welche Einstellungen gesetzt sind
 *   GET  /debug/recent  die letzten Logzeilen aus dem Ringpuffer
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const headers = corsHeaders(origin, env.ALLOWED_ORIGINS ?? '*');
    const now = Math.floor(Date.now() / 1000);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (url.pathname === '/collect') {
        if (request.method !== 'POST') return methodNotAllowed(headers);
        return await handleCollect(request, env, await request.text(), now);
      }

      if (url.pathname === '/replay') {
        if (request.method !== 'POST') return methodNotAllowed(headers);
        return await handleReplay(request, env, await request.text(), now);
      }

      if (url.pathname === '/capi/events') {
        if (request.method !== 'POST') return methodNotAllowed(headers);
        return await handleCapiEvents(request, env, await request.text(), now);
      }

      if (url.pathname === '/stats') {
        if (request.method !== 'GET') return methodNotAllowed(headers);
        const days = Number(url.searchParams.get('days') ?? '1');
        const summary = await summarize(env.RELAY, now, Number.isFinite(days) ? days : 1);
        const totals: Record<string, number> = {};
        for (const day of summary) {
          for (const [bucket, count] of Object.entries(day.counts)) {
            totals[bucket] = (totals[bucket] ?? 0) + count;
          }
        }
        return jsonResponse({ generated_at: new Date(now * 1000).toISOString(), days: summary, totals }, 200, headers);
      }

      if (url.pathname === '/health') {
        return jsonResponse(
          {
            status: 'ok',
            time: new Date(now * 1000).toISOString(),
            // Nur Ja oder Nein, niemals die Werte selbst.
            config: {
              ga4_measurement_id_set: Boolean(env.GA4_MEASUREMENT_ID),
              ga4_api_secret_set: Boolean(env.GA4_API_SECRET),
              ga4_debug: env.GA4_DEBUG === 'true',
              hmac_secret_set: Boolean(env.RELAY_HMAC_SECRET),
              n8n_retry_webhook_set: Boolean(env.N8N_RETRY_WEBHOOK),
              capi_endpoint: env.CAPI_ENDPOINT || '(intern, /capi/events)',
              allowed_origins: env.ALLOWED_ORIGINS,
              dedupe_ttl_seconds: Number(env.DEDUPE_TTL_SECONDS) || 86400,
            },
          },
          200,
          headers,
        );
      }

      if (url.pathname === '/debug/recent') {
        return jsonResponse({ lines: await readRing(env.RELAY) }, 200, headers);
      }

      return jsonResponse(
        {
          error: 'not_found',
          path: url.pathname,
          routes: ['POST /collect', 'POST /replay', 'POST /capi/events', 'GET /stats', 'GET /health', 'GET /debug/recent'],
        },
        404,
        headers,
      );
    } catch (error) {
      // Ein unerwarteter Fehler darf nie stillschweigend als Erfolg durchgehen. Der Aufrufer bekommt
      // 500, damit ein Wiederholversuch überhaupt eine Chance hat, und die Zeile landet im Log.
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'unhandled_error', path: url.pathname, error: String(error) }));
      return jsonResponse({ error: 'internal_error', detail: String(error) }, 500, headers);
    }
  },
} satisfies ExportedHandler<Env>;

function methodNotAllowed(headers: Record<string, string>): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, headers);
}
