use crate::{
    coordinator::{Coordinator, Identity},
    protocol,
    telemetry::{now_ms, truncate},
};
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tungstenite::Error as WebSocketError;

pub const SEND_BYTES: usize = 256_000;
// A room may retain 32 identities with 16 sources each. Its full state can be
// larger than the regular send budget. Admit one such bounded snapshot on an
// empty queue; otherwise long-lived rooms would silently lose their welcome.
pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const SEND_MESSAGES: usize = 64;

struct Outbound {
    message: Message,
    bytes: usize,
    budget: Arc<AtomicUsize>,
}
impl Drop for Outbound {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

#[derive(Clone)]
pub struct SocketHandle {
    queue: mpsc::Sender<Outbound>,
    close: watch::Sender<Option<(u16, String)>>,
    budget: Arc<AtomicUsize>,
}
impl SocketHandle {
    #[cfg(test)]
    pub(crate) fn test_handle() -> Self {
        let (queue, _) = mpsc::channel(SEND_MESSAGES);
        let (close, _) = watch::channel(None);
        Self {
            queue,
            close,
            budget: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn send(&self, message: Message) -> bool {
        if self.close.borrow().is_some() {
            return false;
        }
        let bytes = match &message {
            Message::Text(s) => s.len(),
            Message::Binary(b) | Message::Ping(b) | Message::Pong(b) => b.len(),
            Message::Close(frame) => frame.as_ref().map_or(0, |f| f.reason.len() + 2),
        };
        if bytes > MAX_STATE_BYTES
            || self
                .budget
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                    current
                        .checked_add(bytes)
                        .filter(|n| *n <= SEND_BYTES.max(bytes))
                })
                .is_err()
        {
            return false;
        }
        self.queue
            .try_send(Outbound {
                message,
                bytes,
                budget: self.budget.clone(),
            })
            .is_ok()
    }
    pub fn json(&self, value: Value) -> bool {
        self.send(encode(&value))
    }
    pub fn close(&self, code: u16, reason: &str) {
        self.close.send_replace(Some((code, reason.to_owned())));
    }
    pub fn buffered(&self) -> usize {
        self.budget.load(Ordering::Relaxed)
    }
}

pub fn encode(value: &Value) -> Message {
    Message::Text(serde_json::to_string(value).expect("JSON value").into())
}
pub fn error(socket: &SocketHandle, code: &str, message: &str) {
    socket.json(json!({"type": "error", "code": code, "message": truncate(message, 200)}));
}

pub async fn run(socket: WebSocket, app: Arc<Coordinator>, origin_allowed: bool) {
    let (mut sink, mut stream) = socket.split();
    if !origin_allowed {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            sink.send(Message::Close(Some(CloseFrame {
                code: 1008,
                reason: "Origin rejected".into(),
            }))),
        )
        .await;
        return;
    }
    let (sender, mut receiver) = mpsc::channel::<Outbound>(SEND_MESSAGES);
    let (close, mut closing) = watch::channel(None::<(u16, String)>);
    let handle = SocketHandle {
        queue: sender,
        close,
        budget: Arc::new(AtomicUsize::new(0)),
    };
    // Sending is separate from receiving. A slow peer cannot hold the room lock
    // or stop clock probes and control messages for any other participant.
    let mut writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                result = closing.changed() => {
                    if result.is_err() { break; }
                    let reason = closing.borrow().clone();
                    if let Some((code, reason)) = reason {
                        // Preserve error-before-close ordering, but bound shutdown
                        // even if this peer has stopped reading altogether.
                        let _ = tokio::time::timeout(Duration::from_secs(1), async {
                            while let Ok(row) = receiver.try_recv() { sink.send(row.message.clone()).await?; }
                            sink.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await
                        }).await;
                        break;
                    }
                }
                row = receiver.recv() => {
                    let Some(row) = row else { break; };
                    if !matches!(tokio::time::timeout(Duration::from_secs(20), sink.send(row.message.clone())).await, Ok(Ok(()))) { break; }
                }
            }
        }
    });
    let auth_timeout = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(auth_timeout);
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(20),
        Duration::from_secs(20),
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut shutdown = app.shutdown_receiver();
    let mut identity: Option<Identity> = None;
    let mut alive = true;
    let mut count = 0;
    let mut window_start = now_ms();
    let mut last_failure = None;
    let mut close_code = 1006;
    let mut close_reason = String::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => { handle.close(1001, "Server shutdown"); close_code = 1001; break; }
            _ = &mut auth_timeout, if identity.is_none() => { handle.close(1008, "Authentication required"); close_code = 1008; break; }
            _ = heartbeat.tick() => {
                if !alive { break; }
                alive = false;
                handle.send(Message::Ping(Vec::new().into()));
            }
            _ = &mut writer => { break; }
            next = stream.next() => {
                let t2 = app.clock();
                let raw = match next {
                    Some(Ok(Message::Pong(_))) => { alive = true; continue; }
                    Some(Ok(Message::Ping(data))) => { handle.send(Message::Pong(data)); continue; }
                    Some(Ok(Message::Close(frame))) => {
                        if let Some(frame) = frame { close_code = frame.code; close_reason = frame.reason.to_string(); }
                        break;
                    }
                    Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                    Some(Ok(Message::Binary(data))) => data.to_vec(),
                    Some(Err(error)) => {
                        app.connection_log("socket.error", json!({"message": error.to_string()}), identity.as_ref());
                        let cause = error.into_inner();
                        let code = match cause.downcast_ref::<WebSocketError>() {
                            Some(WebSocketError::Capacity(_)) => 1009,
                            Some(WebSocketError::Utf8(_)) => 1007,
                            _ => 1002,
                        };
                        handle.close(code, ""); close_code = code;
                        break;
                    }
                    None => break,
                };
                let now = now_ms();
                if now.saturating_sub(window_start) > 10_000 { count = 0; window_start = now; }
                count += 1;
                if count > 300 {
                    app.connection_log("socket.rate_limit", Value::Null, identity.as_ref());
                    handle.close(1008, "Rate limit"); close_code = 1008; break;
                }
                let parsed = serde_json::from_slice::<Value>(&raw);
                let result = match parsed {
                    Err(_) => Err("Ungültige JSON-Nachricht."),
                    Ok(value) => match protocol::client_message(value) {
                        Err(_) => {
                            if last_failure.is_none_or(|at| now.saturating_sub(at) >= 5000) {
                                app.connection_log("message.invalid", Value::Null, identity.as_ref()); last_failure = Some(now);
                            }
                            handle.json(json!({"type": "error", "code": "invalid_message", "message": "Ungültige Nachricht."}));
                            continue;
                        }
                        Ok(message) => {
                            if let Some(identity) = &identity { app.handle(identity, message, t2) }
                            else { app.authenticate(&handle, &message).map(|id| { identity = Some(id); }) }
                        }
                    }
                };
                if let Err(reason) = result {
                    if last_failure.is_none_or(|at| now.saturating_sub(at) >= 5000) {
                        app.connection_log("message.rejected", json!({"message": reason}), identity.as_ref()); last_failure = Some(now);
                    }
                    error(&handle, "rejected", reason);
                    if identity.is_none() { handle.close(1008, "Authentication rejected"); close_code = 1008; break; }
                }
            }
        }
    }
    let requested_close = handle.close.borrow().clone();
    let (close_code, close_reason) = requested_close
        .clone()
        .unwrap_or((close_code, close_reason));
    app.connection_log(
        "participant.closed",
        json!({"code": close_code, "reason": truncate(&close_reason, 200)}),
        identity.as_ref(),
    );
    if let Some(identity) = &identity {
        app.disconnect(identity);
    }
    // A completed JoinHandle must not be polled twice.
    if !writer.is_finished() {
        if requested_close.is_none() {
            handle.close(
                if close_code == 1006 { 1001 } else { close_code },
                &close_reason,
            );
        }
        if tokio::time::timeout(Duration::from_millis(1500), &mut writer)
            .await
            .is_err()
        {
            writer.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outgoing_budget_includes_queued_and_in_flight_messages() {
        let (queue, mut receiver) = mpsc::channel(64);
        let (close, _) = watch::channel(None);
        let handle = SocketHandle {
            queue,
            close,
            budget: Arc::new(AtomicUsize::new(0)),
        };
        assert!(handle.send(Message::Text("x".repeat(128_000).into())));
        let in_flight = receiver.try_recv().unwrap();
        assert!(!handle.send(Message::Text("x".repeat(128_001).into())));
        assert_eq!(handle.buffered(), 128_000);
        drop(in_flight);
        assert_eq!(handle.buffered(), 0);
        assert!(handle.send(Message::Text("x".repeat(SEND_BYTES + 1).into())));
        assert!(!handle.send(Message::Text("x".into())));
        drop(receiver.try_recv().unwrap());
        assert!(!handle.send(Message::Text("x".repeat(MAX_STATE_BYTES + 1).into())));
        for _ in 0..64 {
            assert!(handle.send(Message::Text("x".into())));
        }
        assert!(!handle.send(Message::Text("x".into())));
        assert_eq!(handle.buffered(), 64);
        drop(receiver);
        assert_eq!(handle.buffered(), 0);
    }
}
