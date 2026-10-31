# Aufnahmeformat, Wiederherstellung und Übernahme

**Dateivertrag v1, implementierter Kern.** Die folgenden Regeln konkretisieren die Aufzeichnungssicherheit. Den Stand der praktischen Nachweise beschreibt [verification.md](verification.md). Die Laufzeitschemata in `packages/protocol/src/index.ts` sind für konkrete Feldnamen maßgeblich.

Die erste Implementierung rekonstruiert das Inventar bei jeder Archivprüfung direkt aus Dateien und Belegen; Fertige Exporte speichern zusätzlich ein Inventar und Prüfsummen in metadata/<participantId>.archive.json, damit Originalsegmente nach erfolgreicher Zuordnung entfernt werden können. Ein Neustart beginnt eine neue Aufnahme-ID. Geräte werden während einer Aufnahme nicht automatisch wiederangebunden; die bisherige Spur bleibt als Teilbestand erhalten. Rohdateien ohne gültigen Segmentbeleg werden gemeldet und erhalten, aber nicht automatisch repariert oder als verifiziert exportiert. Videoexport remuxt pro Epoche; WAV wird bei Samplelücken und vor 4 GiB geteilt. `timeline.json` liefert Clock-Abbildungen für nachgelagerten Schnitt, keine automatische Driftkorrektur.

## 1. Speicherort und Identitäten

Jeder Teilnehmer wählt vor der Aufnahme einen lokalen Ordner. Darin liegen alle für Wiederherstellung, Export und P2P-Übernahme benötigten Daten. Die alternative OPFS-Browserablage ist derzeit deaktiviert; ihr bestehender Dateivertrag unter `localtake-recordings` bleibt für vorhandene Bestände erhalten. Die UI setzt keinen zentralen Serverkatalog voraus. Browserdaten unterliegen Quoten und dem Löschen von Websitedaten.

```text
<gewaehlter-ordner>/
  temp/<recordingId>/<participantId>/  # Prüfaufnahmen, Aufräumen wird versucht
  local/<recordingId>/session.json     # Nur beim Host: Teilnehmer dieser Sitzung
  local/<recordingId>/<participantId>/ # Ausstehende Originale, höchstens 7 Tage
    recording.json
    tracks/
      <trackId>/
        track.json
        <epochId>/
          epoch.json
          000000_0000000000us.mp4
          000000_0000000000us.segment.json
          000001_0002000000us.mp4
          000001_0002000000us.segment.json
      <audioTrackId>/
        track.json
        <epochId>/
          epoch.json
          000000_0000000000us.wav
          000000_0000000000us.segment.json
    events/                # Unveränderliche Ereignisbatches, z. B. Mute und Fehler
    clocks/                # Unveränderliche Messbatches und Zeitabbildungen
    completion.json        # Erst nach regulärem Abschluss des Teilnehmers
    metadata/transfers/    # Empfangsbestätigungen: Ziel-PC und Inventar-Hash
  <Raumname>/Aufnahme-<JJJJ-MM-TT_hh-mm-ss>-<recordingId-kurz>/
    <Teilnehmer>-video-<IDs>.mp4         # Alle Host- und Gastspuren direkt hier
    <Teilnehmer>-audio-<IDs>-001.wav
    metadata/
      session.json                     # Dateikatalog und fehlende Teilnehmer
      participants.json                # Hostmanifest für Wiederöffnung
      <participantId>.timeline.json
      <participantId>.export.json       # Größe und SHA-256 je 16-MiB-Block
      <participantId>.archive.json      # Inventar und Belege im Cutter-Ordner
      <participantId>-<Pfadhash>-*.json  # Alle ursprünglichen Metadatendateien
      <participantId>.transfer.json     # Beim Gast: bestätigter Masterempfang
```

Eine **Sitzung** ist ein Take: alles von „Aufnehmen“ bis „Stoppen“ in einem Raum, gemeinsam identifiziert durch die `recordingId`. Der Host schreibt dazu `session.json` (`sessionManifestSchema`: Startzeit, Raum, Teilnehmer mit Rolle sowie Endzustand und Bytezahl ihrer Aufnahme). Die Datei ist regenerierbare Übersicht, kein Beleg: Sie hält Teilnehmer sichtbar, deren Originale noch nicht angekommen sind, und ersetzt keine Teilnehmerordner. Der Sitzungsordner `<Raumname>/Aufnahme-…` enthält genau einen Take; sein `metadata/session.json` hat `formatVersion: 3` mit `sessionId` = `recordingId`. Ältere Exporte mit `formatVersion: 1` fassten noch einen ganzen Raum zusammen.

Die Zahlen sind illustrative Startzeiten. Kamera- und Audiosegmente müssen nicht exakt an derselben Mikrosekunde beginnen. Dateinamen tragen Sequenz und lokale Medienstartzeit; `epoch.json` beschreibt ihre Zeitbasis und enthält genügend Metadaten zur Rekonstruktion. Eine Epoche ändert sich bei Gerätewiederanbindung, Encoder-Neukonfiguration oder neuer Browser-Zeitbasis.

`track.json` beschreibt Quellentyp, lesbaren Namen, Track-ID und Kanalzuordnung. `epoch.json` enthält tatsächliches Aufnahmeprofil, Codec-/Containerparameter, Zeiteinheiten und Clock-Zuordnung. Metadaten werden vor dem ersten Mediensegment geschrieben und geschlossen. Neue Versionen erhalten neue IDs; alte werden nicht überschrieben.

Ordnerhandles können in IndexedDB gemerkt werden. Ein erneut ausgewählter Aufnahmeordner bleibt aber auch ohne diesen Komfortzustand auswertbar.

Ein frischer Besucher mit Einladungslink sieht zuerst einen eigenen Namens-/Beitrittsdialog, auch auf kleinen Bildschirmen mit geschlossenem Einrichtungsmenü. Danach wird der native Aufnahmeordner freigegeben. Der Raumbeitritt setzt keine erfolgreiche Schreibprüfung voraus; Aufnahmebereitschaft und Dateiempfang bleiben bis zur erfolgreichen Speicher-/Quellenprüfung gesperrt. Eine gespeicherte Teilnehmeridentität wird beim Wiederöffnen weiterverwendet. Auch das Prüfen eines gespeicherten Ordners zeigt seinen Fortschritt im Dialog.

Die Schreibprüfung zeigt Ordneranlage, Dateisperre, Schreiben, Schließen, Rücklesen und Aufräumen getrennt mit der Laufzeit des aktuellen Schritts an. Zwei Schreib-/Lesetests prüfen den Segmentbelegpfad und den längeren Übertragungsbelegpfad; die Anzeige unterscheidet Test 1/2 und 2/2. Jeder einzelne Hintergrundaufruf hat 15 Sekunden Zeit; für den Schreib-/Leseteil gelten höchstens 90 Sekunden. Vorherige Ordneroperationen verbrauchen dadurch nicht das Zeitbudget eines späteren Schließaufrufs. Das anschließende optionale Aufräumen bekommt separat höchstens 15 Sekunden. Einzel- und Gesamtdauern stehen im Diagnosebericht. Gespeicherte Ordnerwahl und nichtinteraktive Berechtigungsabfragen sind auf drei Sekunden begrenzt. Das Merken ist optional: Scheitert es, bleibt ein erfolgreich schreib-/lesegeprüfter Ordner für den aktuellen Besuch nutzbar. Native Auswahl- und Berechtigungsdialoge bleiben ohne Zeitlimit unter Kontrolle des Benutzers. Verspätete Antworten einer abgebrochenen Prüfung aktivieren keine Ablage; nur der eigene, eindeutig benannte Prüfbestand wird aufgeräumt.

Schreiben, Schließen und Rücklesen mit Größen- und Hashvergleich müssen vollständig bestehen. Ein anschließend fehlgeschlagenes oder nicht antwortendes Entfernen der Testdateien erzeugt eine eigene sichtbare Warnung und sperrt den Ordner nicht. Ein Fehler beim Schreiben/Lesen wird sofort zurückgegeben und kann nicht durch einen weiteren Aufräumfehler verdeckt werden. Auch das Entfernen einer abgeschlossenen Kamera-/Mikrofon-Prüfaufnahme ist auf 15 Sekunden begrenzt und verändert kein erfolgreiches Prüfergebnis.

Nach einem Aufräumfehler teilen alle Ablagen derselben Ordnerfreigabe diesen Zustand: Weitere automatische Löschversuche, einschließlich der siebentägigen Bereinigung und des Entfernens bereits gesicherter Originale, sind bis zur nächsten Ordnerfreigabe bzw. zum nächsten Seitenbesuch pausiert. Ein verifizierter Export oder quittierter Transfer kann trotzdem abschließen; die lokalen Originale bleiben zusätzlich erhalten. Regelmäßige Gerätechecks und automatische Wiederholungen derselben Konfiguration werden pausiert, damit keine laufend neuen sechssekündigen Prüfaufnahmen entstehen. Nach einer Änderung oder einem neuen Take kann erneut geprüft werden. Die Warnung weist auf manuelles Aufräumen und erhaltene Testdaten unter `temp` hin. Damit ist keine funktionierende Löschberechtigung zugesichert.

Auf Android ist automatisches Aufräumen vorläufig von Anfang an pausiert, ohne einen nativen Löschaufruf auszulösen. Das ist ein vorsichtiger Workaround für gemeldete nicht antwortende Löschaufrufe und anschließende erneute Hänger beim Dateiabschluss; die konkrete Ursache im Android-Dateianbieter ist nicht nachgewiesen. Native Aufnahmeordner bleiben die Produktionsablage. Schreibprüfung und echte Medienprüfung bleiben erforderlich. Testdaten und quittierte Originale bleiben lokal; Originale erst nach bestätigter Übernahme manuell entfernen. Die siebentägige automatische Bereinigung gilt während dieser Pause nicht.

Ein JavaScript-Zeitlimit kann die zugrunde liegende native Browseroperation nicht zuverlässig abbrechen. Nach einer fehlgeschlagenen Prüfung wartet die optionale Bereinigung deshalb zunächst auf tatsächlich beendete Dateioperationen. Die Pfadprüfung entfernt ausschließlich ihre bekannten Einträge von den Dateien bis zu den leeren Elternordnern, ohne rekursives `removeEntry`. Fremde Inhalte im Prüfpfad bleiben erhalten. Auch das Entfernen einer eigenen Medien-Prüfaufnahme erfolgt von unten nach oben und beendet weitere Löschaufrufe, sobald das Zeitbudget abgebrochen wurde. Ein weiterhin nicht beantwortetes Schließen bleibt ein blockierender Fehler; ein Browserneustart ist keine zugesicherte Behebung.

### Netzunterbrechung und Neuladen

Der Produktionsclient enthält den Recorder-Worker direkt im geladenen Anwendungsbundle und lädt den Exportcode mit der Anwendung. Neue Gerätechecks und Aufnahmen benötigen dadurch keine später entfernte Worker-/Exportdatei einer älteren Serverversion. Ein Deployment lädt einen bereits laufenden Tab nicht automatisch neu. Ein zuvor geöffneter Client aus der Zeit vor dieser Korrektur benötigt einmaliges Neuladen, um dieses Verhalten zu übernehmen.

- **Netzverlust:** Die lokale Aufnahme hängt nicht von WSS oder WebRTC ab und läuft weiter, solange Tab, Geräte und Dateizugriff aktiv bleiben. Signalisierung verbindet sich mit begrenzter Rückoffzeit automatisch erneut; Live-/Dateikanäle werden wieder aufgebaut. Ein Host-Stopp kann einen getrennten Teilnehmer erst nach Wiederverbindung erreichen. Bei längerem Ausfall kann dieser lokal stoppen.
- **Neuladen während Aufnahme:** Die Encoder-/Capture-Instanzen dieses Tabs enden. **Ein Reload garantiert keinen regulären Abschluss des offenen Segments.** Bereits abgeschlossene und quittierte Segmente bleiben erhalten, ein noch ungesicherter Schluss kann verloren gehen. Ein neuer Tab ohne eigenen Recorder meldet einen zuvor laufenden Status als `partial`, damit der Host beim gemeinsamen Stopp nicht auf einen beendeten Recorder wartet. Die ursprüngliche Ablage kann beim Wiederöffnen auch während des laufenden Takes wieder freigegeben werden; ein Wechsel einer bereits aktiven Ablage bleibt gesperrt. Ohne gültigen Abschlussbeleg wird der Bestand als unvollständig erkannt. Die laufende Aufnahme wird nach einem Reload nicht automatisch unter derselben ID weitergeführt; für weitere gemeinsame Aufnahme einen neuen Take starten.
- **Neuladen während Übertragung:** Denselben Raum mit gespeicherter Teilnehmeridentität im selben Browserprofil öffnen und denselben Ordner erneut freigeben. Sender und Host müssen gleichzeitig verfügbar sein. Inventar, Prüfsummen und Empfangsbelege vermeiden das erneute Senden bestätigter Segmente; ein nur teilweise empfangenes Segment wird vollständig wiederholt.

Diese Wiederübernahme gilt auch für einen unterbrochenen Take ohne `completion.json`: Nur verifizierte Segmente werden gesendet, der Bestand bleibt als unvollständig gekennzeichnet. Spur-/Epochenmetadaten, Segmentbelege mit Medienzeiten und Audio-Samplepositionen sowie gespeicherte Clock-Abbildungen gehören zur Übertragung. Der Export legt die erhaltenen Zeitinformationen unter `metadata/<participantId>.timeline.json` und den kopierten Originalmetadaten ab. Die Dateien beginnen jeweils bei Null; ein gewöhnlicher Import in ein Schnittprogramm platziert sie nicht automatisch auf einer gemeinsamen Timeline. Eingangs-/Kameralatenz ist nicht kalibriert, Driftkorrektur und ein automatischer Schnittprogramm-Import sind nicht implementiert. Gespeicherte Clock-Ungewissheit und tatsächliche Aufzeichnungslücken bleiben maßgeblich. Beim Wiederöffnen denselben Browser und dasselbe Profil mit der gespeicherten Teilnehmeridentität verwenden; parallele Raumtabs derselben Identität vermeiden.

Gespeicherte Clock-Abbildungen beziehen sich auf die angegebene Serverepoche. Die interne Zeitfortsetzung eines Tabs über einen Koordinatorneustart wird vom gespeicherten Offset abgezogen, damit ein weiter geöffneter und ein frisch geöffneter Tab dieselbe Serverreferenz beschreiben. Diese Korrektur gilt für neu geschriebene Metadaten; vorhandene Dateien werden dadurch nicht rückwirkend umgeschrieben.

Browser- oder Betriebssystem-Suspendierung ist von einem reinen Netzausfall zu unterscheiden: Auf Mobilgeräten können Hintergrundseiten angehalten oder beendet werden. Die Seite für Aufnahmen im Vordergrund und das Gerät wach halten; ein Wake Lock ist keine Garantie gegen einen Prozessabbruch. Siehe [Chromium Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

## 2. Vollständige kurze Dateien

### Video

Zieldauer eines Segments: etwa **2 Sekunden**. Der Capture-Stream und der Encoder laufen kontinuierlich. Am vorgesehenen Übergang wird ein Keyframe angefordert; erst ein tatsächlich als unabhängig dekodierbar erkannter Paketanfang eröffnet das nächste Segment. Das vorherige Segment enthält alle davorliegenden vollständigen Frames. Ein Stop finalisiert auch ein kürzeres letztes Segment.

Jedes MP4-Segment enthält seine eigenen erforderlichen Container- und Codecinformationen. Seine internen Zeitstempel beginnen lokal bei null; die Abbildung auf die Aufnahmezeit steht im Segmentbeleg. Ein Encoderwechsel erzeugt eine neue Epoche. Der Recorder beginnt nicht jede zweite Sekunde mit einem neuen `getUserMedia()` oder einem Stop/Start des Encoders.

Ein Muxer schreibt eine vollständige kleine Datei und finalisiert sie vor der Speicherbestätigung. Bei einem Stream-Target müssen Bytepositionen berücksichtigt werden; ein Muxer kann frühere Headerbereiche nachträglich ändern. Einfaches Aneinanderhängen beliebiger ausgegebener Puffer ist dann falsch. [Mediabunny: Writing media files](https://mediabunny.dev/guide/writing-media-files)

Decoder-Reihenfolge, Zeitstempel und Keyframe-Verhalten des gewählten H.264-Profils sind Abnahmekriterien. Der erste Vorversuch wählt ein Profil ohne ungeprüfte Frame-Umsortierung. Wird die Segmentfrist nicht eingehalten, meldet die Anwendung den wachsenden ungesicherten Abschnitt. Es gibt keinen stillen Wechsel zu einer weniger sicheren Aufnahmevariante.

### Audio

Vor dem Anbinden der Aufnahmequellen prüft ein stummer AudioWorklet 100 ms zusammenhängende Renderzeit. Ein Zeitsprung setzt dieses Bereitschaftsintervall zurück; nach drei Sekunden ohne Bereitschaft scheitert die Vorbereitung sichtbar. Dieser Vorlauf gehört zur Initialisierung, nicht zu den aufgenommenen Samples. Die Zeitanker der eigentlichen Spuren werden danach bestimmt.

Jeder `process()`-Aufruf liefert einen neuen Renderblock. Ein wiederholter oder rückläufiger `currentFrame` ist kein Beweis für doppelte PCM-Samples: Chromium kann die Aktualisierung dieses globalen Zeitstempels bei belegtem Graph-Lock auslassen. Der Recorder erhält alle gelieferten Samples und zählt mit der tatsächlichen Renderblockgröße monoton weiter, bis die Browserzeitbasis wieder aufgeholt hat. Ein Vorwärtssprung über diesen Zähler hinaus erzeugt weiterhin eine explizite Lücke und getrennte WAV-Abschnitte. Liegt die Browserzeitbasis mehr als eine Sekunde zurück, stoppt die Spur mit erhaltenen Segmenten; hat sie beim Stopp noch nicht aufgeholt, erscheint ein Synchronisationshinweis.

Das Ereignis `audio-timing` unterscheidet `gaps` und defensiv ausgelassene `overlaps` von `clockCorrections`. Letzteres zählt Renderaufrufe mit korrigierter Zeitbasis, ohne PCM zu entfernen. `maxClockLagFrames` nennt den maximalen Rückstand, `unrecoveredClockLagFrames` den Rest beim Stopp. `firstCorrectedSample` und `lastCorrectedSample` sind Positionen relativ zum Beginn der Spur. Ein vollständig aufgeholter Zeitstempel erzeugt allein keine Warnung über fehlende Audiosamples. Diese Korrektur kalibriert keine Mikrofon-/Kameralatenz und stellt bereits verlorene Samples älterer Aufnahmen nicht wieder her. Timinghinweise stehen getrennt von beschädigten/unvollständigen Speicherbeständen in den Metadaten.

Separate WAV-Dateien je Mikrofonspur, ebenfalls etwa 2 Sekunden lang. Gespeichert wird PCM Float32 in der tatsächlich verwendeten Sample-Rate und Kanalzahl. Der Segmentbeleg trägt den absoluten ersten Sampleindex dieser Spur und die Sampleanzahl; aufeinanderfolgende Segmente müssen ohne fehlende oder doppelte Samples anschließen, außer eine explizite Lücke ist dokumentiert.

WAV-Segmente bleiben klein. Beim Export langer Spuren muss die RIFF-Größengrenze berücksichtigt werden: vor 4 GiB in mehrere zusammengehörige WAV-Dateien teilen; RF64 ist eine spätere Option. Eine stundenlange Aufnahme wird niemals vollständig in einen Browser-Blob geladen.

### Begrenzter Arbeitsspeicher

Encoder-, Audio- und Schreibwarteschlangen erhalten feste Obergrenzen und sichtbare Laufzeitmetriken. Je Spur dürfen höchstens das offene Segment und ein begrenzter Schreibpuffer ausstehen. Der Starttest muss zusätzlich ein absolutes Bytebudget festlegen. Bei Überschreitung wird nicht unbegrenzt RAM nachgekauft: Der Recorder meldet den Fehler, verwirft keinen Bestand und beendet nötigenfalls die betroffene Spur kontrolliert.

## 3. Wann ein Segment als gesichert zählt

Ein vom Browser erzeugter Frame, ein Muxer-Callback und ein erfolgreiches `write()` sind noch kein Speicherbeleg. Bei der File System Access API werden Änderungen erst mit dem Schließen des Schreibstreams übernommen. [Chrome: File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)

Vorgesehene Reihenfolge pro Segment:

1. Container vollständig finalisieren; Sequenz, Zeitspanne und erwartete Bytezahl bestimmen.
2. Medien unter einem neuen, eindeutigen Namen schreiben und den Stream erfolgreich schließen.
3. Datei zurücklesen, Größe prüfen und SHA-256 über die geschriebenen Bytes bilden; mit dem beim Schreiben ermittelten Hash vergleichen. Bei vorübergehend ungültigem File-Snapshot wird mit neuem Handle/File bis zu dreimal nach 25/75/200 ms erneut gelesen; dies erlaubt kein Überschreiben bestehender Originale.
4. Alle referenzierten Spur-/Clock-Metadaten sowie den Segmentbeleg einschließlich Zeitdaten, Bytezahl und Hash schreiben und schließen.
5. Erst jetzt den Zähler „lokal gesichert“ erhöhen und das Segment für eine Übernahme freigeben.

Ein Snapshot des Gesamtinventars ist nur ein Beschleuniger. Medien, Spurmetadaten und Segmentbelege sind die wiederherstellbare Grundlage. Ein defekter letzter Snapshot darf den Bestand nicht unzugänglich machen. Der Readback kostet zusätzliche Datenträgerbandbreite und wird im Mehrquellen-Lasttest mitgemessen.

**Verlustfenster:** Ziel im freigegebenen Normalprofil sind etwa 2 Sekunden offenes Material zuzüglich einer kurzen Schreib-/Prüfzeit. Mehr als 4 Sekunden unbestätigte Medienzeit pro laufender Spur sind ein Fehlerzustand. Diese Werte sind zu messende Ziele, keine Garantie bei Betriebssystemstillstand, Stromverlust oder Defekten. `close()` und Readback ersetzen keine physische Garantie des Datenträgers.

Ein Browserabbruch kann das offene Segment sowie noch nicht abgeschlossene Schreibvorgänge verlieren. Bereits bestätigte Segmente müssen nach Wiederöffnung vollständig dekodierbar sein. Die UI zeigt daher stets getrennt aufgenommene und bestätigte Dauer an.

## 4. Inhalt eines Segmentbelegs

| Feld                                                 | Bedeutung                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `formatVersion`                                      | Version dieses lokalen Datenvertrags                                      |
| `recordingId`, `participantId`, `trackId`, `epochId` | Eindeutige Zuordnung                                                      |
| `sequence`, `fileName`, `byteLength`, `sha256`       | Inventar und Integritätsprüfung                                           |
| `mediaStartUs`, `mediaDurationUs`                    | Lokale Medienzeit innerhalb der beschriebenen Epoche; ganze Mikrosekunden |
| `sampleStart`, `sampleCount`, `sampleRate`           | Bei Audio: maßgebliche Samplepositionen                                   |
| `frameCount`, `firstFrameIsKey`                      | Bei Video: Zähler und geprüfter Segmentanfang                             |
| `clockMappingId`                                     | Zugehörige Abbildung auf die gemeinsame Aufnahmezeit                      |
| `settingsRef`                                        | Unveränderliche Parameter dieser Spur-Epoche                              |
| `gaps`, `events`                                     | Fehler, Mute-/Schwarzbereiche, fehlende Medienzeit                        |

Das vollständige Typ-/Validierungsschema entsteht im Vorversuch zusammen mit realen Testdateien. Große Zähler werden als sichere Integer oder dezimale Strings mit ausdrücklich festgelegter Darstellung gespeichert. Hashes beziehen sich auf die fertigen Dateibytes, nicht auf dekodierte Frames.

## 5. Recovery

Beim Öffnen eines vorhandenen Ordners:

1. Metadatenversionen prüfen und Tracks/Epochen erfassen.
2. Segmentbelege lesen und referenzierte Dateien gegen Größe und Hash prüfen.
3. Fehlende Sequenzen, Zeitlücken und fehlenden regulären Abschluss sichtbar markieren.
4. Dateien ohne Beleg als **unbestätigt** behandeln. Sie dürfen nach vollständiger Container-/Decodierprüfung und rekonstruierbaren Zeitdaten gerettet werden; sonst bleiben sie als unklarer Bestand erhalten.
5. Ein neues Inventar erzeugen. Alte Dateien und Metadaten werden nicht automatisch gelöscht oder ersetzt.

Fehlt nur `completion.json`, lautet das Ergebnis „abgebrochene Aufnahme mit geretteten Spuren“, nicht „keine Aufnahme“. Ein gesicherter Teilbestand darf unabhängig von defekten Folgesegmenten exportiert werden. Fehlende Intervalle bleiben in `timeline.json` erkennbar.

## 6. P2P-Übernahme

Der Host ist der Sammler. Jeder Gast bietet seine Aufnahmen aus dem aktuellen Raum nach dem Stopp automatisch an; der Host nimmt Angebote nur vom jeweiligen Aufnahmeeigentümer aus diesem Raum an. Eine manuelle Einzel-Freigabe gibt es nicht mehr. Lokale Originalsegmente bleiben bis zur bestätigten Übernahme beziehungsweise zum verifizierten Export erhalten und werden dann bereinigt. Auch unvollständige lokale Teilbestände werden nach sieben Tagen bereinigt, sobald die Anwendung mit freigegebenem Ordner läuft; fertige Exporte bleiben erhalten.

Ein zuverlässiger, geordneter RTCDataChannel transportiert die Dateiblöcke. Ein zweiter kleiner Kanal führt Inventar- und Kontrollnachrichten. Die vorhandene Peer-Verbindung wird genutzt, sobald die Aufnahme/Liveunterhaltung die Übernahme zulässt. DataChannels übertragen beliebige Anwendungsdaten zwischen Browsern. [WebRTC: Data channels](https://webrtc.org/getting-started/data-channels)

Vorgesehener Ablauf:

```text
Eigentuemer -> Sammler: OFFER (freigegebene Aufnahme, Inventar, Version)
Sammler -> Eigentuemer: WANT (fehlende oder beschaedigte Segment-IDs)
Eigentuemer -> Sammler: BEGIN, DATA*, END (ein Segment)
Sammler: Datei schliessen, zuruecklesen, Hash pruefen, Beleg speichern
Sammler -> Eigentuemer: STORED (Segment-ID, Bytezahl, SHA-256)
... wiederholen ...
Sammler: erwartetes Inventar vollstaendig vergleichen
Sammler -> Eigentuemer: COMPLETE (Inventarversion und vollstaendige Bestaetigung)
```

`send()` oder ein leeres Sendepuffer ist keine Empfangsbestätigung. `STORED` erfolgt erst nach lokalem Commit beim Sammler. Ein verlorenes ACK führt höchstens zu einer erneuten Inventarprüfung oder identischen Kopie; gleiche IDs mit anderem Hash gelten als Konflikt und überschreiben nichts.

Eine DataChannel-Nachricht enthält zunächst höchstens 16 KiB einschließlich Protokollheader, zusätzlich begrenzt durch die ausgehandelte maximale Nachrichtengröße. `bufferedAmount`/`bufferedamountlow` und ein begrenztes Sendefenster verhindern einen unbeschränkten Stau. Nur ein Segment und zunächst nur ein Sender werden beim Sammler gleichzeitig übertragen. Niedrigere Latenz wird durch Pausieren des Transfers geschützt, nicht durch Annahmen über eine verlässlich niedrige Netzpriorität des Kanals.

Nach Abbruch vergleichen beide Seiten erneut ihr dauerhaftes Inventar. Bereits bestätigte Segmente entfallen; ein teilweise empfangenes Segment wird vollständig erneut übertragen. Wiederaufnahme innerhalb eines Segments ist für den MVP unnötig. Das begrenzt Protokollaufwand und Wiederholungsmenge.

Sender und Empfänger müssen gleichzeitig online sein und die betreffenden Ordner wieder freigeben können. Zur automatischen Wiederaufnahme öffnen beide denselben Raum mit ihren gespeicherten Teilnehmeridentitäten. Die Übernahme ist an Raum, Eigentümer und Host gebunden und benötigt keine noch lebende alte Peer-Verbindung.

## 7. Export und zeitliche Ausrichtung

Das ursprüngliche Segmentpaket kann unmittelbar kopiert und gesichert werden. Der reguläre Export erstellt zusätzlich:

- Eine Video-MP4 je Kameraspur und kompatibler Epoche, möglichst durch Remuxing ohne Neukodierung.
- Eine oder mehrere zusammengehörige WAV-Dateien je Mikrofonspur.
- `timeline.json` mit Startversätzen, Clock-Abbildungen, Drift, Mute-Intervallen, Lücken und Unsicherheit.
- Einen Vollständigkeitsbericht pro Teilnehmer und Quelle.

Bei veränderten Codecs, Auflösungen oder anderen inkompatiblen Parametern entstehen separate Dateien mit klarer Zuordnung. MP4- oder WAV-Dateien werden nicht durch binäre Dateikonkatenation „zusammengefügt“. Das Zusammenführen erfolgt mit Containerkenntnis und begrenztem Speicherbedarf. Die Ausgangssegmente bleiben unverändert.

Eine gemeinsame Zeitachse im Metadatenexport bedeutet noch keine fertig gemischte, framegenau ausgerichtete Multicam-Datei. Automatisches Nachkorrigieren, Schnittprojekt-Export und ein fertiger Programmmix sind spätere Erweiterungen. Für den MVP müssen Originalspuren vollständig downloadbar und ihre gemessenen zeitlichen Beziehungen nachvollziehbar sein.

## 8. Größenordnung

Dezimale Näherungswerte, ohne Containeroverhead:

```text
Video: GB pro Stunde = Mbit/s × 0,45
Audio: Byte/s        = Sample-Rate × Kanaele × Byte je Sample
Transferzeit         = Gesamtbits / nutzbarer Uebertragungsrate
```

Zwei Kameras mit je 50 Mbit/s ergeben etwa 45 GB/h. Zwei Mono-Mikrofone mit 48 kHz Float32 addieren etwa 1,38 GB/h. Mit 20 % Reserve sind rund **56 GB pro Stunde und Teilnehmer** zu planen. Auf einem nutzbaren Upload von 20 Mbit/s braucht diese Stunde Originalmaterial theoretisch etwa **5,2 Stunden** zur Übernahme, praktisch länger.

Diese Kosten entstehen durch die Originalqualität. Die Anwendung zeigt Restmenge und Fortschritt an und erlaubt eine spätere Fortsetzung; sie verspricht keinen sofortigen Download mehrstündiger Mehrkamera-Aufnahmen.
