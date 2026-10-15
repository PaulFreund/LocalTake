# Betrieb mit Docker, Caddy und TURN

Voraussetzungen sind ein Linux-Host mit Docker Engine und Compose v2, eine eigene Domain und passende Firewallfreigaben. Die Beispiele enthalten ausschließlich Platzhalter; echte Domains, Schlüssel und Betriebsprotokolle bleiben außerhalb von Git.

## Anwendung und HTTPS

Im Verzeichnis `deploy` eine `.env` aus `.env.example` anlegen. `DOMAIN` ist der eigene DNS-Name ohne Protokoll. `ROOM_SIGNING_SECRET` und bei TURN-Nutzung `TURN_SHARED_SECRET` durch **zwei unabhängige Zufallswerte** ersetzen, etwa aus `openssl rand -hex 32`. Beispielwerte werden vom Server abgelehnt. Eine bestehende `.env` behalten; den Signaturschlüssel für wiederkehrende Raumzugänge dauerhaft sichern.

```sh
cd deploy
cp .env.example .env
# Domain und Schlüssel in .env eintragen.
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml up -d --build
docker compose logs --tail=100 app caddy
```

Caddy benötigt TCP 80/443 und optional UDP 443. Der App-Port 3000 ist nur im Container-Netz erreichbar. `PUBLIC_ORIGIN` wird aus `DOMAIN` gebildet und muss dem tatsächlichen Browser-Origin entsprechen. Die Anwendung speichert keine Medien auf dem Server; Originale liegen auf den Rechnern der Teilnehmer.

Die App läuft als Benutzer `node`, mit schreibgeschütztem Dateisystem, ohne Linux-Capabilities und ohne Medienvolume. `GET /healthz` ist der Healthcheck. Caddy persistiert Zertifikate und Konfiguration. Die Compose-Vorlage aktiviert außerdem begrenzte Serverdiagnosen in einem eigenen Volume; zum Abschalten `TELEMETRY_DIR` aus der App-Umgebung entfernen. Siehe [Diagnose und Aufbewahrung](../docs/telemetry.md).

## Verbindung mit STUN und TURN

Ohne konfigurierte ICE-Server funktionieren nur entsprechend direkt erreichbare Netzpfade. `TURN_URLS` enthält kommaseparierte STUN-/TURN-Adressen. Für zuverlässigere Verbindungen zwischen verschiedenen Netzen einen erreichbaren, authentifizierten TURN-Dienst konfigurieren:

```dotenv
TURN_ENABLED=true
ICE_TRANSPORT_POLICY=all
TURN_URLS=stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
```

Mit `all` versucht WebRTC direkte Routen und verwendet TURN bei Bedarf. `relay` erzwingt ausschließlich TURN und ist für eine gezielte Relay-Prüfung gedacht; ohne aktiven TURN-Dienst startet die App in diesem Modus nicht. Mit `TURN_ENABLED=false` werden TURN-URLs und Zugangsdaten unterdrückt, konfigurierte STUN-Adressen bleiben verfügbar.

Die App stellt Teilnehmern zeitlich begrenzte HMAC-Zugangsdaten aus. Der unabhängige `TURN_SHARED_SECRET` muss mit dem Relay übereinstimmen. Die Umgebung der App enthält das Shared Secret; der Browser erhält nur die zeitlich begrenzten Zugangsdaten. Die Instanz erlaubt anonyme Raumerstellung, also können auch deren Teilnehmer Relay-Zugangsdaten beziehen. Den Zugriff auf eine privat gedachte Instanz entsprechend am vorgeschalteten Dienst begrenzen.

Für das mitgelieferte coturn-Beispiel `TURN_PUBLIC_IP` auf die externe IPv4-Adresse setzen und DNS für den TURN-Namen einrichten:

```sh
docker compose --env-file .env -f compose.yaml -f compose.turn.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.turn.yaml up -d --build
```

Zusätzlich zu HTTPS sind TCP/UDP 3478 sowie UDP 49160–49200 freizugeben. Hinter NAT muss die externe/innere Adresszuordnung zum Relay passen. Das Beispiel begrenzt Allocations, Bandbreite, CPU, RAM und Logs und sperrt private Relay-Ziele. Es bietet TURN über UDP/TCP, aber keinen TURN/TLS-Fallback auf 443. Dieser benötigt eine eigene öffentliche IP oder einen separaten Relay-Host; Caddy ist kein TURN-Proxy.

`turnserver.conf.example` zeigt alternativ eine begrenzte dateibasierte Konfiguration. Vor Nutzung `PUBLIC_IPV4`, `TURN_SHARED_SECRET` und `realm` ersetzen und die Datei geschützt außerhalb von Git ablegen. Sie nutzt einen eigenen Relay-Portbereich 49160–49223 und wird von der Compose-Vorlage nicht automatisch geladen. Die Firewall muss zur tatsächlich gewählten Konfiguration passen.

## Bereits vorhandener Reverse Proxy

Bei einem Proxy im gleichen Container-Netz `app:3000` als Ziel verwenden. Bei einem Hostdienst ausschließlich auf Loopback veröffentlichen, etwa `127.0.0.1:3000:3000`. Den mitgelieferten Caddy dann nicht zusätzlich starten. Beispiel für einen vorhandenen Caddy:

```caddyfile
studio.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

`PUBLIC_ORIGIN=https://studio.example.com` in der App setzen. WebSocket-Upgrades müssen durchgereicht werden. Der Koordinator vertraut eingehenden Proxy-IP-Headern nicht; hinter einem gemeinsamen Proxy gelten IP-basierte Limits deshalb gemeinsam für dessen Verbindungen. Vor Änderungen an der Proxykonfiguration deren Validierung ausführen.

## Updates und Wiederanlauf

- Eine App-Instanz verwaltet den Raumzustand im RAM. Mehrere Instanzen brauchen eine zusätzliche gemeinsame Raumverwaltung.
- Updates zwischen Takes durchführen. Ein Neustart unterbricht Signalisierung und verliert den aktuellen Raumzustand; Clients können sich mit demselben Signaturschlüssel erneut anmelden. Die lokale Aufnahme ist vom Koordinator getrennt. Vor dem nächsten Take Qualität und Bereitschaft prüfen.
- Raum- und Einladungstokens gelten bei Ausstellung ein Jahr, Relay-Zugangsdaten einen Tag. Tokens haben keine individuelle Widerrufsliste. Ein Wechsel des Signaturschlüssels macht bestehende Raumzugänge ungültig.
- Browser zwischen Takes neu laden, um eine neue Version zu übernehmen. Der Service Worker erzwingt keinen Seitenwechsel während einer Aufnahme. Websitedaten nicht als Updateweg löschen, da sie gespeicherte Raumidentitäten und Berechtigungen enthalten.
- Private Umgebungsdateien, Relaykonfiguration, Diagnosen und Sicherungen außerhalb des Repositorys aufbewahren. Vor Updates Konfiguration und eigenes Image sichern. Verwendete Image-Digests kontrolliert aktualisieren.

Vor einer wichtigen Sitzung mit den tatsächlichen Rechnern und Netzen testen: Gerätecheck, Host-Start/Stop, Mute, Bildschirmfreigabe, direkte Verbindung, erzwungenes TURN, Wiederverbindung, vollständige Dateiübernahme und unabhängiges Abspielen der Exporte. Die offene Systemabnahme steht in [docs/acceptance.md](../docs/acceptance.md).
