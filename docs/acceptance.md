# Anforderungsabgleich

LocalTake implementiert ein Browserstudio mit lokaler Mehrquellenaufnahme, Livecall und anschließender Übernahme der Originale. Die automatisierten und synthetischen Nachweise stehen im [Prüfstand](verification.md); eine vollständige Hardware- und Langzeitabnahme bleibt davon getrennt.

| Anforderung                   | Umsetzung                                                                                                       | Verbleibende Prüfung                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop-Browser               | Vue/TypeScript, WebCodecs, AudioWorklet und nativer Aufnahmeordner über File System Access                      | Aktuelle Chrome-/Edge-Version auf der eigenen Hardware prüfen; andere Browser ohne Ordnerfreigabe sind kein unterstützter Aufnahmeweg |
| Selbst gehosteter Koordinator | Fastify, authentifizierte WebSockets, flüchtige Räume, Docker und Caddy                                         | TLS, Origin und Wiederanlauf im eigenen Deployment prüfen                                                                             |
| Gemeinsames Studio            | Raumlink, Gerätecheck, Teilnehmeransicht, Chat, Host-Start/Stop, Archiv und Export                              | Reale Bildschirmfreigabe und Controls mit allen Zielrechnern prüfen                                                                   |
| Mehrere lokale Quellen        | Eigene H.264-MP4-/PCM-WAV-Spuren, kurze abgeschlossene Segmente, Prüfsummen                                     | Zwei reale Kameras und zwei Mikrofone über mindestens 60 Minuten                                                                      |
| Livecall mit 2–4 Teilnehmern  | WebRTC-Mesh, separate Liveparameter, Kameratrack, Mikrofonmix und Bildschirmtrack                               | Vier reale Rechner, getrennte Netze, direkte und erzwungene Relay-Verbindungen, physische Latenzmessung                               |
| Mute und Kamera aus           | Wirken im Livekanal und auf die Originale; Bildschirm separat                                                   | Reale Geräte und Betriebssystemauswahl prüfen                                                                                         |
| Wiederherstellung             | Bestätigte Segmente, sichtbare Teilbestände, Ordnerprüfung und fortsetzbare Übernahme                           | Harter Prozessabbruch und native Dateisystemfehler im Zielaufbau                                                                      |
| Ausgabe für den Schnitt       | MP4-Remuxing ohne Neukodierung, WAV mit Teilung bei Lücken/Formatgrenzen, Metadaten und alle Teilnehmer je Take | Große Exporte mit unabhängigem Decoder prüfen                                                                                         |
| Begrenzte Diagnose            | Optionaler authentifizierter Versand, doppelte Secret-Filterung, Rotation und Größenlimits                      | Eigene Aufbewahrung und Zugriff auf Diagnosevolume konfigurieren                                                                      |

## Offene Abnahmegates

- **Recorder:** Zwei Kameras und zwei Mikrofone je Referenzrechner über mindestens 60 Minuten; nach hartem Prozessabbruch alle bestätigten Segmente im nativen Ordner wiederherstellen.
- **Große Bestände:** Mindestens 10 GiB Originalmaterial sichern, vollständig hashprüfen, übertragen und exportieren; MP4 über 4 GiB unabhängig dekodieren und WAV-Teilung an der RIFF-Grenze prüfen. Medien-RAM darf nicht proportional zur Takegröße wachsen.
- **Vier Teilnehmer:** Vier reale Rechner mit paralleler Aufnahme und Unterhaltung; direkte Routen, erzwungenes TURN, UDP-Sperre und Wiederverbindung prüfen.
- **Fehlerverhalten:** Geräteentzug, volle/langsame Datenträger, verlorene Stopbefehle, Tab-/Prozessende und entzogene Ordnerrechte müssen sichtbar bleiben.
- **Zeit und Qualität:** 1080p30 als Grundprofil, anschließend zwei Stunden Dauerlast; 4K separat prüfen. A/V-Versatz, Drift und Ende-zu-Ende-Latenz physisch messen.
- **Übernahme:** Beide Browser zwischenzeitlich schließen, anschließend mit freigegebenen Ordnern fortsetzen und Frames, Samples und Hashes unabhängig vergleichen.

Diese Gates beziehen sich auf den jeweiligen Rechner- und Netzaufbau. Kurze synthetische Tests und Modell-Dateisysteme ersetzen sie nicht. Fertige Exporte bleiben erhalten; noch ausstehende lokale Teilbestände rechtzeitig sichern, da die Anwendung sie nach sieben Tagen bereinigt.
