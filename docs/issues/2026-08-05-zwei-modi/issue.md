# Zwei Modi: Issue-Workflow oder direkte Arbeit

## Problem
Heute gilt für die Hauptsession nur ein Weg: grillen, Issue-Datei schreiben, Dispatcher rufen. Für kleine oder offensichtliche Aufgaben ist das zu viel Zeremonie — die Hauptsession darf nicht einmal eine Zeile selbst ändern. Es fehlt ein zweiter Modus, in dem die Hauptsession die Arbeit direkt erledigt.

## Akzeptanzkriterien
- [ ] Das Regelwerk (`CLAUDE.md`, und wo nötig `.claude/rules/`) beschreibt zwei Modi: **Issue-Modus** und **Direkt-Modus**.
- [ ] Am Anfang einer neuen Aufgabe klärt die Hauptsession, welcher Modus gilt. Sagt der Nutzer den Modus schon selbst ("mach das direkt", "leg ein Issue an"), wird nicht nachgefragt.
- [ ] **Issue-Modus:** unverändert. Alle heutigen Verantwortungen und Einschränkungen der Hauptsession gelten weiter — kein Code lesen, kein Code ändern, kein Git, kein Implementierungsplan; Issue-Datei schreiben, bestätigen lassen, `dispatcher` rufen.
- [ ] **Direkt-Modus:** die Hauptsession darf Code lesen, Code und Tests ändern, Tests laufen lassen, committen und pushen. Keine Issue-Datei, kein Dispatcher, keine Subagenten nötig. Breite Suche im Code darf sie weiterhin an Subagenten geben, um Kontext zu sparen.
- [ ] Der Modus gilt je Aufgabe, nicht je Session. Wächst eine Direkt-Aufgabe, darf die Hauptsession in den Issue-Modus wechseln und das ansagen.
- [ ] Die Texte bleiben kurz und in der Sprache des bestehenden Regelwerks. Keine neue Maschinerie, keine Flags, keine Konfigurationsdatei.

## Offene Annahmen (als Default gesetzt, weil der Nutzer nicht geantwortet hat)
- Gefragt wird am Anfang einer Aufgabe, nicht bei jeder Nachricht.
- Im Direkt-Modus sind Commit und Push erlaubt.
- Ohne Aussage des Nutzers und ohne Rückfragemöglichkeit gilt der Issue-Modus.
