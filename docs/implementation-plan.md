# Umsetzung und Abnahme

Stand 26.09.2026: Die Kernfunktionen aller vier Meilensteine sind implementiert. Automatisierte Tests und synthetische Browserläufe wurden ausgeführt; die unten geforderten realen Hardware-, Netzwerk- und Dauertests sind noch offen. Deshalb sind die Meilensteine noch nicht vollständig abgenommen. Tatsächliche Nachweise und beobachtete Einschränkungen stehen in [verification.md](verification.md).

## 1. Vorversuche vor der Studiooberfläche

Die Browsergrenzen sind das größte Projektrisiko. Deshalb werden zuerst kleine, wegwerfbare UI-Hüllen um den später weiterverwendbaren Medienkern gebaut.

| Vorversuch | Aufbau | Entscheidungskriterium |
| --- | --- | --- |
| Mehrquellenaufnahme | Zwei unterschiedliche Kameras und zwei Mikrofone auf einem Zielrechner gleichzeitig öffnen | Jede Quelle liefert eine identifizierbare eigene Spur; gewünschte und echte Parameter sind sichtbar |
| Segmentierung | Kontinuierlicher Encoder, kurze vollständige MP4-/WAV-Segmente | Jedes bestätigte Segment allein dekodierbar; keine durch Segmentwechsel erzeugten Frame-/Samplelücken |
| Absturz/Recovery | Browserprozess während Aufnahme hart beenden, anschließend Ordner erneut wählen | Alle vorher bestätigten Segmente lesbar und hashidentisch; fehlender Abschluss und Tail-Verlust korrekt ausgewiesen |
| Gleichzeitiger Livecall | Vier Rechner, jeweils Mehrquellenaufnahme, eine Livekamera und Audio; zusätzlich ein Bildschirmtrack | Aufnahmeprofil bleibt erhalten; begrenzte Warteschlangen; Liveziele erreichbar |
| Echte Zeitmessung | Definiertes Licht-/Audioereignis, lange Aufnahme und Referenzmessung | A/V-Versatz, Timestamp-Zuordnung und Drift messbar; keine angenommene Samplegenauigkeit |
| NAT/TURN | Getrennte Netze, erzwungener Relay-Pfad, außerdem UDP-Sperre | Call und spätere Übernahme über TURN möglich; Fehler bei nicht erreichbarem Relay verständlich |

H.264/WebCodecs und Mediabunny werden erst nach diesem Nachweis als geprüfte Kombination festgeschrieben. Fehlt auf der Zielhardware ein tragfähiges Profil, wird das Profil oder die Architektur ausdrücklich angepasst; es gibt keinen stillen Rückfall auf einen Recorder mit schlechterem Recovery-Verhalten.

## 2. Meilensteine

### M0 – Recorder und Dateivertrag beweisen

- Npm-Workspace und minimalen Chrome-Testclient aufsetzen.
- Geräteauswahl, AudioWorklet, Videoencoder, Muxer und Segmentwriter implementieren.
- Reale Testdateien mit versioniertem Manifest-/Segmentvertrag erstellen.
- Recovery inklusive defektem Snapshot und unvollständigem letzten Segment nachweisen.
- Freigegebene Browser-/Hardware-/Qualitätskombination dokumentieren.

**Fertig, wenn:** zwei Kameras und zwei Mikrofone mindestens 60 Minuten stabil aufgenommen werden und die zugesicherten Segmente auch nach einem Prozessabbruch wiederherstellbar sind.

### M1 – Raum und latenzarmer Livecall

- Koordinationsdienst, Raumtokens, Vier-Teilnehmer-Grenze und Reconnect implementieren.
- WebRTC-Mesh, Kameraauswahl, Mikrofonmix und Bildschirmfreigabe integrieren.
- STUN/TURN sowie begrenzte, gedämpfte Liveadaption hinzufügen.
- Docker-App und Caddy-/TURN-Betriebsbeispiele erstellen.

**Fertig, wenn:** vier reale Rechner parallel aufnehmen und kommunizieren können; Netz-/Serverausfälle ändern keinen gesunden lokalen Recorderzustand.

### M2 – Verlässlicher Studioablauf

- Geräte-/Schreibpreflight, lokale Freigabe und Host-Start/Stop implementieren.
- Mute-Semantik, Pegel, Quellzustände und gesicherte Dauer pro Teilnehmer anzeigen.
- Partielle Starts, verlorene Stopbefehle, Gerätewechsel und Speicherfehler behandeln.
- Wiederöffnen, Offline-Recovery und kontrollierte Appupdates ergänzen.

**Fertig, wenn:** die Oberfläche nie „alles gesichert“ meldet, solange eine Spur unbestätigt, fehlerhaft oder unvollständig ist; stummgeschaltete Inhalte erscheinen auch in den Originalen nicht.

### M3 – Originale sammeln und exportieren

- Eigentümerfreigabe, Inventarvergleich, DataChannel-Übernahme und Bestätigungsprotokoll implementieren.
- Abbruch und Neustart beider Browser mit anschließender Fortsetzung unterstützen.
- Begrenztes Remuxing, WAV-Ausgabe und `timeline.json` exportieren.

**Fertig, wenn:** ein Teilnehmer die freigegebenen Originalspuren aller anderen vollständig und hashgeprüft erhält; Senderoriginale bleiben erhalten und fehlende Dateien sind erkennbar.

## 3. Messbare Qualitätsziele

Diese Zahlen sind vorläufige Abnahmewerte für ein benanntes Referenzsystem, keine allgemeine Browsergarantie. Referenzhardware, OS, Chrome-Build, Geräte, Aufnahmeeinstellungen und Netzbedingungen werden bei jedem Lauf festgehalten.

| Kriterium | Geplanter Nachweis |
| --- | --- |
| Quellenumfang | 2 Kameras + 2 Mikrofone je Referenzrechner; getrennte, identifizierbare Originalspuren |
| Grundprofil | 1080p30 pro Kamera und 48 kHz Audio, 60 Minuten mit vier Teilnehmern |
| Höheres Profil | 4K30 nur bei bestandenem gleichen Test; freigegebene Quellenzahl explizit nennen |
| Dauerbetrieb | Nach dem Grundtest einmal 2 Stunden für Speicher-, Drift- und Ressourcenverhalten |
| Ressourcen | Keine mit Sitzungsdauer unbeschränkt wachsenden RAM-/Encoder-/Dateiwarteschlangen; Budgets im Vorversuch festlegen |
| Speicherbestätigung | Im Normalbetrieb etwa 2 s Segmentdauer plus kurze Commitzeit; über 4 s unbestätigte Medienzeit wird ein sichtbarer Fehler |
| Verlustverhalten | Alle vor dem Absturz bestätigten Segmente bleiben hashidentisch und dekodierbar; Tail-Verlust wird gemessen und berichtet |
| Segmentkontinuität | Testquelle mit Frame-/Samplezählung zeigt keine durch die Segmentierung erzeugten Lücken oder Duplikate |
| Livevideo | Ziel p95 ≤ 250 ms von Kameraereignis bis Bildanzeige bei regionalem Netz mit RTT ≤ 50 ms und ausreichender Kapazität |
| Liveaudio | Ziel p95 ≤ 150 ms vom Testsignal bis zur Wiedergabe unter denselben Bedingungen |
| Lokale A/V-Ausrichtung | Ziel ≤ 40 ms Restversatz nach dokumentierter Kalibrierung; Start und Ende prüfen, Abweichungen ausweisen |
| Rechnerübergreifende Zeit | Gemessenen Offsetfehler und Drift berichten; bei nicht erreichbarer Genauigkeit Metadaten als unsicher markieren |
| P2P-Integrität | Empfangshashes entsprechen Quelle; erst nach dauerhaftem lokalen Speichern bestätigen |

`getStats()` liefert wichtige Diagnosedaten, aber keinen allein ausreichenden Beweis für die gesamte Kamera-zu-Anzeige- oder Mikrofon-zu-Lautsprecher-Latenz. Dafür werden externe Referenzaufnahme, sichtbare Timer/Lichtimpulse und aufgezeichnete Testsignale verwendet. „Ping halbieren“ ist kein Latenztest des Produkts.

## 4. Gezielte Fehlertests

| Fehler | Erwartung |
| --- | --- |
| WSS-Verbindung trennen / Server neu starten | Recorder läuft; Raum rekonstruiert sich; Start wird nicht doppelt ausgeführt |
| Internet ganz trennen | Lokale Aufnahme bleibt aktiv; fehlende Livepeers sind sichtbar |
| Stopbefehl an einen Client verlieren | Host meldet ausstehende Bestätigung; Client bietet lokalen Stop |
| Kamera oder Mikrofon abziehen | Betroffene Spur zeigt Fehler/Lücke, andere Spuren bleiben intakt |
| Ordnerrechte entziehen / Schreibfehler injizieren | Keine weiteren falschen Speicherbestätigungen; Bestand bleibt lesbar |
| Datenträger füllen / verzögern | Warteschlangen bleiben begrenzt; betroffene Aufnahme wird sichtbar gestoppt |
| Browserprozess in wechselnden Commitphasen beenden | Recovery findet bestätigten Bestand; unklare Dateien werden nicht automatisch als vollständig gewertet |
| Minimieren, Bildschirm sperren, Ruhezustand | Verhalten messen; aussetzende Quellen markieren; keine Aufnahme während echten Systemschlafs behaupten |
| Mute/Kamera aus während hoher Last | Ab dem wirksamen Zeitpunkt kein entsprechender Originalinhalt gespeichert; Zeitachse bleibt erhalten |
| Zweiten Tab für dieselbe Aufnahme öffnen | Exklusiver Schreibbesitz oder klare Ablehnung; keine konkurrierenden Writer |
| Transfer bei beliebigem Block/ACK abbrechen | Inventarvergleich überspringt bestätigte Segmente und wiederholt fehlende; keine doppelten Dateien |
| Segment beschädigen / Hash manipulieren | Konflikt erkennen, kein `COMPLETE`, erneute Übernahme anbieten |
| Große Aufnahme exportieren | Speicher bleibt begrenzt; Video dekodierbar, WAV-Grenze beachtet, alle Lücken dokumentiert |

Sinnvolle automatisierte Tests betreffen Clock-/Protokollvalidierung, idempotente Befehle, Recovery mit beschädigten Dateien und Transferwiederaufnahme. Browserintegration wird mit Playwright geprüft. Reale Mehrkamera-/Mehrmikrofonhardware und tatsächliche Netzbedingungen erfordern ergänzende Systemtests; simulierte Browsergeräte beweisen diese Eigenschaften nicht.

## 5. Bewusst später

- Mehr als vier Teilnehmer und gegebenenfalls ein SFU.
- Freisprechen mit nachweisbar getrenntem AEC-Pfad, zusätzliche Browser und mobile Geräte.
- Liveansichten aller lokalen Kameras gleichzeitig, mehrere parallele Sammler und Transfer während der Aufnahme.
- Automatische Driftkorrektur im Audio, Schnittprojekt-Export, Schnittoberfläche und Programmmix.
- OPFS als alternativer Speicher, zusätzliche Codecs und RF64.

Diese Erweiterungen ändern die ersten Nachweise nicht: lokale Originale dürfen von Livecall und Serververfügbarkeit unabhängig bleiben.
