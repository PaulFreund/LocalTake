# Rust-Koordinator und RAM-Prüfung

Der Koordinator ist von Node.js/Fastify auf Rust mit Axum und Tokio umgestellt. Browserclient und gemeinsame TypeScript-Verträge bleiben erhalten. Der Server koordiniert Räume, Signalisierung, Zeitproben und Aufnahmebefehle; Audio, Video und Originaldateien werden weiter zwischen den Browsern übertragen. TURN läuft als separater Dienst.

## Kompatibilität und Betrieb

HTTP-Endpunkte, WebSocket-Protokollversion, Rollen, Origin-Prüfung, Aufnahmephasen, Fehlercodes und HMAC-Tokenformat bleiben kompatibel. Bereits vom Node-Server ausgestellte Raum- und Einladungstokens funktionieren mit demselben dauerhaft gespeicherten `ROOM_SIGNING_SECRET`. Gleiches gilt für zeitlich begrenzte TURN-Zugangsdaten und vorhandene Diagnosevolumes.

Die Konfiguration verwendet weiterhin dieselben Umgebungsvariablen. `ICE_TRANSPORT_POLICY=all` erlaubt direkte Verbindungen und konfigurierten TURN als Ausweichweg; `relay` erzwingt TURN zum Testen. Die gewählte Route ist unabhängig davon im Studio sichtbar. Im normalen Auto-Modus kann eine Host/Host-Verbindung ohne NAT-Adressabbildung gewinnen, obwohl STUN und TURN konfiguriert sind.

Für Entwicklung und Builds sind Node.js ab 22.19, npm und Rust ab 1.90 mit Cargo erforderlich:

```sh
npm ci
npm run dev
npm test
npm run typecheck
npm run build
npm run format:check
cargo clippy --all-targets --locked -- -D warnings
```

`npm run dev:server` baut den nativen Server bei Änderungen neu. `npm run build:server` erzeugt das Release-Binary unter `target/release/localtake-server`, unter Windows mit `.exe`. `npm start` baut bei Bedarf im Releaseprofil und startet den Server. Die nativen Unterbefehle `healthcheck` und `telemetry-read` ersetzen Node-Skripte im Container.

Das mehrstufige Dockerfile baut Client und Server getrennt. Das Alpine-Laufzeitimage enthält kein Node.js/npm. Der unprivilegierte Benutzer `localtake` behält UID/GID 1000, damit vorhandene Diagnosevolumes beim Wechsel beschreibbar bleiben. Native Healthchecks, schreibgeschütztes Dateisystem und die bestehenden Compose-Einstellungen bleiben erhalten.

## Begrenzte Speicherbelegung

- Ein Tokio-Ereignisloop mit höchstens vier bei Bedarf gestarteten Dateisystem-Workern; Diagnose-I/O läuft auf einem getrennten Writer-Thread.
- Höchstens 256 Räume und 2–4 aktive Teilnehmer je Raum; bis zu 32 gespeicherte Teilnehmeridentitäten je Raum, 256 deduplizierte Aufnahmebefehle und eine Stunde Leerlaufaufbewahrung.
- Höchstens 2.048 WebSockets einschließlich noch nicht authentifizierter Verbindungen; Authentifizierung nach spätestens fünf Sekunden, Heartbeat alle 20 Sekunden, eingehende Nachrichten höchstens 64 KiB.
- Ausgehende Queues höchstens 64 Nachrichten und 256.000 Bytes einschließlich laufender Übertragung. Ein einzelner großer Raumzustand darf bei leerer Queue bis 4 MiB belegen, damit erhaltene Zustände mit vielen früheren Teilnehmern wieder verbunden werden können. Gemeinsam versendete Payloads teilen ihren Speicher.
- Diagnosequeue höchstens 2 MiB und 512 Zeilen einschließlich laufendem Schreiben, Batches höchstens 64 KiB, Zeilen höchstens 16 KiB. Fehler oder voller Datenträger blockieren keine Raum-/Aufnahmebefehle. Aufbewahrungsgrenzen stehen in [telemetry.md](telemetry.md).
- Statische Dateien und Diagnoseeingaben werden begrenzt gestreamt. Originalaufnahmen werden nicht im Koordinator gepuffert.

Diese Mengen begrenzen Anwendungsspeicher; sie sind kein harter RAM-Grenzwert für den gesamten Prozess. Allocator, Netzwerkpuffer, Threads, Betriebssystem und Last beeinflussen den tatsächlichen Verbrauch. Ein Docker-Speicherlimit muss der Betreiber gesondert konfigurieren. TURN-Speicher gehört zum separaten Relay-Prozess und ist nicht in den Koordinatorwerten enthalten.

## Reproduzierbarer Prozessvergleich

`scripts/server-memory.mjs` startet einen separat gemessenen Koordinator mit einem eigenen temporären Port und synthetischen Raumdaten. Der Lastgenerator läuft außerhalb des gemessenen Prozesses. Er erzeugt zwölf Räume, 48 Teilnehmer und 1.920 Statusmeldungen mit je 16 Quellen. Nach der Last bestätigt jeder Socket eine Zeitprobe; danach werden die Verbindungen geschlossen. Diagnoseablage ist für diesen Vergleich deaktiviert.

```sh
npm run build:server
node scripts/server-memory.mjs target/release/localtake-server
# Windows:
node scripts/server-memory.mjs target/release/localtake-server.exe
```

Für einen Vergleich den früheren Node-Stand in einer getrennten Arbeitskopie bauen und dessen Server an dasselbe Skript übergeben. Ein Node-/Rust-Vergleich unter Windows mit Node 22.19 und Rust 1.90 ergab:

| Zustand | Node RSS | Rust RSS |
| --- | ---: | ---: |
| Leerlauf | 67,3 MiB | 5,9 MiB |
| 48 Teilnehmer verbunden | 68,1 MiB | 7,4 MiB |
| Nach Statuslast | 124,3 MiB | 12,9 MiB |
| Nach Trennen | 125,0 MiB | 9,7 MiB |

Das sind etwa 90 % weniger RSS nach dieser Last. Die Werte stammen aus derselben Windows-Messumgebung, sind kein Linux-Lasttest und kein zugesagtes Produktionsmaximum. Messungen nach einem kurzen Linux-Benutzertest lagen für den Rust-Container bei etwa 5,8 MiB aktuell und 8 MiB Spitze seit Neustart; auch das ist kein Dauertest.

## Verifikation und offene Grenzen

17 native Rust-Tests und 216 Vitest-Tests prüfen unter anderem alte HMAC-Tokens, Raum-/Rollenlogik, echte HTTP-/WebSocket-Aufrufe, Wiederanmeldung nach Neustart, Authentifizierungsfristen, Größen-/Ratenlimits, Close-Codes, statische Range-/HEAD-Antworten und Diagnose-I/O. 52 gemeinsame Schemafälle vergleichen Rust mit dem Browservertrag. Große erhaltene Raumzustände werden über echte WebSockets geprüft.

Linux-Containerbau, öffentliches HTTPS/WSS, bestehende Node-Tokens sowie erzwungene TURN-Verbindungen über UDP und TCP sind geprüft. Die Relay-Browserprüfungen empfingen Medien und übertrugen jeweils ein SHA-256-geprüftes 1-MiB-Datei-Echo. Ein kurzer Zwei-Geräte-Take im Auto-Modus bestätigte gespeicherte Kamera-/Mikrofonspuren, vollständige Hostübernahme und einen direkten Host/Host-Pfad ohne gemeldete Paketverluste oder Video-Freezes. Das belegt noch keine serverreflexive STUN-Route über getrennte NAT-Netze und ersetzt keine unabhängige Dekodierung der Benutzerdateien.

Bei einem begrenzten TURN-Test wurde ein Konflikt zwischen Relay-Bandbreitenlimit und gleichzeitigem Live-/Dateiverkehr beobachtet. Die Aufnahme und Originalübernahme wurden abgeschlossen, der Livekanal hatte jedoch Paketverluste. Der Rust-Port ändert diese bereits bestehenden Bandbreitenvorgaben nicht; bei einem eigenen Relay müssen Medien- und Dateibudget zur verfügbaren Bandbreite passen. Hardware-, Mehr-Gigabyte- und Langzeitabnahme bleiben unter [acceptance.md](acceptance.md) aufgeführt.
