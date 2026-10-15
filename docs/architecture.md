# Architektur

Stand: 26.09.2026. Die Kernmodule sind implementiert. Dieses Dokument enthält auch Architektur- und Abnahmeziele; der [Prüfstand](verification.md) grenzt geprüfte Funktionen von offenen Hardware-, Netzwerk- und Dauertests ab.

## 1. Umfang und Grundregeln

Ein Raum enthält 2–4 Browserteilnehmer, einschließlich Host. Ein Teilnehmer kann mehrere lokale Aufnahmequellen besitzen; das ist unabhängig von der Anzahl der Raumteilnehmer. Zielplattform ist zunächst Desktop-Chrome und Edge unter Windows mit nativer Ordnerablage, anschließend nach denselben Tests macOS und Linux. Brave ohne aktivierte File System Access API muss diesen Speicherpfad nicht unterstützen.

Verbindliche Entwurfsregeln:

- Ein Ausfall von Signalisierung, Livecall oder Transfer beendet keinen gesunden lokalen Recorder.
- Kein Liveempfänger und kein Server ist Voraussetzung dafür, Originale lokal zu speichern.
- Jede Kamera und jedes Mikrofon bleibt als eigene Spur erhalten. Das Liveprogramm ist eine gesonderte Auswahl bzw. Mischung.
- Der Aufnahmestatus folgt erfolgreichen lokalen Schreibvorgängen, nicht allein einem laufenden Encoder oder einem Hostbefehl.
- Beendete Originalsegmente sind unveränderlich. Nach Fehlern werden neue Epochen angelegt, keine alten Dateien überschrieben.
- Technische Zustände werden pro Quelle erfasst. Eine ausgefallene Kamera darf nicht als erfolgreiche Gesamtaufnahme verborgen bleiben.
- Mehrere Gigabyte Originalmaterial pro Sitzung müssen mit begrenzten Medienpuffern aufgezeichnet, überprüft, per P2P übernommen und exportiert werden können. Die native Ordnerablage in Chrome/Edge ist der reguläre Zielpfad; ein erfolgreicher OPFS-Test ersetzt seine Abnahme nicht.

KISS bedeutet hier: ein Koordinationsprozess, direkte WebRTC-Verbindungen, ein lokales Speicherverfahren, ein Aufnahmeformat pro Medientyp und möglichst wenig Eigenimplementierung unterhalb der Produktlogik. Ein getesteter Muxer ist sinnvoller als ein selbst geschriebener MP4-Container.

## 2. Komponenten und Zuständigkeiten

### Browser

| Modul            | Verantwortung                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Studio UI        | Gerätecheck, Teilnehmer, Controls, verständliche Speicher- und Fehlerzustände              |
| Capture Manager  | Geräte öffnen, Einstellungen erfassen, Quellenidentitäten vergeben, Geräteverlust erkennen |
| Recorder         | Zeitstempel übernehmen, Video kodieren, PCM erfassen, Segmente abschließen                 |
| Local Store      | Ordnerzugriff, Schreiben/Schließen, Prüfsummen, Segmentbelege, Recovery                    |
| Room Client      | Authentifizierung, Raumzustand, idempotente Hostbefehle und Zeitschätzung                  |
| Live Mesh        | Peer-Verbindungen, Medienzuordnung, Senderprofile, Statistiken und ICE-Reconnect           |
| Transfer Manager | Freigaben, Inventarvergleich, begrenzte Sendepuffer, sichere Empfangsbestätigung           |
| Exporter         | Originalsegmente zu nutzbaren Dateien zusammenführen und Zeitinformationen ausgeben        |

UI, Signalisierung und Recorder haben getrennte Lebenszyklen. Vue besitzt die Anzeigezustände, aber keine durch Komponenten-Neumounts gestoppten Aufnahmeobjekte; die Oberfläche liest den Runtime-Zustand über eine Referenz, die bei jeder Runtime-Änderung neu rendert. Rechen- und Dateiarbeit erfolgt soweit unterstützt in Dedicated Workern; Audio läuft in einem AudioWorklet. Es gibt keine globale Medienzustandsmaschine, die bei jeder Verbindungsänderung alles neu startet.

### Koordinationsdienst

Ein TypeScript-Dienst mit Node.js LTS, Fastify und WebSocket erfüllt folgende Aufgaben:

- Statische Clientdateien und eine kleine HTTP-API ausliefern.
- Räume erstellen, maximal vier Teilnehmer zulassen und Rollen prüfen.
- SDP, ICE-Kandidaten und kleine Steuernachrichten nur zwischen berechtigten Raumteilnehmern vermitteln.
- Aufnahmevorbereitung, Start, Stop und Statusmeldungen weitergeben.
- Zeitproben beantworten und kurzlebige TURN-Zugangsdaten ausgeben.

Kein Upload-Endpunkt für Medien, kein Transcoder, keine Datenbank, kein Redis und kein serverseitiger Medienjob. Räume und Teilnehmerpräsenz liegen im RAM. Ein Serverneustart unterbricht diese Koordination; bestehende Medienverbindungen können weiterlaufen, müssen es aber nicht. Clients reconnecten mit einem signierten Raum-/Rejoin-Token. Der Raum wird anhand gültiger Rollen und Clientzustände neu aufgebaut; ein alter Startbefehl wird nicht erneut ausgeführt.

Raum- und Aufnahme-ID sind unabhängig. Der Host bewahrt sein Host-Token lokal auf. Das Signaturgeheimnis des Dienstes bleibt über Containerneustarts stabil; dies ist Konfiguration, keine Aufnahmehaltung. Verlorene/abgelaufene Raumrechte können durch einen neuen Raum und erneute Freigabe der vorhandenen lokalen Aufnahme ersetzt werden.

### Protokollskizze

Versionierte JSON-Nachrichten mit `protocolVersion`, `roomId`, `messageId`, Typ und validierter Nutzlast. Senderidentität und Rolle werden serverseitig aus der Verbindung bestimmt; eine mitgelieferte `participantId` ist kein Berechtigungsnachweis.

| Nachricht                        | Bedeutung                                                        |
| -------------------------------- | ---------------------------------------------------------------- |
| `room.join`, `room.state`        | Berechtigter Beitritt und aktueller Zustand                      |
| `peer.signal`                    | SDP/ICE an genau eine berechtigte Gegenstelle                    |
| `clock.probe`, `clock.reply`     | Zeitprobe mit Server-Prozessepoche                               |
| `record.prepare`, `record.ready` | Lokale Freigabe, Geräte-/Speichercheck und Bereitschaft          |
| `record.start`, `record.started` | Auftrag mit Take-ID und tatsächliche Startbestätigung pro Client |
| `record.stop`, `record.stopped`  | Stopauftrag und Abschlussbericht pro Client                      |
| `record.status`                  | Kleine Zähler: gesicherte Dauer, offene Daten, Fehler pro Spur   |

Start/Stop besitzen eine `commandId` und werden pro Take dedupliziert. Eine Hostrolle ist keine Erlaubnis, ohne vorherige lokale Aufnahmefreigabe Geräte einzuschalten. Gesicherte Dateien werden durch keinen Raum- oder Moderationsbefehl gelöscht.

## 3. Geräte und lokale Aufnahme

Geräte werden nach der Browserberechtigung über `enumerateDevices()` angezeigt und einzeln mit einer konkreten Geräteauswahl geöffnet. Anwendungseigene `sourceId`/`trackId` bleiben stabil; Browser-`deviceId` ist kein dauerhaftes Dateiformat und kann sich ändern. Eine neue Verbindung nach Geräteverlust erhält eine neue Spur-Epoche.

Pro Quelle werden `getCapabilities()` und vor allem `getSettings()` ausgewertet. Ein automatischer sechssekündiger Hintergrundcheck aller Quellen prüft das tatsächlich nutzbare Profil und den Speicher. Er wird bei Änderungen, nach Fehlern und sonst alle fünf Minuten wiederholt; Der Check wird wie ein echter Take unter `temp/<recordingId>/…` mit `purpose: "check"` geschrieben, damit er dieselbe Pfadlänge prüft; er erscheint nie im Archiv und wird anschließend entfernt. Chrome und Edge sind unter Windows nicht „long path aware“ (260 Zeichen je Datei, 248 je Ordner). Der Schreibtest bei der Ordnerwahl legt deshalb eine Datei in voller Aufnahmetiefe an und weist zu tiefe Ordner mit einem klaren Hinweis ab. Standardmäßig öffnet jeder Teilnehmer eine Kamera und ein Mikrofon, sobald ein Aufnahmeordner freigegeben ist; das Gerät wird in der Quelle selbst gewechselt, weitere Quellen sind Zusatz. Das Aufnahmeprofil (720p, 1080p, 4K) bestimmt im Raum der Host für alle; Gäste übernehmen es außerhalb laufender Aufnahmen automatisch, offene Kameras erhalten es per `applyConstraints()`. Quellen werden mit bevorzugtem 16:9-Format geöffnet; Vorschauen liegen in festen 16:9-Flächen und zeigen das tatsächliche Bild unverzerrt. Mehrere USB-Kameras können gemeinsame Busbandbreite beanspruchen, mehrere Encoder um Hardware-Ressourcen konkurrieren. Mehrkanal-Audiointerfaces werden nur in den Kanälen unterstützt, die Chrome tatsächlich offenlegt; ASIO-Zugriff wird nicht vorausgesetzt.

### Video

Ein Capture-Track liefert Frames an einen kontinuierlichen WebCodecs-Encoder. `MediaStreamTrackProcessor` und der Transfer des Frame-Streams an einen Worker werden im unterstützten Chrome geprüft; die Verfügbarkeit in Window und Worker wird nicht gleichgesetzt. `VideoFrame`-Ressourcen werden nach Gebrauch freigegeben. WebCodecs stellt kodierte Pakete bereit, keine fertigen MP4-Dateien. [Chrome: WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)

Die erste zu validierende Kombination ist H.264/MP4 mit kurzen GOPs und geringer Encoderpufferung. Profil, Level, Auflösung und Bitrate werden gemeinsam per `VideoEncoder.isConfigSupported()` und realem Aufnahmeversuch geprüft. Ein positives API-Ergebnis garantiert weder Hardwarebeschleunigung noch ausreichende Leistung mehrerer Encoder. Hochwertigere Profile dürfen nur gewählt werden, wenn der gesamte Aufbau stabil bleibt.

Als Muxer-Kandidat wird **Mediabunny** geprüft: bereits kodierte Pakete einspeisen, kleine Ausgaben finalisieren und später Originale remuxen. Die Bibliotheksversion wird beim Vorversuch festgeschrieben. Die geforderte Segmentierung ist eigene Produktlogik und keine ungeprüfte Bibliotheksgarantie. [Mediabunny: Media sources](https://mediabunny.dev/guide/media-sources)

Recorder und Livekanal besitzen getrennte Verbraucher. Die Liveauflösung wird am RTP-Sender reduziert. Ein `applyConstraints()` auf einem geklonten Capture-Track wird nicht als sichere Isolierung von der gemeinsamen Kameraquelle betrachtet. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

### Audio

Jede aktivierte Mikrofonquelle hat einen eigenen Audioeingang und eine eigene PCM-Spur. Ein gemeinsamer AudioContext pro Teilnehmer liefert eine lokale Sample-Zeitbasis. Ein AudioWorklet sammelt Blöcke und übergibt sie über einen begrenzten Pool transferierbarer Puffer an den Speicherworker. Dateizugriff, Hashing und Netzoperationen finden nicht im Echtzeit-Audiocallback statt.

Ziel sind 48 kHz bei deaktivierter Echounterdrückung, Rauschunterdrückung und automatischer Verstärkung im Kopfhörerprofil. Float32 erhält die vom Audiographen gelieferten Werte, ist aber kein Nachweis für einen 32-Bit-Wandler. Browser oder Treiber können zuvor resampeln und verarbeiten; tatsächliche Sample-Rate, Kanalzahl und Einstellungen werden im Manifest festgehalten. Die Web-Audio-Verarbeitung benutzt eine gemeinsame Context-Sample-Rate. [Web Audio API](https://www.w3.org/TR/webaudio/)

Die Liveunterhaltung erhält einen explizit ausgewählten Mix der lokalen Mikrofone mit Übersteuerungsanzeige. Empfangsaudio wird ausschließlich ausgegeben und niemals in den eigenen Sendemix zurückgeführt. Lokales Software-Monitoring ist standardmäßig aus; für Monitoring wird der Hardwarepfad des Audiointerfaces bevorzugt.

### Datenschutzschalter

Die normalen Mute-/Kamera-Schalter wirken auf Live- und Aufnahmeverbraucher. Ab ihrem protokollierten Zeitpunkt werden Stille bzw. schwarze Frames gespeichert; die Zeitachse bleibt erhalten. Ein Kameraschalter betrifft alle Kameraspuren, Bildschirmfreigabe hat einen eigenen Schalter. Eine einzelne Quelle kann zusätzlich im Quellenpanel deaktiviert werden.

Keine Implementierung darf nur die Livekopie deaktivieren und unverändert weiter Originale speichern, während die UI „stumm“ oder „Kamera aus“ anzeigt. Ein ausdrücklich aktivierter späterer Modus „nur live“ erhält eine separate, dauerhafte Anzeige.

## 4. Sicherheit der Aufnahme

Der konkrete Speichervertrag steht im [Aufnahmeformat](recording-format.md). Die Dateien in der gewählten lokalen Ablage sind die maßgebliche Datenquelle. IndexedDB merkt Speicherart und Handle, ist aber kein unverzichtbarer Katalog der Originale. Nach Verlust des Browserprofils kann ein nativer Ordner erneut ausgewählt und eingelesen werden. Bei Browserablage ist diese Unabhängigkeit vom Profil ausdrücklich nicht gegeben.

Ein Take besitzt innerhalb eines Browserprofils genau einen Writer; ein browserlokaler Lock sperrt parallele Aufnahmetabs. Jede neue Schreibinstanz verwendet zusätzlich eine eindeutige Epoche, damit auch getrennte Browserprofile keine vorhandenen Segmentnamen wiederverwenden. Der Lock ist keine betriebssystemweite Ordnersperre. Ein zweiter Tab darf vorhandene Aufnahmen anzeigen, aber nicht dieselbe laufende Epoche bearbeiten.

Der reguläre Aufnahmeweg ist ein frei gewählter nativer Ordner in Chrome/Edge. Die implementierte OPFS-Alternative unter `localtake-recordings` ist auf Benutzerwunsch vorübergehend deaktiviert (`BROWSER_STORAGE_ENABLED=false`). Oberfläche, direkte Aktivierung und automatische Wiederöffnung respektieren diese Sperre. Bestehende Browserdateien und gespeicherte Handles bleiben erhalten. Alte Diagnoseablagen werden nicht als Produktionsbestand übernommen. Der folgende OPFS-Vertrag beschreibt die zurückgestellte Implementierung, nicht den aktuell aktivierten Aufnahmeweg. [Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)

Vor Aktivierung wird ein Schreibtest einschließlich Schließen und Rücklesen durchgeführt. Die Browserablage fragt über `navigator.storage.persist()` Löschschutz an; ein verweigertes oder unbekanntes Ergebnis bleibt sichtbar. `navigator.storage.estimate()` liefert ihr ungefähres Speicherbudget. Das Löschen von Websitedaten oder des Browserprofils entfernt den Bestand auch bei gewährter Persistenz. Für Originale sind daher Downloads nach Aufnahmeende nötig. Die Dateioperationen bleiben begrenzt gepuffert und melden Quota-/Schreibfehler; Quotenanzeigen sind keine Haltbarkeitsgarantie. [StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)

Der Preflight öffnet den Ordner durch eine Nutzeraktion, schreibt eine Probe, schließt sie und liest sie zurück. Ordnerrechte werden nach Neustarts erneut geprüft. Eine fehlende Berechtigung blockiert den Recorderstart, nicht den Livecall. Die Dateisystem-API kann erneute Freigabe verlangen. [Chrome: Dateiberechtigungen](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)

Der freie Platz eines gewählten Betriebssystemordners ist aus einer Webanwendung nicht portabel exakt bestimmbar. `navigator.storage.estimate()` beschreibt Browserspeicher und ist dafür kein Ersatz. Die UI zeigt eine Größenprognose, einen Reservebedarf und tatsächliche Schreibfehler; sie behauptet keinen unbelegten freien Speicherplatz.

Die native Schreib-API verwendet 64-Bit-Größen und -Dateipositionen und kann Dateien über 4 GiB fortlaufend schreiben. Grenzen des tatsächlichen Datenträgers/Dateisystems und Schreibfehler bleiben maßgeblich. Originalsegmente werden typischerweise nach zwei Sekunden abgeschlossen; 256 MiB ist die maximale einzelne Segmentgröße, keine Grenze des Takes. Die Schreibwarteschlange pro Spur ist auf 64 MiB begrenzt. Archiv und Hashprüfung lesen jeweils ein Segment, P2P sendet Blöcke von höchstens 16 KiB und hält beim Empfang nur die aktuelle Segmentdatei im Medienpuffer. Metadaten wachsen mit der Segmentanzahl. Videoexport schreibt fragmentiertes MP4 in einen Stream; PCM-WAV wird ebenfalls gestreamt und vor Überschreiten der klassischen RIFF-Größenfelder in weitere Dateien geteilt. [FileSystemWritableFileStream](https://fs.spec.whatwg.org/#api-filesystemwritablefilestream).

| Ereignis                             | Verhalten                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet oder WSS fällt aus          | Lokal weiter aufzeichnen; Status „Verbindung unterbrochen“; Reconnect getrennt behandeln                                                       |
| Ein Gerät endet                      | Letztes mögliches Segment dieser Spur abschließen; Ausfall und Zeitlücke festhalten; übrige Spuren weiterführen                                |
| Schreibfehler / Datenträger voll     | Betroffene Spur sofort als fehlerhaft markieren, begrenzte Restpuffer behandeln, gesundes Material erhalten; niemals grün weiterzählen         |
| Encoderfehler / anhaltender Rückstau | Transfer und Vorschauen entlasten; fehlende Frames erfassen; betroffene Spur kontrolliert beenden, falls ihr Profil nicht gehalten werden kann |
| Host verschwindet                    | Eigene Aufnahme läuft weiter; Teilnehmer können lokal stoppen; kein automatischer Verlust ihrer Spuren                                         |
| Stop erreicht einen Client nicht     | Host zeigt fehlende Bestätigung; betroffener Client stoppt lokal oder nach Reconnect. Kein behaupteter globaler Abschluss                      |
| Tab-/Browserabsturz                  | Aufnahme endet; beim Wiederöffnen Ordner scannen und gesicherte Segmente retten                                                                |
| Anwendung wird aktualisiert          | Laufender Take behält seine App-/Protokollversion; keine automatische Seitenaktualisierung während Aufnahme/Transfer                           |

Geplanter lokaler Zustand pro Spur:

```text
idle -> checking -> ready -> recording -> finalizing -> saved
                          \-> failed      \-> partial
abgebrochener Bestand -> recovering -> saved / partial
```

Die Anwendung hat eine lokal gecachte Recovery-Oberfläche mit ihren nötigen Modulen. Ohne Netz kann ein zuvor vollständig geladener Client vorhandene Ordner prüfen und exportieren. Ein Service Worker hält keine Aufnahme am Leben. Wake Lock und eine Warnung vor dem Verlassen sind Komfortfunktionen, keine Garantie gegen Ruhezustand oder Prozessende.

## 5. Liveverbindung und Videopriorität

Jedes Browserpaar besitzt eine `RTCPeerConnection`. Bei vier Teilnehmern hat jeder drei Gegenstellen. Das Sendeprogramm pro Teilnehmer besteht aus einer gewählten Kamera, einem Mikrofonmix und optional einem Bildschirmtrack. Alle lokalen Kameras werden aufgezeichnet, aber im MVP nicht alle gleichzeitig live übertragen. Diese Begrenzung hält Upload und Encoderlast klein.

Der zusätzliche Bildschirmtrack startet durch `getDisplayMedia()` und die Browserauswahl. Ein Host kann diese Berechtigung nicht stellvertretend erteilen. Systemaudio wird nur angeboten, wenn es bei der gewählten Oberfläche tatsächlich verfügbar ist; ein `ended`-Ereignis beendet nur die Freigabe. [Screen Capture](https://www.w3.org/TR/screen-capture/)

Verbindungsaufbau: authentifizierte Signalisierung, Trickle ICE, eindeutige Rollen zur Verhandlung und kontrollierter ICE-Restart. Der Coordinator bleibt aus dem Medienpfad heraus. Ein fehlender TURN-Pfad wird im Geräte-/Netzcheck sichtbar und nicht als zuverlässiger Internetbetrieb verkauft.

Die Adaptionsregeln sind eine Produktentscheidung:

1. Dateiübernahme während aktiver Aufnahme/Liveunterhaltung standardmäßig pausieren.
2. Lokale Vorschauen kleiner/seltener rendern, ohne Capture- und Aufnahmeparameter zu verändern.
3. Bei Netzengpässen zuerst die Bildschirmbildrate, dann Liveauflösung und Livebitrate senken.
4. Eine flüssige Kamera mit etwa 24–30 fps möglichst lange erhalten; Audio erhält ein Budget für verständliche Sprache, im Notfall etwa 32–48 kbit/s Opus mono.
5. Erst danach Kamerabildrate reduzieren. Reicht selbst das Mindestbudget nicht, ist „Video beeinträchtigt“ bzw. vorübergehend nur Audio ein sichtbarer Notbetrieb.

`RTCRtpSender.setParameters()` dient insbesondere für Bitratenobergrenzen, Bildrate und Skalierung. Eine feste Netzpriorität oder exakt reservierte Mindestbandbreite lässt sich daraus nicht garantieren. Die Anwendung prüft `getStats()` auf Bitrate, RTT, Paketverlust, Bildrate, verworfene Frames und Qualitätsbegrenzung; Veränderungen werden gedämpft statt bei jedem Messwert umgeschaltet. [WebRTC-Spezifikation](https://www.w3.org/TR/webrtc/)

Beispielbudget ohne Protokolloverhead: `(N - 1) × (Kamera + Audio + Bildschirm)`. Bei vier Teilnehmern und 2 Mbit/s Kamera plus 64 kbit/s Audio sind das rund **6,2 Mbit/s Upload pro Teilnehmer**, mit 1,5 Mbit/s Bildschirm zusätzlich rund **10,7 Mbit/s**. Hardware-Encoding kann pro Gegenstelle zusätzliche Ressourcen verbrauchen; Wiederverwendung darf nicht vorausgesetzt werden.

Ein SFU ist eine spätere Architekturentscheidung, falls größere Räume oder die gemessene Mesh-Last es erfordern. Er würde Medien weiterleiten, weiterhin ohne Aufnahmespeicher. Der lokale Recorder und das Dateiformat bleiben davon unabhängig.

## 6. Gemeinsame Zeitachse

„Sync“ umfasst zwei unterschiedliche Aufgaben: Dateien vollständig übernehmen und Spuren zeitlich ausrichten. Für Ersteres reichen Dateiinventar und Hashes; für Letzteres werden Medienzeitstempel und Clock-Metadaten benötigt.

Jeder Take hat eine Aufnahme-ID, jeder Browserlauf eine neue Clock-Epoche. Lokal zählen monotone Zeiten und Audio-Samplepositionen; `Date.now()` dient nur der lesbaren Anzeige. Startzeiten entstehen aus den tatsächlich ersten Samples/Frames, nicht aus dem Eintreffen eines WebSocket-Befehls.

Der Coordinator beantwortet regelmäßig Vier-Zeitstempel-Proben. Bei Client-Sendezeit `t1`, Server-Empfang `t2`, Server-Antwort `t3` und Client-Empfang `t4` werden geschätzt:

```text
Offset Server minus Client = ((t2 - t1) + (t3 - t4)) / 2
Netz-RTT                   = (t4 - t1) - (t3 - t2)
```

Der Entwurf nutzt bevorzugt Proben mit geringer RTT, verwirft Ausreißer und speichert die Messreihe samt Unsicherheit. Aus mehreren Proben entsteht eine Abbildung `sessionTime ≈ a × localTime + b`; `a` beschreibt Drift. Ein Serverneustart erzeugt eine neue Zeitepoche. Die alte Take-Zeitachse bleibt erhalten und wird über Clients mit bekannten Abbildungen angebunden; bei unzureichenden Daten wird ein ungeklärter Offset markiert, nicht geraten.

Die Zuordnung von Videotimestamps und Audio-Sampleuhr zur lokalen monotonen Uhr muss separat geprüft und dokumentiert werden. Zeitstempel der Callback-Ankunft sind wegen Scheduling-Jitter kein Ersatz für Capture-Zeiten. Unterschiedliche Kamerapuffer, Mikrofonlatenzen und Hardwareuhren bleiben mögliche Fehlerquellen, auch innerhalb eines Rechners.

Ein geplanter Start mit etwa einer Sekunde Vorlauf erleichtert die Koordination, ersetzt aber keine gemessenen Spurstarts. Eine synchrone atomare Aufnahme aller Clients wird bei Netzpartitionen nicht versprochen. Start-/End-Slate und Vergleichssignale dienen im Test zur Messung des tatsächlichen Versatzes.

Originale behalten ihre Zeitbasis unverändert. Der Export schreibt Offsets, Lücken, Drift und Unsicherheit in `timeline.json`. Eine spätere ausgerichtete Fassung darf Stille/Schwarz ergänzen und Audio resampeln; sie wird als abgeleitete Datei geführt. Samplegenaue automatische Synchronität zwischen Rechnern ist kein MVP-Versprechen.

## 7. Docker, Caddy und TURN

Geplanter Produktionsaufbau:

```text
Internet HTTPS/WSS :443 -> vorhandener Caddy -> localtake:3000
Browser <---------- direktes WebRTC ---------> Browser
Browser <---- TURN, falls direkte ICE-Verbindung scheitert ----> Browser
```

Das App-Image enthält den gebauten Client und den Server. Es läuft als unprivilegierter Benutzer mit nur intern erreichbarem Port 3000 und ohne Medienvolume. Caddy und App teilen ein Docker-Netzwerk. Healthcheck ist `GET /healthz`. Der Betrieb ist zunächst Single-Instance; mehrere Instanzen ohne gemeinsame Raumverwaltung wären kein transparenter Scale-out.

Vereinfachte Konfigurationsskizze; die ausführbaren Dateien liegen unter [deploy](../deploy/README.md):

```caddyfile
studio.example.com {
    encode zstd gzip
    reverse_proxy app:3000
}
```

Ist Caddy ein Hostdienst statt ein Container, wird die App beispielsweise nur auf `127.0.0.1:3000` veröffentlicht und dieses Ziel verwendet. Caddy unterstützt WebSocket-Upgrades im Reverse Proxy. Domain und Zertifikate werden erst bei der Bereitstellung konkret festgelegt. [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Geplante Appkonfiguration: `PUBLIC_ORIGIN`, `PORT`, `ROOM_SIGNING_SECRET`, `TURN_URLS`, `TURN_SHARED_SECRET`, Raum-/Token-Laufzeiten und `MAX_PARTICIPANTS=4`. Secrets werden außerhalb des Images bereitgestellt und nicht eingecheckt. Client und WSS verwenden denselben Origin.

TURN wird separat, etwa mit coturn, betrieben. Üblich sind 3478 UDP/TCP, optional 5349 TLS sowie ein ausdrücklich konfigurierter und in der Firewall freigegebener UDP-Relay-Portbereich. Öffentliche Adresse, NAT-Zuordnung und Zertifikat müssen zum Host passen. Für Netze, die nur TCP 443 zulassen, kann TURN/TLS auf einer separaten öffentlichen IP mit Port 443 nötig sein; ein anderer DNS-Name allein löst den Portkonflikt mit Caddy nicht. Ein gewöhnlicher HTTP-Reverse-Proxy transportiert dieses Protokoll nicht. [coturn](https://github.com/coturn/coturn)

TURN ist beim ersten LAN-Test optional, für robusten Internetbetrieb aber Teil des Designs. Zugangsdaten sind kurzlebig; der Dienst wird kein offenes Relay. Relay-Bandbreite kann auch beim späteren P2P-Dateitransfer anfallen.

## 8. Zugriff, Vertrauen und Daten

Einladungen enthalten signierte Berechtigungen; Host- und Gastrechte sind getrennt. Der Raum-/Einladungslink bleibt im URL-Fragment, während private Teilnehmer-/Hosttokens ausschließlich im Browser gespeichert werden und nicht in Access-Logs gelangen. Der Server prüft Origin, Raumzugehörigkeit, Hostrechte, Nachrichtengröße und Rate. Der Host ist immer der Ziel-PC; automatisch gesendet werden nur die eigenen Aufnahmen aus diesem Raum, eine manuelle Freigabe anderer Bestände gibt es nicht. Der Host nimmt Angebote nur aus dem aktuellen Raum vom jeweiligen Aufnahmeeigentümer an. P2P läuft nach dem lokalen Stopp mit begrenzter Bandbreite bei aktivem Livekanal; abgeschlossene Originaldateien und Empfangsbelege ermöglichen die Fortsetzung nach Neuladen ohne Kopieren der gesamten Sitzung in den RAM.

WebRTC verschlüsselt den Transport von Medien und DataChannels. Das übliche Vertrauen in ausgelieferte Webanwendung, Signalisierungsdienst und Endgeräte bleibt bestehen; Schutz gegen einen manipulierten Coordinator oder kompromittierten Client ist damit nicht bewiesen. TURN erhält verschlüsselte Verkehrsdaten und IP-/Verbindungsmetadaten, keine bewusste Serverkopie der Originaldateien. Lokale Dateien erhalten keine zusätzliche App-Verschlüsselung im MVP.

Dateinamen stammen aus bereinigten Anzeigenamen und internen IDs. Empfangene Namen werden nicht als ungeprüfte Dateisystempfade interpretiert. Manifeste, Dateigrößen und Segmentnummern werden vor dem Anlegen geprüft. Vollständiges SDP, Tokens, Chattexte und Medieninhalte werden aus Diagnosen entfernt. Neben lokalen Diagnoseexporten kann der Betreiber begrenzte automatische Serverdiagnosen aktivieren; sie können Netzwerkadressen und Browserinformationen enthalten. Authentifizierung, Filterung und Aufbewahrung beschreibt [telemetry.md](telemetry.md).

## 9. Vorgesehene Repository-Struktur

Die Implementierung verwendet folgende Struktur:

```text
apps/
  client/src/
    studio/ capture/ recorder/ storage/ room/ live/ transfer/ export/
    core/                   # Laufzeit und Zeitabbildung; Worker liegt unter recorder/
  server/src/
packages/
  protocol/                # Nachrichtentypen und Laufzeitvalidierung
docs/
deploy/                    # Dockerfile, Compose und Caddy-/TURN-Beispiele
tests/                     # Protokoll-, Recovery-, PCM- und Transfertests
```

Npm Workspaces reichen aus. Versionen werden mit Lockfile fixiert. Ein zweites Backend-Framework, eine zusätzliche Medienplattform und eine native Begleitanwendung sind für den bestätigten Startumfang nicht vorgesehen.
