# athena · observe

OpenTelemetry-Collector **und** Weboberfläche in einem Prozess, um Claude-Agent-SDK- und
Claude-Code-Sessions zu beobachten: welche Tools liefen, wie lange jeder Modell-Request
gedauert hat, wie viele Tokens geflossen sind, was gekostet wurde und wo etwas
fehlgeschlagen ist.

Keine Dependencies, kein Build-Schritt, keine Datenbank — nur Node ≥ 20.11. Das ist
Absicht: das Tool soll in einem beliebigen Sandbox-Container per `node bin/athena-observe.mjs`
starten, auch ohne `npm install`.

Gedacht zum Selbst-Betreiben auf dem eigenen Rechner: kein Konto, kein fremder Dienst,
keine laufenden Kosten. Die Telemetrie bleibt dort, wo sie entsteht — siehe
[Selbst hosten](#selbst-hosten).

```
┌──────────────┐  OTLP/HTTP   ┌────────────────────────────┐
│ Claude Code  │─────────────▶│  athena-observe :4318      │
│ / Agent SDK  │  protobuf    │  /v1/traces /v1/metrics    │
└──────────────┘  oder json   │  /v1/logs   +  Web-UI  /   │
                              └────────────────────────────┘
```

## Schnellstart

```bash
cd tools/observability

# 1. Collector + UI starten (Ingest und UI teilen sich einen Port)
node bin/athena-observe.mjs                # http://127.0.0.1:4318

# 2. In einer zweiten Shell: Agent auf den Collector zeigen lassen
eval "$(node bin/athena-observe.mjs env)"
claude -p "Was macht dieses Repo?"

# 3. http://127.0.0.1:4318 im Browser öffnen
```

Ohne echten Agent-Run lässt sich die UI mit synthetischen Daten befüllen:

```bash
node bin/athena-observe.mjs &
node scripts/demo-emit.mjs --sessions 3      # oder --live für laufenden Nachschub
```

## Agent anbinden

`athena-observe env` gibt genau den Block aus, den die Doku-Seite
[Observability](https://code.claude.com/docs/en/agent-sdk/observability) verlangt:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY="1"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA="1"   # nötig für Spans (Beta)
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_METRIC_EXPORT_INTERVAL="1000"        # Default 60s ist für kurze Runs zu träge
export OTEL_LOGS_EXPORT_INTERVAL="1000"
export OTEL_TRACES_EXPORT_INTERVAL="1000"
```

`--format json` bzw. `--format dotenv` liefern dieselben Werte für `options.env`
(TypeScript/Python SDK) oder eine `.env`-Datei. Der Setup-Dialog in der UI zeigt
fertige Snippets für beide SDKs.

### Dauerhaft einschalten

Ein `export` gilt nur für die Shell, in der es abgesetzt wurde. Claude Code liest die
Konfiguration **beim Prozessstart**, eine bereits laufende Session lässt sich also nicht
nachträglich erfassen — erfasst wird immer erst die nächste.

Damit man nicht daran denken muss, gehört der Block in die persönlichen Projekt-Settings:

```bash
node bin/athena-observe.mjs env --format settings > ../../.claude/settings.local.json
```

Das schreibt `{"env": {…}}`, und Claude Code wendet das auf jede Session in diesem
Projekt an. Bewusst `settings.local.json` und nicht `settings.json`: Letzteres wird
mitversioniert und würde jeden Mitwirkenden im Sekundentakt gegen einen Collector
exportieren lassen, den er gar nicht betreibt. `settings.local.json` steht in
`.gitignore`.

> Hat die Datei schon Inhalt, überschreibt `>` sie. Dann den `env`-Block von Hand
> einfügen statt umleiten.

Danach eine **neue** Session starten — die laufende ändert sich nicht mehr.

Für Cloud-Sessions (Claude Code on the web) gehören dieselben Variablen in die
Environment-Einstellungen der Web-Oberfläche, nicht in eine Datei im Repo: dort landet
sonst das Token im Versionsverlauf. Der Endpunkt muss zusätzlich aus dem
Session-Container erreichbar sein — siehe [Selbst hosten](#3-agent-in-einer-cloud-session-claude-code-on-the-web-actions-container).

Drei Signale, drei unabhängige Schalter — jedes funktioniert für sich:

| Signal      | Schalter                                              | Was die UI daraus baut                                  |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Metrics     | `OTEL_METRICS_EXPORTER=otlp`                          | Tokens, Kosten, Lines of Code, Commits, aktive Zeit      |
| Log-Events  | `OTEL_LOGS_EXPORTER=otlp`                             | Event-Timeline, Tool-Ergebnisse, API-Fehler, Audit-Trail |
| Traces      | `OTEL_TRACES_EXPORTER=otlp` + `…ENHANCED_TELEMETRY_BETA=1` | Wasserfall pro Interaktion                         |

Sind Metrics **und** Events aktiv, gewinnt für Tokens/Kosten die Metrik — es wird nicht
doppelt gezählt. Die UI schreibt unter jede Kennzahl, aus welcher Quelle sie stammt.

## Selbst hosten

athena-observe ist dafür gebaut, dass es jeder auf dem eigenen Rechner betreibt: keine
Registrierung, kein Konto, kein fremder Dienst, keine laufenden Kosten. Die Telemetrie
verlässt die eigene Maschine nicht. Es gibt vier Formen, je nachdem, wo der Agent läuft
— und, bei der letzten, wie dauerhaft es sein soll.

### 1. Agent und Collector auf demselben Rechner

Der Normalfall — der Schnellstart oben ist bereits alles. Bind-Adresse bleibt
`127.0.0.1`, damit ist der Collector von außen nicht erreichbar und braucht kein Token.

### 2. Per Docker

Wer Node nicht direkt betreiben will: das Image installiert nichts, es ist nur ein
Node-Runtime plus Quelltext.

```bash
cd tools/observability
docker compose up -d          # http://127.0.0.1:4318, Daten im Volume "telemetry"
```

Der veröffentlichte Port ist absichtlich an `127.0.0.1` gebunden. Persistenz ist im
Container voreingestellt (`ATHENA_OBS_PERSIST=/data`), ein Neustart verliert also nichts.

### 3. Agent in einer Cloud-Session (Claude Code on the web, Actions, Container)

Die Session läuft in einem fremden Container. Der erreicht dein `localhost` nicht, und
in ihm gibt es weder deine `.claude/settings.local.json` noch deine Shell. Zwei Teile
müssen also zusammenkommen: eine **von außen erreichbare Collector-URL** und die
**Variablen in der Umgebung der Session**.

#### Ein Befehl

```bash
node bin/athena-observe.mjs --tunnel
```

Das erledigt alles auf einmal: Collector starten, Token erzeugen, Cloudflare-Tunnel
öffnen, warten bis die öffentliche URL wirklich antwortet, und den fertigen Block
ausgeben.

```
  athena-observe listening on http://127.0.0.1:4318
  UI          http://127.0.0.1:4318/?token=21c934f71106a6ffebf187510d233744

  Opening a Cloudflare quick tunnel …
  Got https://fewer-cube-selective-physiology.trycloudflare.com, waiting for it to serve …

  Public URL  https://fewer-cube-selective-physiology.trycloudflare.com
  Token       21c934f71106a6ffebf187510d233744

  Set these in the cloud session environment, then start a NEW session:

    CLAUDE_CODE_ENABLE_TELEMETRY=1
    OTEL_EXPORTER_OTLP_ENDPOINT=https://fewer-cube-selective-physiology.trycloudflare.com
    OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer 21c934f71106a6ffebf187510d233744
    …
```

Die Zeilen in die Environment-Einstellungen von Claude Code on the web eintragen. Dort
gehört auch das Token hin — **nicht** in eine Datei im Repo, sonst steht es im
Versionsverlauf. Bei GitHub Actions dasselbe über `env:` und ein Repository-Secret.

Voraussetzung ist `cloudflared`; fehlt es, sagt der Befehl, wie man es installiert. Ohne
`--token` wird eins erzeugt, denn die URL ist ab jetzt aus dem Internet erreichbar. Solange
der Befehl läuft, steht der Tunnel; `Ctrl-C` schließt beides.

`cloudflared` erreicht Cloudflare standardmäßig über **QUIC**, also UDP auf Port 7844. Viele
Router, Firmennetze und Container lassen UDP nicht raus, und `cloudflared` weicht von sich
aus nicht aus — es versucht QUIC endlos weiter. Deshalb wird hier automatisch auf **HTTP/2**
(TCP, gleicher Port) umgeschaltet, sobald QUIC nicht durchkommt:

```
  Got https://…trycloudflare.com, waiting for it to serve …
  QUIC (UDP 7844) did not get through — retrying over HTTP/2 (TCP 7844) …
```

Scheitern beide, blockiert das Netz den Port selbst — erkennbar an zwei `FAIL`-Zeilen in
der Diagnose:

```
    |  UDP Connectivity  region2.v2.argotunnel.com  FAIL    QUIC connection failed
    |  TCP Connectivity  region2.v2.argotunnel.com  FAIL    HTTP/2 connection is blocked
```

Das ist eine Firewall-Regel, kein Aussetzer: `cloudflared` kommt hier in keiner Form
durch, ein weiterer Versuch ändert nichts. Der Befehl nennt dann selbst die Auswege — die
Tabelle unten, oder gleich [Punkt 4](#4-dauerhaft-auf-einer-plattform-render-fly-railway):
ein deployter Collector braucht überhaupt keinen Tunnel, weil der eigene Rechner dann gar
nicht erreichbar sein muss.

Mit `--tunnel-protocol quic|http2` lässt sich ein Transport festnageln, wenn man weiß,
welcher funktioniert.

> Die URL des Quick Tunnels ist **flüchtig** — jeder Neustart vergibt eine neue, und dann
> müssen die Variablen nachgezogen werden. Wer das oft braucht, nimmt einen Tunnel mit
> fester Adresse und reicht sie mit `--public-url` durch:
>
> | Tunnel                                            | Kosten          | URL        | Konto     | Geht raus über |
> | ------------------------------------------------- | --------------- | ---------- | --------- | -------------- |
> | `--tunnel` (Cloudflare Quick)                     | frei            | wechselnd  | keins     | **7844**       |
> | `ssh -R 80:localhost:4318 nokey@localhost.run`    | frei            | wechselnd  | keins     | 22             |
> | `tailscale funnel 4318`                           | frei (Personal) | **stabil** | Tailscale | 443            |
> | `ngrok http 4318 --domain <deine>.ngrok-free.app` | frei (1 Domain) | **stabil** | ngrok     | 443            |
> | eigener Server / NAS mit `--host 0.0.0.0`         | vorhandene      | stabil     | –         | –              |
>
> Die letzte Spalte ist der Punkt, wenn `--tunnel` an der Firewall scheitert: nur
> Cloudflare braucht 7844, alle anderen gehen über Ports, die ein Netz praktisch immer
> offen lässt. `localhost.run` verlangt nicht einmal eine Installation.

#### Nachsehen, ob es ankommt

Kommt nichts an, schweigt der Exporter. Deshalb **in der Cloud-Session** prüfen:

```bash
node tools/observability/bin/athena-observe.mjs check
```

Ohne Argumente nimmt `check` das, was in dieser Umgebung tatsächlich konfiguriert ist
(`OTEL_EXPORTER_OTLP_ENDPOINT` samt Token aus `OTEL_EXPORTER_OTLP_HEADERS`), schickt einen
echten OTLP-Span und liest ihn wieder aus:

```
  ✓ reachable  https://obs.example.ts.net is an athena-observe collector
  ✓ ingest     OTLP span accepted
  ✓ stored     probe session athena-check-16f7537d is in the store
```

Jeder Schritt scheitert für sich: `reachable` zeigt Netzpolitik oder falsche URL,
`ingest` fehlendes oder falsches Token, `stored` einen Collector, der annimmt aber nicht
speichert. Exit-Code 1, wenn irgendetwas scheitert — damit taugt es auch für ein Skript.

Danach eine **neue** Session starten; die laufende liest ihre Konfiguration nicht neu.

> Sobald der Collector über `127.0.0.1` hinaus erreichbar ist, gehört ein Token davor —
> sonst kann jeder, der die Adresse kennt, Telemetrie einkippen und die eigene mitlesen.
> Einzige Ausnahme ist `/api/health`, das ohne Token antwortet, damit Healthchecks
> funktionieren; es verrät nur, dass der Prozess läuft.

> Ob der Session-Container überhaupt nach außen darf, entscheidet die Network-Policy der
> Umgebung. `check` sagt es dir in der ersten Zeile.

### 4. Dauerhaft auf einer Plattform (Render, Fly, Railway)

Der Tunnel taugt für eine Sitzung, nicht für den Dauerbetrieb: er hängt an deinem
laufenden Rechner und die URL wechselt bei jedem Start. Wer eine feste Adresse will,
stellt den Collector irgendwohin, wo ein Prozess einfach weiterläuft.

Wichtig ist nur das: **eine Plattform für Prozesse, keine für Funktionen.** Der Store
lebt im Arbeitsspeicher eines einzigen, langlebigen Prozesses, und der SSE-Strom
funktioniert, weil Ingest und UI sich denselben Prozess teilen. Serverless (Vercel,
Netlify Functions, Lambda) bricht beides — dort zählt jede Instanz einen Teil der
Kosten und die UI liest von einer, die nichts weiß. Aus demselben Grund darf der Dienst
**nicht auf mehrere Instanzen skalieren**; eine angehängte Platte erzwingt das bei
Render ohnehin.

Für Render liegt ein Blueprint bei. Render liest ihn aus dem Repository-Wurzelverzeichnis,
`rootDir` darin hält den Build trotzdem auf das Werkzeug beschränkt:

```bash
cp tools/observability/render.yaml render.yaml
git add render.yaml && git commit -m "Add Render blueprint" && git push
# dann auf render.com: New → Blueprint → Repository auswählen
```

Der Blueprint setzt Port und Bind-Adresse, hängt eine Platte auf `/data` (die
Persistenz ist im Image bereits darauf voreingestellt), erzeugt ein Token und meldet
`/api/health` als Healthcheck — der antwortet absichtlich ohne Token.

Nach dem Deploy stehen die fertigen Variablen in den ersten Zeilen des Logs, mit der
öffentlichen Adresse bereits eingesetzt:

```
  athena-observe listening on https://athena-observe.onrender.com  (bound to 0.0.0.0:10000)
  UI          https://athena-observe.onrender.com/?token=…

  Point an agent at it:

    export OTEL_EXPORTER_OTLP_ENDPOINT="https://athena-observe.onrender.com"
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer …"
```

Das geht, weil Render `PORT` und `RENDER_EXTERNAL_URL` in den Prozess reicht und beide
gelesen werden. `PORT` ist die Konvention aller dieser Plattformen, Fly und Railway
laufen also genauso — dort dann mit `--public-url` bzw. `ATHENA_OBS_PUBLIC_URL` für die
Adresse.

#### Vercel

Geht auch — aber nur halb, und man sollte wissen, welche Hälfte.

Vercel nimmt inzwischen einen normalen Node-Server entgegen: eine Datei `server.mjs`, die
`listen()` aufruft, wird eingefangen und beliefert. Die liegt bei, Next.js und React
braucht es dafür nicht. Root Directory im Projekt auf `tools/observability` setzen,
`ATHENA_OBS_TOKEN` als Variable eintragen, fertig — `VERCEL_PROJECT_PRODUCTION_URL` wird
gelesen, die öffentliche Adresse steht also von selbst im Env-Block.

Was fehlt, ist der Zustand. Fluid Compute teilt eine Instanz zwischen gleichzeitigen
Aufrufen, der Store überlebt also von Request zu Request — aber das ist eine Optimierung,
keine Zusage. Vercel skaliert unter Last auf mehrere Instanzen und räumt sie im Leerlauf
ab, und eine Platte gibt es nicht. Zwei Instanzen heißt zwei halbe Bilder derselben
Session, und ein SSE-Client an der einen erfährt nichts von Telemetrie, die an der anderen
ankam. Der Start sagt das auch selbst:

```
athena-observe: WARNING — on Vercel this keeps its data only in the instance that
  happens to serve the request. Expect history to vanish when the instance is
  recycled and sessions to split when more than one is running.
```

Der Container-Weg (`Dockerfile.vercel`) ändert daran nichts: Vercel führt OCI-Images als
*Functions* aus, dieselben Limits gelten. Die Doku nennt die Zahl, auf die es ankommt —
**„Functions not receiving any traffic for 5 minutes in production environments … will
automatically scale down."** Fünf Minuten Pause zwischen zwei Prompts, und die Historie ist
weg. Das Image ist hier also nur eine andere Verpackung derselben Funktion, mit längerer
Bauzeit; das beiliegende `server.mjs` erreicht dasselbe einfacher.

Zwei kleinere Fallstricke derselben Limits: Anfragen sind auf **4,5 MB** begrenzt (der
Collector selbst nimmt 32 MB), ein großer Export mit Prompt-Inhalten kann also an Vercel
scheitern, bevor der Code ihn sieht. Und der Port ist standardmäßig 80, überschrieben
durch `PORT` — das wird gelesen.

Damit taugt es zum **Live-Zuschauen**, nicht als Aufzeichnung. Wer auf Vercel Historie
will, muss den Store nach außen legen (Vercel Postgres o. ä.) — das ist ein echter Umbau,
kein Schalter. Für alles andere ist eine Plattform mit Platte der kürzere Weg.

#### Vorher wissen

Zwei Dinge gelten für alle diese Varianten:

- **Das kostet.** Renders freier Tarif hat keine Platte und legt den Dienst nach ~15
  Minuten Ruhe schlafen. Beides löscht die Historie, und ein Agent, der in den
  Kaltstart hinein exportiert, verliert seine Telemetrie stillschweigend — genau der
  Fall, für den es `check` gibt. Der Blueprint steht deshalb auf `starter`.
- **Die Daten liegen dann dort.** Durch den Collector fließen bei eingeschaltetem
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` auch Prompts und Antworten. Auf dem eigenen
  Rechner ist das folgenlos, auf fremder Infrastruktur ist es eine Entscheidung. Siehe
  [Sensible Daten](#sensible-daten).

## Was die UI zeigt

- **Sessions** — Liste aller `session.id`, sortiert nach letzter Aktivität, mit Kosten,
  Tokens und Fehlerzahl; live-Sessions sind markiert.
- **Overview** — Kennzahlenraster (Kosten, Tokens nach Typ inkl. Cache-Trefferquote,
  Interaktionen, LLM-Requests, Tool-Calls, Lines of Code, Commits/PRs, aktive Zeit) plus
  Tabellen pro Modell (Requests, Latenz, TTFT, Fehler) und pro Tool (Calls, Failures,
  Rejects, Dauer).
- **Traces** — Wasserfall je Interaktion: `interaction` → `llm_request` / `tool` →
  `tool.blocked_on_user` + `tool.execution`, farbig nach Span-Typ, Klick auf einen Balken
  zeigt alle Attribute und Span-Events. Subagent-Spans hängen unter dem `tool`-Span des
  Elternagenten, die Delegationskette ist also ein Trace.
- **Events** — filterbare Event-Timeline (Name, Volltext über alle Attribute, „errors
  only"), jede Zeile aufklappbar auf das vollständige Attributset.
- **Metrics** — alle gepufferten Datenpunkte, gruppiert nach Metrik und Attributkombination.
- **Attributes** — Resource- und Standardattribute der Session.

Die UI aktualisiert sich über Server-Sent Events; Bursts werden auf 250 ms zusammengefasst.

## Optionen

| Flag                    | Env                          | Default        | Bedeutung                                        |
| ----------------------- | ---------------------------- | -------------- | ------------------------------------------------ |
| `-p, --port`            | `ATHENA_OBS_PORT`            | `4318`         | Port für OTLP-Ingest **und** UI                  |
| `-h, --host`            | `ATHENA_OBS_HOST`            | `127.0.0.1`    | Bind-Adresse                                     |
| `-t, --token`           | `ATHENA_OBS_TOKEN`           | –              | `Authorization: Bearer …` erzwingen              |
| `--tunnel [binary]`     | –                            | –              | Cloudflare-Tunnel öffnen, Token erzeugen, Block ausgeben |
| `--tunnel-protocol <p>` | –                            | beide          | Transport festnageln: `quic` oder `http2`        |
| `--public-url <url>`    | `ATHENA_OBS_PUBLIC_URL`      | –              | Angekündigte URL hinter Tunnel/Proxy             |
| `--persist [dir]`       | `ATHENA_OBS_PERSIST`         | –              | JSONL auf Platte, Replay beim Start              |
| `--retention <dauer>`   | `ATHENA_OBS_RETENTION`       | `24h`          | Alter, ab dem Rohdaten verworfen werden          |
| `--max-spans <n>`       | `ATHENA_OBS_MAX_SPANS`       | `50000`        | Span-Puffer                                      |
| `--max-logs <n>`        | `ATHENA_OBS_MAX_LOGS`        | `50000`        | Event-Puffer                                     |
| `--max-metrics <n>`     | `ATHENA_OBS_MAX_METRICS`     | `50000`        | Metrik-Puffer                                    |
| `--max-sessions <n>`    | `ATHENA_OBS_MAX_SESSIONS`    | `500`          | Sessions im Speicher                             |

Dauern akzeptieren `ms`, `s`, `m`, `h`, `d` (z. B. `--retention 90m`).

Zusätzlich werden zwei Variablen gelesen, die Plattformen selbst setzen: `PORT` (Render,
Fly, Railway, Heroku) als Port und `RENDER_EXTERNAL_URL` als öffentliche Adresse. Beide
rangieren unter den `ATHENA_OBS_*`-Varianten, ein bewusst gesetzter Wert gewinnt also.

## Datenhaltung

Zwei Lebensdauern, mit Absicht getrennt:

- **Rohdaten** (Spans, Events, Metrikpunkte) liegen in begrenzten Fenstern und werden nach
  Alter und Anzahl verworfen. Der Speicherbedarf bleibt dadurch flach.
- **Session-Aggregate** (Tokens, Kosten, Zähler pro Modell und Tool) sind kumulativ und
  bleiben korrekt, auch wenn die Rohdaten längst herausgerollt sind.

Mit `--persist <dir>` wird jeder normalisierte Datensatz als JSONL angehängt und beim
nächsten Start zurückgespielt — sinnvoll in Containern, die neu gestartet werden. Die
Dateien rotieren bei 64 MB (`<signal>.jsonl` → `<signal>.1.jsonl`).

`DELETE /api/data` leert den Store zur Laufzeit.

## Sensible Daten

Standardmäßig exportiert Claude Code nur Struktur: Dauern, Modellnamen, Tool-Namen,
Token-Zahlen. Prompts, Tool-Argumente und API-Bodies kommen erst mit
`OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_LOG_TOOL_CONTENT=1` bzw.
`OTEL_LOG_RAW_API_BODIES` dazu. Diese Variablen setzt `athena-observe env` bewusst **nicht**.
Wer sie einschaltet, sollte wissen, dass Prompt- und Dateiinhalte dann im Speicher des
Collectors und — bei `--persist` — auf der Platte landen.

`user.email`, `user.account_uuid` und `organization.id` sind Standardattribute und
erscheinen in der UI unter „Attributes".

## Architektur

```
bin/athena-observe.mjs   CLI: Argumente, Start, env-Ausgabe, Shutdown
src/config.mjs           Defaults < Umgebung < Flags
src/otlp/protobuf.mjs    schemagesteuerter Protobuf-Reader/Writer (Wire-Format)
src/otlp/schema.mjs      Felddeskriptoren für opentelemetry-proto v1
src/otlp/decode.mjs      OTLP (protobuf & JSON) → flache Records
src/claude.mjs           Claude-Code-Domänenwissen: Metrik-, Event-, Span-Namen
src/store.mjs            In-Memory-Store, Session-Aggregation, Trace-Baum, Queries
src/persist.mjs          optionales JSONL-Append + Replay
src/server.mjs           OTLP-Ingest, JSON-API, SSE, statische Auslieferung
public/                  UI (Vanilla JS, kein Build)
scripts/demo-emit.mjs    synthetische Sessions als echtes OTLP-Protobuf
```

Der Protobuf-Decoder überspringt unbekannte Felder, bleibt also gegenüber neueren
OTLP-Revisionen und neuen Claude-Code-Attributen tolerant.

### HTTP-API

| Route                    | Zweck                                                      |
| ------------------------ | ---------------------------------------------------------- |
| `POST /v1/{traces,metrics,logs}` | OTLP-Ingest (`http/protobuf`, `http/json`, gzip)   |
| `GET /api/sessions`      | Sessionliste (`search`, `limit`, `offset`)                 |
| `GET /api/sessions/:id`  | Session-Aggregate inkl. Traces                             |
| `GET /api/traces/:id`    | Spans eines Traces, flach mit `depth` in Renderreihenfolge |
| `GET /api/events`        | Events (`session`, `event`, `trace`, `search`, `errors`)   |
| `GET /api/metrics`       | Metrikpunkte (`session`, `name`)                           |
| `GET /api/stats`         | Gesamtzahlen, Top-Modelle, Top-Tools, Puffergrößen         |
| `GET /api/facets`        | vorkommende Event- und Metriknamen mit Häufigkeit          |
| `GET /api/config`        | Endpoint, Limits, fertiger `OTEL_*`-Block                  |
| `GET /api/stream`        | Server-Sent Events bei Ingest                              |
| `DELETE /api/data`       | Store leeren                                               |

## Tests

```bash
npm test          # 68 Tests: Wire-Format, Decoder, Store, Persistenz, Config, Probe, Tunnel, HTTP
npm run demo      # synthetische Session emittieren
```

## Grenzen

- **Nur OTLP über HTTP.** gRPC (Port 4317) wird nicht gesprochen —
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (oder `http/json`) ist Pflicht.
- **Kein Prometheus-Scrape-Endpoint.** `OTEL_METRICS_EXPORTER=prometheus` exportiert nicht
  hierher.
- **Nicht als `console`-Exporter nutzbar.** Beim Agent SDK ist stdout der Nachrichtenkanal;
  `console` würde ihn zerstören. Deshalb immer `otlp`.
- Histogramme werden gespeichert und aufgelistet, aber nicht als Verteilung gezeichnet.
- Der Store lebt im Prozess. Für langfristige Aufbewahrung oder Alerting gehört die
  Telemetrie in ein echtes Backend (Honeycomb, Grafana, Datadog, Langfuse) — beides geht
  parallel, `OTEL_EXPORTER_OTLP_*`-Variablen lassen sich pro Signal auf verschiedene
  Endpunkte richten.

## Fehlersuche

Kommt nichts an, exportiert die CLI still ins Leere. Erste Maßnahme ist immer, aus der
Umgebung des Agenten heraus zu prüfen, ob der Weg überhaupt steht:

```bash
node tools/observability/bin/athena-observe.mjs check
```

`CLAUDE_CODE_OTEL_DIAG_STDERR=1` schaltet zusätzlich Exporter-Diagnosen auf stderr
(Claude Code ≥ 2.1.179); beim SDK landen sie im `stderr`-Callback. Danach der Reihe nach
prüfen:

1. `curl -s http://127.0.0.1:4318/api/health` — läuft der Collector?
2. Zeigt `OTEL_EXPORTER_OTLP_ENDPOINT` auf den Host **ohne** `/v1/…`-Pfad?
3. Ist `CLAUDE_CODE_ENABLE_TELEMETRY=1` gesetzt (ohne das passiert gar nichts)?
4. Fehlen nur Spans? Dann fehlt `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
5. Kurzer Run ohne Daten? Export-Intervalle senken (siehe oben) — beim Prozessende bleibt
   nur ein knappes Flush-Zeitfenster.
