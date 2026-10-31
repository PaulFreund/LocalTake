# Prüfstand

Dieser Prüfstand beschreibt die veröffentlichbaren Quellen und reproduzierbare Prüfungen. Instanzadressen, persönliche Geräte- und Dateipfade sowie interne Rolloutprotokolle gehören nicht zur Projektdokumentation.

## Automatisierte Prüfungen

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run format:check
npm audit
```

Die Tests decken unter anderem ab:

- Signierte Raumzugänge, Ablauf, Origin-Prüfung, Hostrechte, Raumgrenzen und authentifizierte WebSockets.
- Raumlink-Isolation, wiederverwendete Teilnehmeridentitäten und das Verwerfen veralteter HTTP-/WebSocket-Ergebnisse.
- Recorderstart und -abschluss, kontinuierliche Segmentzeit, Audioquanten, Mute, begrenzte Warteschlangen und Ressourcenfreigabe.
- Dateisperren, Windows-Pfadgrenzen, Prüfsummen, Wiederherstellung, gespeicherte Empfangsbestätigungen und Aufbewahrung.
- Unterbrochene P2P-Übernahme, sichere Pfadbehandlung, fortgesetzte Übertragung und vollständig geprüfte Exporte.
- MP4-Remuxing, PCM-Samples, WAV-Teilung, Sitzungsordner und das sichere Bereinigen verifizierter Originalsegmente.
- Verbindungsstatistiken, ICE-Policy, signierte TURN-Zugangsdaten und Wiederaufbau von Liveverbindungen.
- Diagnosefilterung, Authentifizierung, Body-/Ratenlimits und begrenzte Logspeicherung bei langsamen oder fehlerhaften Datenträgern.

Das Video unter `tests/fixtures` ist ein generiertes Testmuster und enthält keine Benutzeraufnahme. Die übrigen Medien entstehen synthetisch während der Tests.

## Reproduzierbarer Browser-Smoke

Bei laufendem Entwicklungsserver:

```sh
node scripts/studio-smoke.mjs http://localhost:43171/
```

Das Skript startet einen eigenen Headless-Chromium mit temporärem Profil, simulierten Geräten und getrennten Diagnoseablagen. Unter Windows wird standardmäßig Edge verwendet; über `LOCALTAKE_CHROMIUM` lässt sich der Browserpfad vorgeben. Der Debug-Port `43176` muss frei sein.

Der Ablauf prüft die automatische Quellenprüfung, zwei 4K-Testaufnahmen, gemeinsame Host-/Gastaufnahme, Übernahme der Hostqualität, echte WebRTC-Dateikanäle und das Neuladen des Gasts während einer gedrosselten Übertragung. Er prüft anschließend die fortgesetzte Übernahme, vollständige Teilnehmerbestände und einen gemeinsamen Ausgabeordner. Browserausnahmen und CSP-Verstöße lassen den Test scheitern. `transfer` als letztes Argument überspringt die zusätzlichen 4K-Prüfungen.

Die temporäre OPFS-Diagnoseablage ist ausschließlich im Entwicklungsmodus verfügbar. Der Produktionsbuild enthält keine freigeschalteten Testablage- oder Testquellen-Bedienelemente. Synthetische Quellen beweisen keine Hardwareleistung und keine native Ordnerfreigabe.

## Prüfung vor Veröffentlichung

Am 15.10.2026 bestanden 169 Tests in 24 Testdateien, Typprüfung, Produktionsbuild und Formatprüfung. Die Abhängigkeitsprüfung meldete keine bekannten Schwachstellen.

Der lokale Produktionsbuild wurde zusätzlich mit zwei isolierten Browserkontexten geprüft: Raum erstellen, Gastbeitritt, automatische Quellenprüfung, Livevideo, Chat, gemeinsame Aufnahme, Dateiübernahme und abschließende Anzeige „Alle Originale sind gesichert“. Beide Teilnehmerbestände waren vollständig und verifiziert. Dabei entstanden die drei README-Screenshots; es gab keine unbehandelten Browserausnahmen oder CSP-Verstöße. Kamera und Mikrofon waren synthetisch, der Ordnerzugriff wurde nur für diesen Test durch eine isolierte OPFS-Ablage ersetzt. Das ist keine Hardware- oder native Ordnerabnahme.

Am 15.10.2026 wurden alle erreichbaren ursprünglichen Branches einschließlich ihrer Historie auf Zugangsdaten und private Instanzdaten geprüft. Der öffentliche Quellstand enthält allgemeine Deployment-Beispiele und synthetische Testdaten. Die Screenshots verwenden ein isoliertes lokales Studio mit fiktiven Teilnehmern.

Der Secret-Scan verwendet Gitleaks. Die Abhängigkeitsprüfung verwendet `npm audit`; korrigierte Lockfile-Versionen beheben die gemeldeten Advisories für [shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) und [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Ein sauberer Scan ist ein Prüfergebnis für diesen Stand und keine Garantie, dass künftig keine Schwachstellen gefunden werden.

## Rust-Port und Abgleich mit dem öffentlichen Stand, 31.10.2026

Der veröffentlichte Node-Koordinator ist durch den produktiv geprüften Rust-Koordinator mit Axum/Tokio ersetzt. Die bestehenden öffentlichen README-Screenshots, generischen Konfigurationsbeispiele, bereinigten Testdaten, Schutzregeln für lokale Dateien und korrigierten Entwicklungsabhängigkeiten bleiben erhalten. Es wurde keine zusätzliche Produktfunktion im bisherigen `main` gefunden; dessen Änderungen an Clientquellen betreffen Kommentare und einen internen Select-Platzhalter. Der Rust-Quellstand, `Cargo.lock`, Protokoll und Dockerfile entsprechen dem geprüften Deployment. Private Instanzkonfiguration und interne Betriebsprotokolle bleiben außerhalb der öffentlichen Historie.

Bestanden: 17 Rust-Tests und 216 Vitest-Tests in 23 Dateien, Client-Typprüfung, Produktionsbuild, Formatprüfung, Clippy ohne Warnungen und Typprüfung aller Ziele für `x86_64-unknown-linux-musl`. Die WebSocket-Tests verwenden einen echten Rust-Prozess. 52 gemeinsame Vertragsfälle vergleichen die Rust-Normalisierung mit dem bestehenden Browser-Schema. Die RAM-Messung mit zwölf Räumen und 48 Teilnehmern ist unter [server-rust.md](server-rust.md) beschrieben.

Für diesen Abgleich wurden zusätzlich Vite auf 8.3.3, Vitest auf 5.0.3 und Zod auf 4.6.6 aktualisiert. Die bisherigen Korrekturen für `shell-quote` und `source-map-js` bleiben erhalten. Saubere Installation und `npm audit` melden für den neuen Quellstand null bekannte Schwachstellen. Diese Patchupdates sind zusätzliche Änderungen gegenüber dem bereits laufenden Image. Der WebSocket-Test der Nachrichtengrenze verwendet gültig große, fragmentierte Frames, damit die Prüfung des Close-Codes nicht von einem frühen TCP-Abbruch bei einem übergroßen Frame abhängt.

Der native Release-Smoke prüfte außerdem Healthcheck, den neu gebauten statischen Client, CSP, Raum-API, Origin-Abweisung und tatsächlich persistierte, gefilterte Diagnosen einschließlich des nativen Diagnose-Lesers. Gitleaks fand in den für die Veröffentlichung vorgemerkten Änderungen keine Zugangsdaten. Der Abgleich verändert keine laufende Instanzkonfiguration.

Der Linux-Container wurde vor dem Produktivwechsel isoliert geprüft. Bestehende Node-Tokens, HTTPS/WSS, Aufnahmebefehle, gefilterte Diagnoseablage und TURN über UDP/TCP funktionieren. Synthetische Relay-Tests bestätigten Medienempfang und SHA-256-geprüfte Dateiübertragung; kurze Zwei-Geräte-Benutzertests bestätigten lokale Kamera-/Mikrofonsicherung und quittierte Hostübernahme. Im Auto-Test wurde ein direkter Host/Host-Pfad gewählt, ohne gemeldete Paketverluste oder Video-Freezes. Ein STUN/NAT-Pfad über getrennte Netze, unabhängige Dekodierung dieser Benutzerdateien und Langzeitlast sind dadurch nicht nachgewiesen. Die bekannte Bandbreitenkonkurrenz beim begrenzten TURN-Test bleibt dokumentiert.

## Offene Systemabnahme

Die folgenden Nachweise erfordern die tatsächliche Zielumgebung:

- Vier getrennte Rechner und Netze mit paralleler Aufnahme, direktem WebRTC und erzwungenem TURN-Fallback.
- Zwei reale Kameras und zwei Mikrofone je Referenzrechner über 60 Minuten; anschließend zwei Stunden Dauerlast.
- Mindestens 10 GiB Originalmaterial mit nativem Aufnahmeordner, vollständiger Übernahme und unabhängig dekodiertem Videoexport über 4 GiB.
- Harte Browser-/Datenträgerfehler, entzogene Ordnerrechte, volle Datenträger sowie Schlaf- und Sperrzustände.
- Physisch gemessene Audio-/Videolatenz, A/V-Ausrichtung und Drift; RTT ist kein Ersatz dafür.

Die genauen Ziele stehen im [Anforderungsabgleich](acceptance.md) und [Implementierungsplan](implementation-plan.md). Das Studio bleibt experimentell, bis der jeweilige Aufbau diese Abnahme besteht.
