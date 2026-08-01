# athena

Ein AI-Workflow, der auf minimalen Regeln basiert und sich auf die Intelligenz des
Modells verlässt. Statt den Ablauf vorzuschreiben, gibt athena ihm Werkzeuge und macht
sichtbar, was tatsächlich passiert.

## tools/

| Tool                                       | Zweck                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| [`observability`](tools/observability/)    | OpenTelemetry-Collector + Web-UI, um Agent-Sessions live zu beobachten: Traces, Tokens, Kosten, Tool-Aufrufe, Fehler. |

```bash
cd tools/observability && node bin/athena-observe.mjs   # http://127.0.0.1:4318
```

Läuft auf dem eigenen Rechner — ohne Konto, ohne fremden Dienst, ohne laufende Kosten.
Alternativ `docker compose up -d` im selben Verzeichnis.

## Lizenz

Apache 2.0 — siehe [LICENSE](LICENSE).
