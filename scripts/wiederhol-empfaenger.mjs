// Nachgebauter CAPI-Empfänger für den Wiederholtest.
//
// Er antwortet auf die ersten N Aufrufe mit 503 und erst danach mit 200. Damit lässt sich
// der Wiederholweg vorführen, ohne auf eine echte Störung zu warten und ohne irgendwo
// Zugangsdaten zu brauchen. Der Fehler ist echt, der Zeitpunkt ist gewählt.
//
// Aufruf:
//   node scripts/wiederhol-empfaenger.mjs [port] [anzahl-fehlschlaege]
//
// Nebenwege:
//   GET  /status            aktueller Zählerstand
//   POST /zuruecksetzen/<n> Zähler auf null, die nächsten n Aufrufe scheitern
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8788);
let scheiternBis = Number(process.argv[3] ?? 1);
let aufrufe = 0;

const antworte = (res, status, koerper) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(koerper));
};

createServer((req, res) => {
  let koerper = '';
  req.on('data', (teil) => (koerper += teil));
  req.on('end', () => {
    if (req.url === '/status') return antworte(res, 200, { aufrufe, scheiternBis });

    if (req.url?.startsWith('/zuruecksetzen/')) {
      scheiternBis = Number(req.url.split('/')[2]) || 0;
      aufrufe = 0;
      return antworte(res, 200, { zurueckgesetzt: true, scheiternBis });
    }

    aufrufe += 1;
    const scheitert = aufrufe <= scheiternBis;
    console.log(
      `[${new Date().toISOString()}] Aufruf ${aufrufe} ${req.method} ${req.url}`
      + ` -> ${scheitert ? 503 : 200}  (${koerper.length} Bytes)`,
    );

    if (scheitert) {
      return antworte(res, 503, {
        error: 'Empfänger vorübergehend nicht verfügbar',
        aufruf: aufrufe,
      });
    }
    antworte(res, 200, { events_received: 1, aufruf: aufrufe });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Wiederhol-Empfänger auf http://127.0.0.1:${PORT}, die ersten ${scheiternBis} Aufrufe scheitern.`);
});
