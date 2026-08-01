# athena

> Ein AI-Agenten-Workflow, der auf Urteilsvermögen baut statt auf Regeln — ein
> paar Invarianten, Selbstkorrektur in der Schleife, und ein Mensch nur dort,
> wo es zählt. Nachfolger von [metis](https://github.com/artkoenig/metis).

**Athena** ist die griechische Göttin der Weisheit und des Handwerks: Können,
das aus Übung kommt, nicht aus Vorschrift. Das ist das Prinzip, nicht nur der
Name.

## Wie es funktioniert

Das Regelwerk ist eine Seite: [`AGENTS.md`](AGENTS.md). Sein Kern ist **Urteil
für den Prozess, Mechanik für Fakten** — alles Prozedurale entscheidet der
Agent jedes Mal neu, Regeln bleiben nur dort, wo Selbsteinschätzung versagt.
„Die Tests laufen durch" kommt aus einem Exit-Code, nie aus dem Eindruck des
Agenten.

Fünf Invarianten gelten für jede Änderung:

1. Die Absicht — Akzeptanzkriterien — steht vor dem ersten Code.
2. Die Tests dazu entstehen zuerst, blind aus der Absicht, und werden fallen
   gesehen; eine Änderung ohne etwas Ausführbares sagt genau das.
3. Ein frischer Kontext prüft den Diff gegen die geschriebene Absicht, mit
   einer konkreten Reproduktion pro Fund.
4. Suite und statische Analyse belegen sich per Exit-Code; wo nichts
   existiert, ist dieses Fehlen der berichtete Fakt.
5. Entscheidungen, Überraschungen und Checkpoint-Antworten landen im Issue,
   während sie passieren — der Datensatz überlebt die Session.

Der Mensch steuert an drei Punkten: Kriterien freigeben, wenn die Idee
wirklich unklar ist; alles Unumkehrbare oder nach außen Wirkende entscheiden;
den Pull Request mergen.

**Der Workflow korrigiert sich über die Retro.** Nach jedem PR hält der Agent
fest, was im Weg stand. Eine Regel, die danebenlag, wird zum Vorschlag: ein
Pull Request gegen dieses Repository, entschieden wie jeder andere. Und weil
jedes verdrahtete Projekt athena beim Session-Start frisch lädt, erreicht eine
akzeptierte Regeländerung alle mit der nächsten Session.

## Installation

athena ist ein Claude-Code-Plugin aus dem eigenen Marketplace:

```bash
claude plugin marketplace add artkoenig/athena
claude plugin install athena@athena
```

Eine Session mit aktivem Plugin bekommt das Regelwerk des aktuellen `main` in
den Kontext, dazu einen Selfcheck, der sagt, was tatsächlich erreichbar ist,
und einen `pre-push`-Guard, der einen direkten Push auf den Default-Branch
verweigert. Ein Projekt, das seine Git-Hooks selbst verwaltet — husky,
lefthook, pre-commit — behält sie: athena übernimmt `core.hooksPath` dann
nicht und meldet den fehlenden Guard, statt ihn stillschweigend zu
überschreiben.

Subagents und Skills bringt das Plugin noch nicht mit — der Selfcheck meldet
`0 skills and 0 agents reachable`, und das Regelwerk schickt die Session genau
dorthin, statt eine Seite anzunehmen, die es nicht gibt.

Damit die Retros in *deinem* Regelwerk landen, forke das Repository und zeige
mit `marketplace add` auf den Fork.

## tools/

| Tool                                    | Zweck                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`observability`](tools/observability/) | OpenTelemetry-Collector + Web-UI, um Agent-Sessions live zu beobachten: Traces, Tokens, Kosten, Tool-Aufrufe, Fehler. |

```bash
cd tools/observability && node bin/athena-observe.mjs   # http://127.0.0.1:4318
```

Läuft auf dem eigenen Rechner — ohne Konto, ohne fremden Dienst, ohne laufende
Kosten. Alternativ `docker compose up -d` im selben Verzeichnis.

## Tests

```bash
bash test.sh
```

Ein Befehl, alle Suites, Exit 0 nur wenn alles grün ist.

## Lizenz

GPL-3.0-or-later — siehe [LICENSE](LICENSE).
