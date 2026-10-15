# Diagnose und begrenzte Serverprotokolle

Der Button „Diagnose“ oben rechts zeigt den vollständigen lokalen Bericht und den Zustand des automatischen Versands. Er ist auch im Dialog zur Ordnerfreigabe verfügbar. Browserkennung, Raum-, Teilnehmer-, Verbindungs- und Aufnahme-ID ordnen Ereignisse beider Teilnehmer und des Koordinators zu; UTC-Zeit, lokale Zeit und die Sitzungszeit-Abbildung helfen beim Vergleich.

## Erfassung und Aufwand

Der Browser sendet während eines Raums regulär alle 30 Sekunden einen kompakten Status. Fehler und Aufnahmeübergänge können früher gebündelt gesendet werden, höchstens einmal alle fünf Sekunden. Ein Batch enthält höchstens 24 Ereignisse und 12 KiB UTF-8. Der Client hält höchstens 128 wartende Ereignisse plus einen laufenden Batch. Bei Überlast werden ältere Ereignisse verworfen. Eine Anfrage läuft höchstens drei Sekunden; Fehler verursachen eine Pause bis zu fünf Minuten und höchstens zwei Wiederholungen je Batch. Beim Raumwechsel werden alte wartende Daten verworfen. Ein Server ohne freigegebene Telemetrie erhält keine automatischen Anfragen. Reine lokale Aufnahmen ohne Raumanmeldung erzeugen keine Serverprotokolle.

Der Versand benutzt einen eigenen HTTP-Endpunkt, unabhängig von WebSocket-Signalisierung und P2P-Dateikanälen. Aufnahme und Verbindungsbefehle warten weder auf Versand noch auf Logdateien. Es gibt keine zusätzlichen automatischen WebRTC-, Speicher- oder Berechtigungsabfragen: Der Status verwendet die für Live-Anpassung ohnehin gelesenen RTC-Statistiken. Ein Recorderworker meldet seine Schreibqueue und den Speicherverzug höchstens alle zehn Sekunden über den bestehenden Fortschrittspfad. Kein zusätzlicher Code läuft im AudioWorklet.

Erfasst werden Zustandswechsel von WSS, ICE, DTLS/PeerConnection und Datenkanälen, STUN-Fehler, Kandidatentypen und ausgewählte Route, RTT, Bandbreite, Verlust-/Jitter-/Freeze-Zähler soweit der Browser sie bereitstellt, Aufnahme-/Quellenstatus, Speicherverzug, Recorderqueue und Uploadstatus. Fehlende Statistikwerte bleiben unbekannt. Ein Fehler vor Aufbau einer Liveverbindung kann nach erfolgreicher Raum-API-Anmeldung ebenfalls per HTTP ankommen. Wenn auch HTTP ausfällt, bleiben die letzten 300 Ereignisse lokal für Kopieren/Download erhalten.

Automatische Protokolle enthalten keine Audio-/Video-/Dateiinhalte, Chattexte oder vollständiges SDP. Token, Authorization, TURN-Zugangsdaten und ICE-Passwörter werden clientseitig und nochmals beim Speichern gefiltert. Netzwerkadressen und Browserinformationen können enthalten sein. Der Endpunkt benötigt einen signierten Teilnehmer-Sessiontoken; Raum und Teilnehmer werden daraus bestimmt. Einladungen allein reichen nicht. Es gibt keinen öffentlichen Endpunkt zum Lesen der Logs.

## Speichergrenzen

`TELEMETRY_DIR=/var/log/localtake` aktiviert die Speicherung; ohne Variable bleibt sie deaktiviert. Docker mountet dafür ein eigenes persistentes Volume, das dem Benutzer `node` gehört. Eine App-Instanz schreibt in ein Volume. Mehrere gleichzeitige Writer werden nicht unterstützt.

- Höchstens **900.000.000 Bytes** für eigene JSONL-Diagnosedateien, auch wenn `TELEMETRY_MAX_BYTES` einen größeren Wert angibt.
- Höchstens **8.000.000 Bytes je Datei**, zusätzliche Rotation nach einem Tag. Vor dem nächsten Schreibvorgang, der die Gesamtgrenze überschreiten würde, werden die ältesten Dateien gelöscht. Beim Start wird ein bestehender Überhang entfernt.
- Dateien älter als sieben Tage werden beim Start, Schreiben und einer minütlichen Wartung entfernt. Hohe Aktivität kann die tatsächlich verfügbare Historie verkürzen.
- Normale Docker-App-Logs: `json-file`, `max-size=25m`, `max-file=2`. **Diagnose und Docker-App-Logs zusammen: höchstens rund 952.428.800 Bytes**, unter einem dezimalen GB. Dies gilt für LocalTake; Logs anderer Dienste und Reverse-Proxy-Logs besitzen eigene Grenzen.
- Schreibqueue höchstens 2 MiB und 512 wartende Zeilen, asynchrone Schreibgruppen höchstens 64 KiB. Bei voller Queue werden neue Diagnosen verworfen. Bei weniger als 256 MiB freiem Datenträgerspeicher, Schreibschutz oder I/O-Fehler wird die Queue verworfen und eine Minute pausiert. Diagnosefehler führen zu keinen wiederholten Konsolenmeldungen. Routinemäßige Fastify-Request-Logs sind abgeschaltet.

Die Rotation betrifft ausschließlich eigene `telemetry-<Zeit>-<UUID>.jsonl`-Dateien im konfigurierten Verzeichnis. Andere Dateien werden nicht gelöscht. Die Grenzen werden in der Anwendung durchgesetzt; das Volume muss dafür keine 900 MB vorab reservieren. Allgemeine CPU-/I/O-Konkurrenz lässt sich nicht vollständig ausschließen, ist jedoch durch diese Mengen- und Zeitgrenzen beschränkt.

## Protokolle im eigenen Deployment lesen

Mit administrativem Zugriff auf den eigenen Docker-Host, ohne Raumtoken zu benötigen:

```sh
docker compose exec app node dist/apps/server/src/telemetry-read.js
docker compose exec app node dist/apps/server/src/telemetry-read.js --room RAUM-UUID
docker compose exec app node dist/apps/server/src/telemetry-read.js --page BROWSER-UUID
docker compose exec app node dist/apps/server/src/telemetry-read.js --recording AUFNAHME-UUID
docker compose logs --tail=100 app
```

Der Leser durchsucht nur die letzten vier Dateien und gibt höchstens 200 JSONL-Zeilen aus. Eine vollständige historische Analyse erfolgt direkt am Volume; regelmäßige Vollscans sind für den normalen Betrieb nicht nötig. Die minütlichen `telemetry.status`-Zeilen enthalten Speicherbedarf, Queuelänge, verworfene Zeilen und eine etwaige Schreibpause. „Letzte Annahme“ im Browser bedeutet Annahme in der begrenzten Serverqueue, keine garantierte Speicherung bei anschließendem Datenträgerausfall.
