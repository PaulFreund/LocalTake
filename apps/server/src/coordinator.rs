use crate::{
    auth::{self, Claims},
    protocol::{self, Peer, Take},
    socket::{self, SocketHandle},
    telemetry::{TelemetrySink, now_ms, timestamp},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, watch},
    task::AbortHandle,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Config {
    pub secret: String,
    pub origin: String,
    pub max_participants: usize,
    pub turn_enabled: bool,
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
    pub ice_transport_policy: String,
    pub client_dir: Option<PathBuf>,
    pub telemetry: Option<Arc<dyn TelemetrySink>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn preparation_times_out_and_cancellation_stops_its_timer() {
        let app =
            Coordinator::new(Config::new("a".repeat(64), "https://test.invalid".into())).unwrap();
        let room_id = Uuid::new_v4().to_string();
        let participant_id = Uuid::new_v4().to_string();
        let token = auth::sign(
            &app.claims(
                "session",
                room_id.clone(),
                "Test".into(),
                Some(participant_id),
                "host",
            ),
            &app.config.secret,
        );
        let identity = app
            .authenticate(
                &SocketHandle::test_handle(),
                &json!({"type": "auth", "token": token, "name": "Host"}),
            )
            .unwrap();
        app.handle(&identity, json!({"type": "ready", "ready": true}), 0.0)
            .unwrap();
        app.handle(
            &identity,
            json!({"type": "record.prepare", "commandId": Uuid::new_v4().to_string()}),
            0.0,
        )
        .unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        {
            let rooms = app.rooms.lock().unwrap();
            let take = rooms[&room_id].take.as_ref().unwrap();
            assert_eq!(take.phase, "cancelled");
            assert_eq!(
                take.reason.as_deref(),
                Some("Nicht alle Teilnehmer haben rechtzeitig bestätigt.")
            );
        }
        app.handle(
            &identity,
            json!({"type": "record.prepare", "commandId": Uuid::new_v4().to_string()}),
            0.0,
        )
        .unwrap();
        let recording_id = app.rooms.lock().unwrap()[&room_id]
            .take
            .as_ref()
            .unwrap()
            .id
            .clone();
        app.handle(&identity, json!({"type": "record.ready", "recordingId": recording_id, "ready": false, "reason": "Disk"}), 0.0).unwrap();
        tokio::time::advance(Duration::from_secs(20)).await;
        tokio::task::yield_now().await;
        let rooms = app.rooms.lock().unwrap();
        assert_eq!(
            rooms[&room_id].take.as_ref().unwrap().reason.as_deref(),
            Some("Host: Disk")
        );
        assert!(rooms[&room_id].timer.is_none());
    }
    #[tokio::test]
    async fn room_and_command_caps_expire_inactive_state() {
        let app =
            Coordinator::new(Config::new("a".repeat(64), "https://test.invalid".into())).unwrap();
        {
            let mut rooms = app.rooms.lock().unwrap();
            for i in 0..256 {
                app.room(&mut rooms, &i.to_string(), None).unwrap();
            }
            assert!(app.room(&mut rooms, "overflow", None).is_err());
            let room = rooms.get_mut("0").unwrap();
            for i in 0..300 {
                assert!(room.remember(&i.to_string()));
            }
            assert_eq!(room.commands.len(), 256);
            assert!(!room.remember("299"));
            assert!(room.remember("0"));
        }
        app.cleanup(now_ms() + 3_600_001);
        assert!(app.rooms.lock().unwrap().is_empty());
        app.room(&mut app.rooms.lock().unwrap(), "new", None)
            .unwrap();
    }
}
impl Config {
    pub fn new(secret: String, origin: String) -> Self {
        Self {
            secret,
            origin,
            max_participants: 4,
            turn_enabled: true,
            turn_urls: Vec::new(),
            turn_secret: None,
            ice_transport_policy: "all".into(),
            client_dir: None,
            telemetry: None,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        if !["all", "relay"].contains(&self.ice_transport_policy.as_str()) {
            return Err("ICE_TRANSPORT_POLICY muss all oder relay sein.");
        }
        if self.ice_transport_policy == "relay"
            && (!self.turn_enabled
                || self.turn_secret.as_ref().is_none_or(String::is_empty)
                || !self
                    .turn_urls
                    .iter()
                    .any(|u| u.starts_with("turn:") || u.starts_with("turns:")))
        {
            return Err("ICE-Relay-Testmodus erfordert einen aktiven TURN-Dienst.");
        }
        Ok(())
    }
}
pub struct Member {
    pub peer: Peer,
    pub socket: Option<SocketHandle>,
    logged_status: String,
    last_status_log: u64,
}
pub struct Room {
    pub id: String,
    pub name: String,
    pub members: Vec<Member>,
    pub take: Option<Take>,
    touched: u64,
    commands: VecDeque<String>,
    pub archive_destination_id: Option<String>,
    pub quality: String,
    timer: Option<AbortHandle>,
    logged_take: String,
}
impl Room {
    pub fn state(&self) -> Value {
        json!({"roomId": self.id, "name": self.name, "peers": self.members.iter().map(|m| &m.peer).collect::<Vec<_>>(), "take": self.take, "archiveDestinationId": self.archive_destination_id, "quality": self.quality})
    }
    pub fn connected(&self) -> usize {
        self.members.iter().filter(|m| m.socket.is_some()).count()
    }
    fn broadcast(&self, value: Value) {
        let encoded = socket::encode(&value);
        for member in &self.members {
            if let Some(socket) = &member.socket {
                socket.send(encoded.clone());
            }
        }
    }
    fn settle(&mut self) {
        if let Some(take) = self.take.as_mut().filter(|t| t.phase == "stopping")
            && take.participants.iter().all(|id| {
                self.members
                    .iter()
                    .find(|m| &m.peer.id == id)
                    .is_none_or(|m| {
                        m.socket.is_none() || final_status(m.peer.recording.as_ref(), &take.id)
                    })
            })
        {
            take.phase = "done";
        }
    }
    fn remember(&mut self, id: &str) -> bool {
        if self.commands.iter().any(|c| c == id) {
            return false;
        }
        if self.commands.len() >= 256 {
            self.commands.pop_front();
        }
        self.commands.push_back(id.to_owned());
        true
    }
    fn clear_timer(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}
fn final_status(status: Option<&Value>, recording_id: &str) -> bool {
    status.is_some_and(|s| {
        s["recordingId"].as_str() == Some(recording_id)
            && matches!(s["state"].as_str(), Some("saved" | "partial" | "failed"))
    })
}
#[derive(Clone)]
pub struct Identity {
    pub room_id: String,
    pub participant_id: String,
    pub connection_id: String,
}

pub struct Coordinator {
    pub config: Config,
    pub epoch: String,
    started: Instant,
    pub rooms: Mutex<HashMap<String, Room>>,
    shutdown: watch::Sender<bool>,
    pub connections: Arc<Semaphore>,
}
impl Coordinator {
    pub fn new(mut config: Config) -> Result<Arc<Self>, &'static str> {
        config.validate()?;
        config.max_participants = config.max_participants.clamp(2, 4);
        let (shutdown, _) = watch::channel(false);
        let app = Arc::new(Self {
            config,
            epoch: Uuid::new_v4().to_string(),
            started: Instant::now(),
            rooms: Mutex::new(HashMap::new()),
            shutdown,
            connections: Arc::new(Semaphore::new(2048)),
        });
        let weak = Arc::downgrade(&app);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(60),
                Duration::from_secs(60),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                let Some(app) = weak.upgrade() else {
                    break;
                };
                if *app.shutdown.borrow() {
                    break;
                }
                app.cleanup(now_ms());
            }
        });
        Ok(app)
    }
    pub fn clock(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }
    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }
    pub fn telemetry_enabled(&self) -> bool {
        self.config
            .telemetry
            .as_ref()
            .is_some_and(|t| t.status()["enabled"] == true)
    }
    pub fn room<'a>(
        &self,
        rooms: &'a mut HashMap<String, Room>,
        id: &str,
        name: Option<&str>,
    ) -> Result<&'a mut Room, &'static str> {
        if !rooms.contains_key(id) {
            if rooms.len() >= 256 {
                return Err("Der Dienst ist ausgelastet. Bitte später erneut versuchen.");
            }
            rooms.insert(
                id.to_owned(),
                Room {
                    id: id.to_owned(),
                    name: name.unwrap_or("Raum").to_owned(),
                    members: Vec::new(),
                    take: None,
                    touched: now_ms(),
                    commands: VecDeque::new(),
                    archive_destination_id: None,
                    quality: "1080".into(),
                    timer: None,
                    logged_take: String::new(),
                },
            );
        }
        let room = rooms.get_mut(id).unwrap();
        room.touched = now_ms();
        Ok(room)
    }
    fn log(&self, event: &str, detail: Value, room: Option<&Room>, member: Option<&Member>) {
        let Some(sink) = &self.config.telemetry else {
            return;
        };
        let mut record = json!({"version": 1, "at": timestamp(), "source": "server", "serverEpoch": self.epoch, "event": event});
        let obj = record.as_object_mut().unwrap();
        if !detail.is_null() {
            obj.insert("detail".into(), detail);
        }
        if let Some(room) = room {
            obj.insert("roomId".into(), room.id.clone().into());
            if let Some(take) = &room.take {
                obj.insert("recordingId".into(), take.id.clone().into());
            }
        }
        if let Some(member) = member {
            obj.insert("participantId".into(), member.peer.id.clone().into());
            obj.insert(
                "connectionId".into(),
                member.peer.connection_id.clone().into(),
            );
        }
        sink.enqueue(record);
    }
    pub fn connection_log(&self, event: &str, detail: Value, identity: Option<&Identity>) {
        let rooms = self.rooms.lock().unwrap();
        let room = identity.and_then(|id| rooms.get(&id.room_id));
        let member = room.and_then(|r| {
            r.members
                .iter()
                .find(|m| identity.is_some_and(|id| m.peer.id == id.participant_id))
        });
        self.log(event, detail, room, member);
    }
    fn publish(&self, room: &mut Room) {
        let key = room
            .take
            .as_ref()
            .map(|t| format!("{}/{}", t.id, t.phase))
            .unwrap_or_default();
        if key != room.logged_take {
            room.logged_take = key;
            if let Some(take) = &room.take {
                self.log("record.phase", json!({"take": take}), Some(room), None);
            }
        }
        room.broadcast(json!({"type": "room.state", "state": room.state()}));
    }
    fn ice_servers(&self, participant_id: &str) -> Value {
        let urls = &self.config.turn_urls;
        let stun: Vec<_> = urls
            .iter()
            .filter(|u| u.starts_with("stun:") || u.starts_with("stuns:"))
            .collect();
        let turn: Vec<_> = urls
            .iter()
            .filter(|u| u.starts_with("turn:") || u.starts_with("turns:"))
            .collect();
        let mut result = Vec::new();
        if self.config.ice_transport_policy == "all" && !stun.is_empty() {
            result.push(json!({"urls": stun}));
        }
        if self.config.turn_enabled
            && !turn.is_empty()
            && let Some(secret) = self.config.turn_secret.as_deref().filter(|s| !s.is_empty())
        {
            let username = format!("{}:{participant_id}", now_ms() / 1000 + 86400);
            result.push(json!({"urls": turn, "credential": auth::turn_credential(&username, secret), "username": username}));
        }
        Value::Array(result)
    }
    pub fn authenticate(
        &self,
        socket: &SocketHandle,
        message: &Value,
    ) -> Result<Identity, &'static str> {
        if message["type"] != "auth" {
            return Err("Bitte zuerst anmelden.");
        }
        let claims = auth::verify(
            message["token"].as_str().unwrap(),
            &self.config.secret,
            "session",
            now_ms(),
        )?;
        let participant_id = claims.participant_id.as_deref().unwrap();
        let mut rooms = self.rooms.lock().unwrap();
        let room = self.room(&mut rooms, &claims.room_id, claims.room_name.as_deref())?;
        let previous_index = room
            .members
            .iter()
            .position(|m| m.peer.id == participant_id);
        if previous_index.is_none_or(|i| room.members[i].socket.is_none())
            && room.connected() >= self.config.max_participants
        {
            return Err("Der Raum ist voll.");
        }
        if previous_index.is_none() && room.members.len() >= 32 {
            return Err("Zu viele Raumidentitäten. Bitte neuen Raum öffnen.");
        }
        let mut peer = previous_index
            .map(|i| room.members[i].peer.clone())
            .unwrap_or_else(|| Peer {
                id: participant_id.to_owned(),
                name: String::new(),
                role: claims.role.clone(),
                connected: true,
                connection_id: String::new(),
                media: protocol::initial_media(),
                ready: false,
                ready_reason: None,
                archive_ready: false,
                upload: None,
                recording: None,
            });
        peer.name = message["name"].as_str().unwrap().to_owned();
        peer.role = claims.role;
        peer.connected = true;
        peer.connection_id = Uuid::new_v4().to_string();
        peer.ready = false;
        peer.archive_ready = false;
        peer.ready_reason = Some("Quellen und Speicher werden geprüft.".into());
        if peer.role == "host" {
            room.archive_destination_id = Some(peer.id.clone());
        }
        let identity = Identity {
            room_id: room.id.clone(),
            participant_id: peer.id.clone(),
            connection_id: peer.connection_id.clone(),
        };
        let member = Member {
            peer,
            socket: Some(socket.clone()),
            logged_status: String::new(),
            last_status_log: 0,
        };
        let index = if let Some(i) = previous_index {
            if let Some(previous) = &room.members[i].socket {
                previous.close(4001, "Replaced by reconnect");
            }
            room.members[i] = member;
            i
        } else {
            room.members.push(member);
            room.members.len() - 1
        };
        socket.json(json!({"type": "welcome", "participantId": participant_id, "iceServers": self.ice_servers(participant_id), "iceTransportPolicy": self.config.ice_transport_policy, "serverEpoch": self.epoch, "telemetry": {"enabled": self.telemetry_enabled()}, "state": room.state()}));
        self.log(
            if previous_index.is_some() {
                "participant.reconnected"
            } else {
                "participant.connected"
            },
            json!({"role": room.members[index].peer.role}),
            Some(room),
            Some(&room.members[index]),
        );
        self.publish(room);
        Ok(identity)
    }
    pub fn handle(
        self: &Arc<Self>,
        identity: &Identity,
        message: Value,
        t2: f64,
    ) -> Result<(), &'static str> {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get_mut(&identity.room_id) else {
            return Ok(());
        };
        let Some(index) = room.members.iter().position(|m| {
            m.peer.id == identity.participant_id && m.peer.connection_id == identity.connection_id
        }) else {
            return Ok(());
        };
        let Some(socket) = room.members[index].socket.clone() else {
            return Ok(());
        };
        room.touched = now_ms();
        match message["type"].as_str().unwrap() {
            "auth" => {}
            "clock.probe" => {
                socket.json(json!({"type": "clock.reply", "t1": message["t1"], "t2": t2, "t3": self.clock(), "epoch": self.epoch}));
            }
            "peer.signal" => {
                let target = room.members.iter().find(|m| m.peer.id == message["to"]);
                let mut forwarded = json!({"type": "peer.signal", "from": identity.participant_id, "connectionId": identity.connection_id});
                for key in ["linkId", "restart", "description", "candidate"] {
                    if let Some(value) = message.get(key) {
                        forwarded[key] = value.clone();
                    }
                }
                let sent = target
                    .and_then(|m| m.socket.as_ref())
                    .is_some_and(|target| {
                        message["to"] != identity.participant_id && target.json(forwarded)
                    });
                if message.get("description").is_some() || message.get("restart").is_some() {
                    let mut detail = json!({"to": message["to"], "forwarded": sent});
                    for key in ["linkId", "restart"] {
                        if let Some(v) = message.get(key) {
                            detail[key] = v.clone();
                        }
                    }
                    if let Some(t) = message.get("description").and_then(|v| v.get("type")) {
                        detail["description"] = t.clone();
                    }
                    if let Some(target) = target.and_then(|m| m.socket.as_ref()) {
                        detail["targetState"] = 1.into();
                        detail["bufferedAmount"] = target.buffered().into();
                    }
                    self.log(
                        "signal.forwarded",
                        detail,
                        Some(room),
                        Some(&room.members[index]),
                    );
                }
            }
            "media" => {
                room.members[index].peer.media = message["media"].clone();
                self.publish(room);
            }
            "ready" => {
                let peer = &mut room.members[index].peer;
                peer.ready = message["ready"].as_bool().unwrap();
                peer.archive_ready = message["archiveReady"].as_bool().unwrap_or(peer.ready);
                peer.ready_reason = message["reason"].as_str().map(str::to_owned);
                self.publish(room);
            }
            "room.quality" => {
                if room.members[index].peer.role != "host" {
                    return Err("Nur der Host bestimmt die Aufnahmequalität.");
                }
                if room
                    .take
                    .as_ref()
                    .is_some_and(|t| ["preparing", "recording"].contains(&t.phase))
                {
                    return Err("Qualität erst nach Ende der Aufnahme ändern.");
                }
                room.quality = message["quality"].as_str().unwrap().to_owned();
                self.publish(room);
            }
            "archive.status" => {
                room.members[index].peer.upload = Some(message["status"].clone());
                self.publish(room);
            }
            "chat" => {
                room.broadcast(json!({"type": "chat", "from": identity.participant_id, "name": room.members[index].peer.name, "text": message["text"], "id": Uuid::new_v4().to_string()}));
            }
            "record.prepare" => {
                if room.members[index].peer.role != "host" {
                    return Err("Nur der Host kann eine gemeinsame Aufnahme starten.");
                }
                if !room.remember(message["commandId"].as_str().unwrap()) {
                    return Ok(());
                }
                if room
                    .take
                    .as_ref()
                    .is_some_and(|t| !["done", "cancelled"].contains(&t.phase))
                {
                    return Err("Eine Aufnahme ist bereits aktiv.");
                }
                let blocking: Vec<_> = room
                    .members
                    .iter()
                    .filter(|m| m.socket.is_some() && !m.peer.ready)
                    .map(|m| {
                        format!(
                            "{}: {}",
                            m.peer.name,
                            m.peer
                                .ready_reason
                                .as_deref()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("Quellen und Speicher noch nicht bereit")
                        )
                    })
                    .collect();
                if !blocking.is_empty() {
                    // Dynamic protocol errors are sent here; static errors use
                    // the caller's common logging/close path.
                    socket::error(&socket, "rejected", &blocking.join(" · "));
                    return Ok(());
                }
                let destination = room
                    .members
                    .iter()
                    .find(|m| Some(&m.peer.id) == room.archive_destination_id.as_ref());
                if destination.is_none_or(|m| m.socket.is_none() || !m.peer.archive_ready) {
                    socket::error(
                        &socket,
                        "rejected",
                        &format!(
                            "Ziel-PC {}: Empfangsordner freigeben und Schreibzugriff prüfen.",
                            destination
                                .map(|m| m.peer.name.as_str())
                                .unwrap_or("für Originale")
                        ),
                    );
                    return Ok(());
                }
                room.clear_timer();
                let id = Uuid::new_v4().to_string();
                room.take = Some(Take {
                    id: id.clone(),
                    created_at: timestamp(),
                    command_id: message["commandId"].as_str().unwrap().to_owned(),
                    phase: "preparing",
                    participants: room
                        .members
                        .iter()
                        .filter(|m| m.socket.is_some())
                        .map(|m| m.peer.id.clone())
                        .collect(),
                    ready: Vec::new(),
                    start_at: None,
                    reason: None,
                });
                let room_id = room.id.clone();
                let weak = Arc::downgrade(self);
                let timer = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    if let Some(app) = weak.upgrade() {
                        let mut rooms = app.rooms.lock().unwrap();
                        if let Some(room) = rooms.get_mut(&room_id)
                            && let Some(take) = room
                                .take
                                .as_mut()
                                .filter(|t| t.id == id && t.phase == "preparing")
                        {
                            take.phase = "cancelled";
                            take.reason =
                                Some("Nicht alle Teilnehmer haben rechtzeitig bestätigt.".into());
                            room.timer = None;
                            app.publish(room);
                        }
                    }
                });
                room.timer = Some(timer.abort_handle());
                room.broadcast(json!({"type": "record.prepare", "take": room.take}));
                self.publish(room);
            }
            "record.ready" => {
                let Some(take) = room.take.as_mut().filter(|t| {
                    t.id == message["recordingId"]
                        && t.phase == "preparing"
                        && t.participants.contains(&identity.participant_id)
                }) else {
                    return Ok(());
                };
                if message["ready"] == false {
                    take.phase = "cancelled";
                    take.reason = Some(format!(
                        "{}: {}",
                        room.members[index].peer.name,
                        message["reason"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("Aufnahme noch nicht bereit.")
                    ));
                    room.clear_timer();
                    self.publish(room);
                    return Ok(());
                }
                if !take.ready.contains(&identity.participant_id) {
                    take.ready.push(identity.participant_id.clone());
                }
                if take.participants.iter().all(|id| take.ready.contains(id)) {
                    take.phase = "recording";
                    take.start_at = Some(self.clock() + 1000.0);
                    room.clear_timer();
                    room.broadcast(json!({"type": "record.start", "take": room.take}));
                }
                self.publish(room);
            }
            "record.stop" => {
                if room.members[index].peer.role != "host" {
                    return Err("Nur der Host kann alle Aufnahmen stoppen.");
                }
                if !room.remember(message["commandId"].as_str().unwrap()) {
                    return Ok(());
                }
                if room
                    .take
                    .as_ref()
                    .is_none_or(|t| t.id != message["recordingId"])
                {
                    return Ok(());
                }
                room.clear_timer();
                let take = room.take.as_mut().unwrap();
                if take.phase == "preparing" {
                    take.phase = "cancelled";
                } else if take.phase == "recording" {
                    take.phase = "stopping";
                }
                room.settle();
                room.broadcast(json!({"type": "record.stop", "recordingId": message["recordingId"], "commandId": message["commandId"]}));
                self.publish(room);
            }
            "record.status" => {
                let status = &message["status"];
                let key = json!([
                    status["recordingId"],
                    status["state"],
                    status["sources"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| json!([s["state"], s["error"], s["warning"]]))
                        .collect::<Vec<_>>()
                ])
                .to_string();
                if key != room.members[index].logged_status
                    || now_ms().saturating_sub(room.members[index].last_status_log) >= 30_000
                {
                    self.log(
                        "record.status",
                        status.clone(),
                        Some(room),
                        Some(&room.members[index]),
                    );
                    room.members[index].logged_status = key;
                    room.members[index].last_status_log = now_ms();
                }
                room.members[index].peer.recording = Some(status.clone());
                if let Some(take) = room
                    .take
                    .as_mut()
                    .filter(|t| t.phase == "recording" && t.id == status["recordingId"])
                    && take.participants.iter().all(|id| {
                        room.members
                            .iter()
                            .find(|m| &m.peer.id == id)
                            .is_some_and(|m| final_status(m.peer.recording.as_ref(), &take.id))
                    })
                {
                    take.phase = "done";
                }
                room.settle();
                self.publish(room);
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    pub fn disconnect(&self, identity: &Identity) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room) = rooms.get_mut(&identity.room_id) else {
            return;
        };
        let Some(index) = room.members.iter().position(|m| {
            m.peer.id == identity.participant_id && m.peer.connection_id == identity.connection_id
        }) else {
            return;
        };
        let member = &mut room.members[index];
        member.socket = None;
        member.peer.connected = false;
        member.peer.ready = false;
        member.peer.archive_ready = false;
        if member.peer.recording.is_none()
            && room
                .take
                .as_ref()
                .is_none_or(|t| !t.participants.contains(&identity.participant_id))
        {
            room.members.remove(index);
        }
        room.settle();
        self.publish(room);
    }
    pub fn cleanup(&self, now: u64) {
        self.log(
            "telemetry.status",
            self.config
                .telemetry
                .as_ref()
                .map(|t| t.status())
                .unwrap_or(Value::Null),
            None,
            None,
        );
        self.rooms.lock().unwrap().retain(|_, room| {
            if now.saturating_sub(room.touched) > 3_600_000 && room.connected() == 0 {
                room.clear_timer();
                false
            } else {
                true
            }
        });
    }
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
        for room in self.rooms.lock().unwrap().values_mut() {
            room.clear_timer();
            for member in &room.members {
                if let Some(socket) = &member.socket {
                    socket.close(1001, "Server shutdown");
                }
            }
        }
        if let Some(sink) = &self.config.telemetry {
            sink.shutdown();
        }
    }
    pub fn claims(
        &self,
        purpose: &str,
        room_id: String,
        room_name: String,
        participant_id: Option<String>,
        role: &str,
    ) -> Claims {
        Claims {
            purpose: purpose.into(),
            room_id,
            room_name: Some(room_name),
            participant_id,
            role: role.into(),
            exp: (now_ms() / 1000 + 365 * 86400) as f64,
        }
    }
}
