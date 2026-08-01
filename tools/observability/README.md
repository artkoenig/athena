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
verlässt die eigene Maschine nicht. Es gibt drei Formen, je nachdem, wo der Agent läuft.

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

Hier liegt der einzige Stolperstein: die Session läuft in einem fremden Container und
erreicht dein `localhost` nicht. Zwei kostenlose Wege, den lokalen Collector trotzdem
erreichbar zu machen.

**Tunnel** — funktioniert von jedem Rechner aus, auch hinter NAT. Cloudflares
Quick Tunnel braucht kein Konto:

```bash
# Shell 1 — Collector mit Token, weil die URL öffentlich erreichbar wird
TOKEN=$(openssl rand -hex 16)
node bin/athena-observe.mjs --token "$TOKEN" --persist ./telemetry

# Shell 2 — Tunnel; gibt eine https://…trycloudflare.com URL aus
cloudflared tunnel --url http://127.0.0.1:4318

# Shell 3 — env-Block für genau diese URL erzeugen und in die Session kopieren
node bin/athena-observe.mjs env --public-url https://<deine>.trycloudflare.com --token "$TOKEN"
```

`--public-url` ändert nur die *angekündigte* Adresse (env-Block, Startbanner,
Setup-Dialog der UI), nicht die Bind-Adresse. Ohne das Flag würde `env` weiter
`http://127.0.0.1:4318` ausgeben, was in der Session ins Leere läuft.

**Erreichbarer Host** — wenn ohnehin ein Server, NAS oder eine VM im LAN läuft:

```bash
node bin/athena-observe.mjs --host 0.0.0.0 --token "$(openssl rand -hex 16)" --persist ./telemetry
```

In beiden Fällen enthält der `env`-Block automatisch
`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer …`. Das Token gilt gleichermaßen für
Ingest und UI; im Browser wird es als `?token=…` mitgegeben.

> Sobald der Collector über `127.0.0.1` hinaus erreichbar ist, gehört ein Token davor —
> sonst kann jeder, der die Adresse kennt, Telemetrie einkippen und die eigene mitlesen.
> Einzige Ausnahme ist `/api/health`, das ohne Token antwortet, damit Healthchecks
> funktionieren; es verrät nur, dass der Prozess läuft.

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
| `--public-url <url>`    | `ATHENA_OBS_PUBLIC_URL`      | –              | Angekündigte URL hinter Tunnel/Proxy             |
| `--persist [dir]`       | `ATHENA_OBS_PERSIST`         | –              | JSONL auf Platte, Replay beim Start              |
| `--retention <dauer>`   | `ATHENA_OBS_RETENTION`       | `24h`          | Alter, ab dem Rohdaten verworfen werden          |
| `--max-spans <n>`       | `ATHENA_OBS_MAX_SPANS`       | `50000`        | Span-Puffer                                      |
| `--max-logs <n>`        | `ATHENA_OBS_MAX_LOGS`        | `50000`        | Event-Puffer                                     |
| `--max-metrics <n>`     | `ATHENA_OBS_MAX_METRICS`     | `50000`        | Metrik-Puffer                                    |
| `--max-sessions <n>`    | `ATHENA_OBS_MAX_SESSIONS`    | `500`          | Sessions im Speicher                             |

Dauern akzeptieren `ms`, `s`, `m`, `h`, `d` (z. B. `--retention 90m`).

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
npm test          # 54 Tests: Wire-Format, Decoder, Store, Persistenz, Config, HTTP-Ende-zu-Ende
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

Kommt nichts an, exportiert die CLI still ins Leere. `CLAUDE_CODE_OTEL_DIAG_STDERR=1`
schaltet Exporter-Diagnosen auf stderr (Claude Code ≥ 2.1.179); beim SDK landen sie im
`stderr`-Callback. Danach der Reihe nach prüfen:

1. `curl -s http://127.0.0.1:4318/api/health` — läuft der Collector?
2. Zeigt `OTEL_EXPORTER_OTLP_ENDPOINT` auf den Host **ohne** `/v1/…`-Pfad?
3. Ist `CLAUDE_CODE_ENABLE_TELEMETRY=1` gesetzt (ohne das passiert gar nichts)?
4. Fehlen nur Spans? Dann fehlt `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`.
5. Kurzer Run ohne Daten? Export-Intervalle senken (siehe oben) — beim Prozessende bleibt
   nur ein knappes Flush-Zeitfenster.
