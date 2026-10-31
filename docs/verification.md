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

## Schreibprüfung mit Zeitlimit und Wiederanlauf, 31.10.2026

Ein gemeldeter Hänger nach der Ordnerwahl auf Android/Edge wurde auf unbegrenzt wartende Browseroperationen im bisherigen Ablauf eingegrenzt; der konkrete Android-Dateianbieter wurde nicht direkt untersucht. Die Schreibprüfung zeigt jetzt den aktuellen Schritt und endet nach spätestens 15 Sekunden, statt dauerhaft „wird geprüft“ anzuzeigen. Das optionale Merken der Auswahl und nichtinteraktive Abfragen sind auf drei Sekunden begrenzt. Eine fehlgeschlagene Speicherung der Präferenz blockiert einen erfolgreich geprüften Ordner nicht mehr. Auswahl- und Freigabedialoge besitzen weiterhin kein automatisches Zeitlimit. Die zurückgestellte OPFS-Produktionsoption bleibt deaktiviert.

Bestanden: 17 Rust-Tests und 224 Vitest-Tests in 25 Dateien, Client-Typprüfung, Produktionsbuild und Formatprüfung. Acht neue Regressionen prüfen hängende Freigabe-/Schließ-/Aufräumoperationen, blockiertes oder hängendes IndexedDB, späte Antworten und einen erneuten erfolgreichen Versuch, ohne einen alten Prüflauf fortzusetzen oder vorhandene Aufnahmen zu entfernen. Der Windows-Pfadtiefentest bleibt erhalten und setzt ausdrücklich die Windows-Browserkennung für den plattformspezifischen Hinweis.

Zwei zusätzliche isolierte Edge-Kontexte bestätigten den sichtbaren Dialog: Ein künstlich blockiertes Schließen endet mit genauer Phase und wieder bedienbarer Ordnerwahl; eine verspätete Antwort aktiviert den abgebrochenen Versuch nicht. Ein beschreibbarer Ordner wird trotz nicht antwortender Präferenzdatenbank übernommen. Danach bestanden synthetische Host-/Gastaufnahme mit je Kamera und Mikrofon, Neuladen des Gasts während gedrosselter Dateiübernahme, Wiederöffnung von Raum und Ablage sowie vollständig quittierter Abschluss aller Originale beim Host. Keine unbehandelten Browserausnahmen oder CSP-Verstöße; der erwartete `beforeunload`-Hinweis wurde bestätigt.

Dies ist ein Desktop-Edge-Nachweis mit künstlich blockierten Browseraufrufen und isolierter Testablage, keine Freigabe eines tatsächlichen Android-Dateianbieters. Der physische Android-Test und mobile Hintergrund-/Sperrzustände bleiben zu prüfen. Das Verhalten bei Netzverlust, Neuladen und erhaltenen Teilbeständen steht unter [Aufnahmeformat](recording-format.md#netzunterbrechung-und-neuladen).

Die zusätzliche Prüfung eines Neuladens **während einer laufenden Aufnahme** fand einen erhaltenen, aber nicht mehr von einem lokalen Recorder gedeckten Serverstatus. Der neue Client meldet diesen beim Wiederbeitritt als `partial`; ein laufender Recorder bei bloßer Signalisierungs-Wiederverbindung meldet weiter seinen tatsächlichen Zustand. Außerdem darf ein frisch geöffnetes Studio ohne aktive Ablage den ursprünglichen Ordner wieder übernehmen, während der übrige Take noch läuft. Fünf Regressionen unterscheiden laufende, abgeschlossene und tatsächlich unterbrochene lokale Recorder; insgesamt bestehen damit 17 Rust- und 229 Vitest-Tests in 26 Dateien.

Ein eigener Browserlauf lud den Gast mitten im Take neu: Ordner und Raum wurden wieder geöffnet, der Gast erschien als Teilbestand, der Host konnte regulär stoppen und die vier bestätigten Gastsegmente kamen beim Host an. Der Hostbestand war vollständig, der Gastbestand blieb korrekt als unvollständig gekennzeichnet. Beide Teilnehmer wurden anschließend wieder bereit und zeichneten einen neuen Take mit eigener ID auf; dessen Abschluss und Übertragung bestanden. Keine unbehandelten Browserausnahmen oder CSP-Verstöße.

## Zeitbudget pro Dateioperation, 31.10.2026

Nach dem anschließenden Android-Test trat der Gesamt-Timeout in Edge und Chrome beim zuletzt angezeigten Schritt „Prüfdatei schließen“ auf. Das bisherige 15-Sekunden-Limit galt jedoch für alle Operationen zusammen und belegte damit keine 15 Sekunden blockierte Schließoperation. Der Benutzer bestätigte ausdrücklich die Beschränkung auf native Aufnahmeordner; Browserablage bleibt deaktiviert. Die Prüfung gibt jetzt jedem Hintergrundaufruf 15 Sekunden, begrenzt den gesamten Ablauf auf 90 Sekunden und protokolliert Schritt- und Gesamtdauern. Zwei weitere Regressionen prüfen einen erfolgreichen Abschluss nach zwölf Sekunden Ordnerarbeit plus fünf Sekunden Schließen sowie das Gesamtlimit bei vielen jeweils noch rechtzeitig beantworteten Aufrufen. Der tatsächliche Android-Dateianbieter muss erneut geprüft werden.

Bestanden: 17 Rust- und 231 Vitest-Tests in 26 Vitest-Dateien, Client-Typprüfung, Produktionsbuild und Formatprüfung. Der isolierte Browserlauf akzeptierte den künstlich verzögerten Ordner mit 17.021 ms Gesamtdauer bei 5.001 ms Schließdauer. Ein dauerhaft blockierter Schließaufruf, verspätete Antworten und eine hängende Präferenzdatenbank wurden weiterhin korrekt behandelt. Gemeinsame Host-/Gastaufnahme, Neuladen während der Übertragung und quittierter vollständiger Empfang bestanden erneut. Das ist ein Nachweis der Zeitbudgetkorrektur mit simulierten Verzögerungen, kein physischer Android-Schreibnachweis.

## Schreibzugriff und optionales Aufräumen, 31.10.2026

Der erneute Android-Test meldete einen einzelnen 15-Sekunden-Timeout beim Entfernen der Prüfdateien. Das grenzt den nicht antwortenden Aufruf ein, belegt aber keine explizit verweigerte Löschberechtigung. Der bisherige `finally`-Ablauf konnte außerdem einen vorherigen Schreibfehler mit einem Aufräumfehler verdecken. Die Prüfung trennt jetzt erforderliches Schreiben/Schließen/Rücklesen von optionalem Aufräumen. Nur wenn beide Pfadtests mit Größen- und Hashvergleich bestanden sind, bleibt der Ordner bei einem reinen Löschfehler mit sichtbarer Warnung nutzbar. Test 1/2 und 2/2 werden in der Anzeige unterschieden.

Ein Löschfehler sperrt auch einen bereits erfolgreichen Mediencheck nicht mehr. Weitere automatische Löschvorgänge und regelmäßige Prüfaufnahmen derselben Konfiguration werden für diese Ordnerfreigabe pausiert; Originale und Testdateien bleiben erhalten. Verifizierte Exporte und quittierte Transfers können ohne anschließendes Löschen der lokalen Originale abschließen. Fehlgeschlagene Schreib-/Lesetests bleiben blockierend, selbst wenn Aufräumen zusätzlich fehlschlägt oder dauerhaft wartet. Native Aufnahmeordner bleiben die einzige Produktionsoption.

Bestanden: 17 Rust- und 235 Vitest-Tests in 26 Vitest-Dateien. Vier weitere Regressionen prüfen verweigertes Löschen, erhaltene ursprüngliche Schreib-/Lesefehler trotz zusätzlichem Aufräumfehler und verifizierten Export mit erhaltenen Originalen. Der aktualisierte Timeout-Test akzeptiert nur vorher vollständig geschlossene und zurückgelesene Prüfdateien, meldet den Löschfehler separat und prüft, dass eine weitere Ablage desselben Ordners keinen neuen blockierten Löschaufruf auslöst.

Der isolierte Edge-Browserlauf bestätigte den Ordnerdialog und erfolgreiche Kamera-/Mikrofonprüfung trotz absichtlich dauerhaft blockiertem Löschen. Die Warnung blieb sichtbar; ein erzwungener regelmäßiger Prüftermin erzeugte keine weitere Testaufnahme. Anschließend bestanden gemeinsame Host-/Gastaufnahme, Neuladen des Gasts während der Übertragung, Wiederöffnung des ausgewählten Ordners und quittierter vollständiger Empfang. Die lokalen Gastoriginale blieben verifiziert erhalten. Ein separater Kontext lehnte beschädigte Rücklesedaten sofort ab, obwohl auch dort das Aufräumen nie antwortete. Ein weiterer Kontext erlaubte das Entfernen der kleinen Pfadtests und blockierte erst das Entfernen der Medien-Prüfaufnahme: Nach 15 Sekunden blieb das Studio bereit und zeigte die Warnung; regelmäßige Wiederholungen waren ebenfalls pausiert. Keine unbehandelten Browserausnahmen oder CSP-Verstöße; der erwartete Hinweis beim Neuladen wurde bestätigt. Dieser Nachweis verwendet synthetische Medien und isolierte Testablage mit simulierten nativen Aufrufen; der konkrete Android-Dateianbieter und seine Löschfähigkeit bleiben ungeprüft.

## Lange geöffnete Tabs über Deployments, 31.10.2026

Zwei weiter geöffnete Produktionstabs auf Windows und macOS verwendeten noch eine ältere Clientversion. Beide meldeten fehlgeschlagene Recorder-Initialisierung trotz weiterhin lebender Gerätetracks; es lief keine Aufnahme. Die Worker-Datei dieser älteren Version lieferte am aktuellen Server HTTP 404. Der Gerätecheck konnte das nicht durch wiederholtes Erzeugen eines Workers mit derselben entfernten URL beheben. Der Recorder ist deshalb jetzt Bestandteil des geladenen Clientbundles; auch der Export wird mit der Anwendung geladen. Ein Serverwechsel benötigt damit für neue Worker und Exporte keine alten, später entfernten Dateien. Es wird keine laufende Aufnahme durch automatisches Neuladen unterbrochen. Bereits geöffnete Clients vor dieser Korrektur müssen einmal neu laden.

Der isolierte Edge-Test verwendete den Produktionsbuild mit den unveränderten CSP-Regeln am lokalen Rust-Server. Der erste Tab war ausdrücklich noch nicht von einem Service Worker kontrolliert. Nach dem ersten erfolgreichen Quellencheck wurden alle weiteren Asset-Anfragen künstlich mit HTTP 404 beantwortet. Ein neuer Hintergrundcheck, eine neue Raumaufnahme mit Kamera/Mikrofon und vollständiger Export bestanden trotzdem; es gab keine weiteren Worker-/Export-Asset-Anfragen, unbehandelten Browserausnahmen oder CSP-Verstöße. Die erzeugte Timeline enthielt beide Spuren und gespeicherte Clock-Abbildungen mit echten lokalen Testserverproben. Das prüft das Verhalten bei einem Releasewechsel mit synthetischen Medien, keine Hardwarelatenz oder Langzeitlast.

Eine weitere Integration entfernt den Abschlussbeleg eines bereits segmentweise gesicherten Takes, öffnet die Ablage neu, überträgt den unvollständigen Bestand automatisch und exportiert ihn beim Empfänger. Segmentbelege, Spurmetadaten, Medienstartposition, lokale Startposition und Clock-Abbildung bleiben identisch; der Export bleibt korrekt unvollständig und die ursprünglichen Teilsegmente bleiben erhalten. Zusammen bestehen 17 Rust- und 236 Vitest-Tests in 26 Vitest-Dateien. Die Dokumentation stellt ausdrücklich klar, dass Neuladen kein garantiertes Finalisieren und Metadaten kein automatischer Timeline-Import ins Schnittprogramm sind.

Die Zeitprüfung fand zusätzlich einen Unterschied zwischen einem Tab, der einen Koordinatorneustart überlebt, und einem frisch geöffneten Tab: Die interne Zeitfortsetzung des ersten Tabs wurde bisher als Teil seines gespeicherten Offsets ausgegeben, obwohl die Epoche bereits den neuen Koordinator bezeichnete. `snapshot()` zieht diesen internen Versatz jetzt ab. Ein zusätzlicher Vergleichstest prüft identische Serverzeiten der gespeicherten Abbildungen bei unterschiedlichen lokalen Zeitursprüngen; der bestehende Test für die interne Kontinuität und die Startzeitumrechnung bleibt erhalten. Damit bestehen 17 Rust- und 237 Vitest-Tests. Vorhandene Aufnahmen werden nicht rückwirkend umgeschrieben; ungeprüfte Hardwarelatenzen und automatischer Timeline-Import bleiben offene Punkte.

## Mobiler Beitritt und vorsichtige Android-Bereinigung, 31.10.2026

Ein frisches mobiles Browserprofil mit gültiger Einladung blieb nach der erfolgreichen Ordnerwahl in der lokalen Ansicht: Es wurde keine WebSocket-Verbindung geöffnet, und das Einladen-/Namensformular lag im geschlossenen Einrichtungsmenü. Nach explizitem Öffnen dieses Menüs und Beitritt erschien der Teilnehmer beim Host. Der Einladungsdialog fragt den Namen jetzt sichtbar vor der Ordnerwahl ab und tritt dem Raum bei; Schreibprüfung und Quellenfreigabe bleiben unabhängige Voraussetzungen für die Aufnahme. Gespeicherte Ordner zeigen auch während ihrer Wiederprüfung den aktuellen Schritt.

Der Nutzer meldete nach einem zuvor erfolgreichen nativen Ordner erneut einen einzelnen 15-Sekunden-Timeout beim Schließen der Prüfdatei. Diese Speicherung gilt weiter als unbestätigt. Ein App-Zeitlimit kann einen nativen Browseraufruf nicht zuverlässig stoppen. Als vorsichtige Maßnahme erfolgen auf Android vorläufig keine automatischen Löschaufrufe; Testdaten und bereits quittierte Originale bleiben mit sichtbarem Hinweis erhalten. Die Schreibprüfung überspringt weder Schließen noch Hash-Rücklesen. Andere Plattformen entfernen die bekannten Prüfpfade von unten nach oben ohne rekursives Löschen; bei fehlgeschlagenem Test beginnt Bereinigung erst nach beendeten Dateioperationen. Medien-Prüfaufnahmen beachten den Abbruch auch zwischen einzelnen Löschaufrufen.

Bestanden: 17 Rust- und 242 Vitest-Tests in 26 Vitest-Dateien, Client-Typprüfung, Produktionsbuild und Formatprüfung. Fünf zusätzliche Regressionen prüfen native Android-Ablage ohne Löschaufruf, weiterhin blockierenden Android-Schließtimeout, bekannte Prüfpfade mit und ohne fremden Inhalt sowie das Ende weiterer Löschaufrufe nach Abbruch. Die bestehende Regression für späten Dateiabschluss prüft zusätzlich, dass während des noch ausstehenden Schließens kein Löschaufruf begonnen wird.

Der isolierte Produktionsbrowser bestätigte den sichtbaren Namensschritt, Beitritt vor der Ordnerwahl, dieselbe Raum-ID mit unterschiedlichen Teilnehmeridentitäten und echten Videoempfang in beide Richtungen. Mit Android-Browserkennung und absichtlich niemals antwortenden Löschfunktionen gelangen native Ordnerauswahl über isolierte Testhandles, gemeinsame Aufnahme, quittierte Übertragung, erhaltene Originale und Wiederöffnung mit derselben Identität; Löschaufrufe blieben bei null. Ein dritter Kontext trat dem Raum bei und simulierte anschließend dauerhaft nicht antwortendes Schließen: Der Schreibtest blieb blockiert, auch nach späterem Abschluss wurde keine Ablage aktiviert. Keine unbehandelten Browserausnahmen oder CSP-Verstöße. Das verwendet einen Desktop-Edge mit mobiler Ansicht/Browserkennung und synthetische Medien, keinen physischen Android-Dateianbieter. Die tatsächliche Behebung des Android-Schließhängers ist weiterhin am Gerät zu bestätigen.

## Offene Systemabnahme

Die folgenden Nachweise erfordern die tatsächliche Zielumgebung:

- Vier getrennte Rechner und Netze mit paralleler Aufnahme, direktem WebRTC und erzwungenem TURN-Fallback.
- Zwei reale Kameras und zwei Mikrofone je Referenzrechner über 60 Minuten; anschließend zwei Stunden Dauerlast.
- Mindestens 10 GiB Originalmaterial mit nativem Aufnahmeordner, vollständiger Übernahme und unabhängig dekodiertem Videoexport über 4 GiB.
- Harte Browser-/Datenträgerfehler, entzogene Ordnerrechte, volle Datenträger sowie Schlaf- und Sperrzustände.
- Physisch gemessene Audio-/Videolatenz, A/V-Ausrichtung und Drift; RTT ist kein Ersatz dafür.

Die genauen Ziele stehen im [Anforderungsabgleich](acceptance.md) und [Implementierungsplan](implementation-plan.md). Das Studio bleibt experimentell, bis der jeweilige Aufbau diese Abnahme besteht.
