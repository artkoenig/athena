# athena

Ein AI-Workflow, der auf minimalen Regeln basiert und sich auf die Intelligenz des
Modells verlässt. Statt den Ablauf vorzuschreiben, gibt athena ihm Werkzeuge und macht
sichtbar, was tatsächlich passiert.

## tools/

| Tool                                       | Zweck                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| [`observability`](tools/observability/)    | OpenTelemetry-Collector + Web-UI, um Agent-Sessions live zu beobachten: Traces, Tokens, Kosten, Tool-Aufrufe, Fehler. |

```bash
cd tools/observability && node bin/athena-observe.mjs
```

## Lizenz

Apache 2.0 — siehe [LICENSE](LICENSE).
