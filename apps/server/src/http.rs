use crate::{
    auth,
    coordinator::Coordinator,
    protocol::{self, TELEMETRY_BODY_BYTES},
    socket,
    telemetry::{now_ms, timestamp},
};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

const REQUEST_ERROR: &str = "Anfrage konnte nicht verarbeitet werden.";
struct Window {
    count: u32,
    start: u64,
}
struct Upload {
    last_at: u64,
    pages: IndexMap<String, f64>,
}
pub struct HttpState {
    pub coordinator: Arc<Coordinator>,
    rates: Mutex<[IndexMap<IpAddr, Window>; 3]>,
    uploads: Mutex<IndexMap<String, Upload>>,
}
fn response(status: u16, value: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(value)).into_response()
}
fn error(status: u16, message: &str) -> Response {
    response(status, json!({"error": message}))
}

pub fn router(coordinator: Arc<Coordinator>) -> Router {
    let state = Arc::new(HttpState {
        coordinator,
        rates: Mutex::new(std::array::from_fn(|_| IndexMap::new())),
        uploads: Mutex::new(IndexMap::new()),
    });
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({"ok": true, "version": "0.1.0"})) }),
        )
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/join", post(join_room))
        .route("/api/telemetry", post(telemetry))
        .route("/ws", get(upgrade))
        .method_not_allowed_fallback(|| async { error(404, "Nicht gefunden.") })
        .fallback(static_files)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn guard(State(state): State<Arc<HttpState>>, request: Request, next: Next) -> Response {
    let keep_alive = request.version() == axum::http::Version::HTTP_11
        && request
            .headers()
            .get("connection")
            .is_none_or(|h| h.as_bytes() != b"close");
    let path = request.uri().path();
    let (bucket, max) = if request.method() == Method::POST && path == "/api/rooms" {
        (1, 20)
    } else if request.method() == Method::POST && path == "/api/telemetry" {
        (2, 240)
    } else {
        (0, 120)
    };
    // Deliberately use the socket address, as trustProxy was false. Forwarded
    // headers must not let callers choose an unlimited supply of rate buckets.
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|i| i.0.ip())
        .unwrap_or(IpAddr::from([127, 0, 0, 1]));
    let now = now_ms();
    let (count, remaining_ms) = {
        let mut rates = state.rates.lock().unwrap();
        let rates = &mut rates[bucket];
        let mut window = rates
            .shift_remove(&ip)
            .filter(|w| now.saturating_sub(w.start) < 60_000)
            .unwrap_or(Window {
                count: 0,
                start: now,
            });
        window.count = window.count.saturating_add(1);
        let result = (window.count, 60_000 - now.saturating_sub(window.start));
        if rates.len() >= 5000 {
            rates.shift_remove_index(0);
        }
        rates.insert(ip, window);
        result
    };
    let mut reply = if count > max {
        error(429, REQUEST_ERROR)
    } else if request.method() == Method::POST
        && request
            .headers()
            .get("origin")
            .is_some_and(|o| o.as_bytes() != state.coordinator.config.origin.as_bytes())
    {
        error(403, "Origin nicht erlaubt.")
    } else {
        next.run(request).await
    };
    let upgraded = reply.status() == StatusCode::SWITCHING_PROTOCOLS;
    let headers = reply.headers_mut();
    if keep_alive && !upgraded {
        headers.insert("connection", HeaderValue::from_static("keep-alive"));
    }
    headers.insert(
        "x-ratelimit-limit",
        HeaderValue::from_str(&max.to_string()).unwrap(),
    );
    headers.insert(
        "x-ratelimit-remaining",
        HeaderValue::from_str(&max.saturating_sub(count).to_string()).unwrap(),
    );
    headers.insert(
        "x-ratelimit-reset",
        HeaderValue::from_str(&remaining_ms.div_ceil(1000).to_string()).unwrap(),
    );
    if count > max {
        headers.insert(
            "retry-after",
            HeaderValue::from_str(&remaining_ms.div_ceil(1000).to_string()).unwrap(),
        );
    }
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        (
            "permissions-policy",
            "camera=(self), microphone=(self), display-capture=(self)",
        ),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
        ),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    reply
}

async fn json_body(
    request: Request,
    limit: usize,
    telemetry: bool,
) -> Result<(HeaderMap, Value), Response> {
    let (parts, body) = request.into_parts();
    if parts
        .headers
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .is_some_and(|n| n > limit as u64)
    {
        // Discard small oversized uploads as a stream so proxy keepalive is
        // preserved, with bounded time/work even for a malicious declared size.
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            let mut stream = body.into_data_stream();
            let mut bytes = 0;
            while let Some(Ok(chunk)) = stream.next().await {
                bytes += chunk.len();
                if bytes > 1024 * 1024 {
                    break;
                }
            }
        })
        .await;
        return Err(error(
            413,
            if telemetry {
                "Diagnose ist zu groß."
            } else {
                REQUEST_ERROR
            },
        ));
    }
    let data = to_bytes(body, limit)
        .await
        .map_err(|_| error(413, REQUEST_ERROR))?;
    if data.is_empty() {
        return Ok((parts.headers, Value::Null));
    }
    let content_type = parts
        .headers
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !content_type.eq_ignore_ascii_case("application/json") {
        return Err(error(415, REQUEST_ERROR));
    }
    let value = serde_json::from_slice(&data).map_err(|_| error(400, REQUEST_ERROR))?;
    Ok((parts.headers, value))
}

async fn create_room(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    let (_, body) = match json_body(request, 16_384, false).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(name) = body.get("name").and_then(protocol::name) else {
        return error(400, "Bitte einen Namen angeben.");
    };
    let room_name = match body.get("roomName") {
        Some(value) => match protocol::name(value) {
            Some(n) => n,
            None => return error(400, "Bitte einen Namen angeben."),
        },
        None => name,
    };
    let app = &state.coordinator;
    let room_id = Uuid::new_v4().to_string();
    let participant_id = Uuid::new_v4().to_string();
    let created = {
        let mut rooms = app.rooms.lock().unwrap();
        app.room(&mut rooms, &room_id, Some(&room_name)).map(|_| ())
    };
    if let Err(reason) = created {
        app.connection_log(
            "http.error",
            json!({"method": "POST", "path": "/api/rooms", "message": reason}),
            None,
        );
        return error(500, REQUEST_ERROR);
    }
    response(
        200,
        json!({"roomId": room_id, "participantId": participant_id, "telemetry": {"enabled": app.telemetry_enabled()},
        "token": auth::sign(&app.claims("session", room_id.clone(), room_name.clone(), Some(participant_id.clone()), "host"), &app.config.secret),
        "inviteToken": auth::sign(&app.claims("invite", room_id.clone(), room_name, None, "guest"), &app.config.secret)}),
    )
}

async fn join_room(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    let (_, body) = match json_body(request, 16_384, false).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(invite) = body
        .get("inviteToken")
        .and_then(Value::as_str)
        .filter(|s| s.chars().count() <= 4096)
    else {
        return error(400, "Name oder Einladung fehlt.");
    };
    if body.get("name").and_then(protocol::name).is_none() {
        return error(400, "Name oder Einladung fehlt.");
    }
    let app = &state.coordinator;
    let claims = match auth::verify(invite, &app.config.secret, "invite", now_ms()) {
        Ok(c) => c,
        Err(_) => return error(401, "Einladung ungültig oder abgelaufen."),
    };
    let room_name = {
        let mut rooms = app.rooms.lock().unwrap();
        let room = match app.room(&mut rooms, &claims.room_id, claims.room_name.as_deref()) {
            Ok(r) => r,
            Err(_) => return error(401, "Einladung ungültig oder abgelaufen."),
        };
        if room.connected() >= app.config.max_participants {
            return error(409, "Der Raum ist voll (maximal vier Teilnehmer).");
        }
        room.name.clone()
    };
    let participant_id = Uuid::new_v4().to_string();
    response(
        200,
        json!({"roomId": claims.room_id, "participantId": participant_id, "inviteToken": invite, "telemetry": {"enabled": app.telemetry_enabled()}, "token": auth::sign(&app.claims("session", claims.room_id.clone(), room_name, Some(participant_id.clone()), "guest"), &app.config.secret)}),
    )
}

async fn telemetry(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    let (headers, body) = match json_body(request, TELEMETRY_BODY_BYTES, true).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let app = &state.coordinator;
    let Some(sink) = &app.config.telemetry else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let claims = match headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| auth::verify(t, &app.config.secret, "session", now_ms()).ok())
    {
        Some(c) => c,
        None => return error(401, "Anmeldung erforderlich."),
    };
    if !protocol::telemetry_batch(&body) {
        return error(400, "Ungültige Diagnose.");
    }
    let now = now_ms();
    let key = format!(
        "{}/{}",
        claims.room_id,
        claims.participant_id.as_ref().unwrap()
    );
    let page_id = body["pageId"].as_str().unwrap();
    let sequence = body["sequence"].as_f64().unwrap();
    let mut uploads = state.uploads.lock().unwrap();
    // Expiration is lazy as well as size-bounded; stale upload identities never
    // accumulate between the coordinator's minute ticks.
    uploads.retain(|_, value| now.saturating_sub(value.last_at) <= 3_600_000);
    if let Some(previous) = uploads.get(&key) {
        if previous.pages.get(page_id).is_some_and(|s| *s >= sequence) {
            return response(202, json!({"accepted": true, "duplicate": true}));
        }
        if now.saturating_sub(previous.last_at) < 5000 {
            let mut r = error(429, "Diagnose wird zu häufig gesendet.");
            r.headers_mut()
                .insert("retry-after", HeaderValue::from_static("5"));
            return r;
        }
    }
    let mut previous = uploads.shift_remove(&key).unwrap_or(Upload {
        last_at: now,
        pages: IndexMap::new(),
    });
    previous.last_at = now;
    let accepted = sink.enqueue(json!({"version": 1, "at": timestamp(), "source": "client", "serverEpoch": app.epoch, "roomId": claims.room_id, "participantId": claims.participant_id, "batch": body}));
    if accepted {
        previous.pages.shift_remove(page_id);
        previous.pages.insert(page_id.to_owned(), sequence);
        if previous.pages.len() > 4 {
            previous.pages.shift_remove_index(0);
        }
    }
    if uploads.len() >= 2048 {
        uploads.shift_remove_index(0);
    }
    uploads.insert(key, previous);
    response(202, json!({"accepted": accepted}))
}

async fn upgrade(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let app = state.coordinator.clone();
    let Ok(permit) = app.connections.clone().try_acquire_owned() else {
        return error(503, REQUEST_ERROR);
    };
    let origin_allowed = headers
        .get("origin")
        .is_some_and(|o| o.as_bytes() == app.config.origin.as_bytes());
    ws.read_buffer_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(socket::SEND_BYTES + socket::MAX_STATE_BYTES)
        .max_message_size(65_536)
        .max_frame_size(65_536)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            socket::run(socket, app, origin_allowed).await
        })
}

async fn static_files(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error(404, "Nicht gefunden.");
    }
    let Some(directory) = &state.coordinator.config.client_dir else {
        return error(404, "Nicht gefunden.");
    };
    let fallback = request.method() == Method::GET
        && !request.uri().to_string().starts_with("/api/")
        && !request.uri().to_string().contains('.');
    let (parts, body) = request.into_parts();
    let fallback_request = Request::from_parts(parts.clone(), Body::empty());
    let result = ServeDir::new(directory)
        .with_buf_chunk_size(16_384)
        .oneshot(Request::from_parts(parts, body))
        .await;
    let mut reply = match result {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    };
    if reply.status() == StatusCode::NOT_FOUND {
        if !fallback {
            return error(404, "Nicht gefunden.");
        }
        reply = match ServeFile::new(directory.join("index.html"))
            .oneshot(fallback_request)
            .await
        {
            Ok(response) => response.map(Body::new),
            Err(never) => match never {},
        };
        if reply.status() == StatusCode::NOT_FOUND {
            return error(404, "Nicht gefunden.");
        }
    }
    reply.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=0"),
    );
    reply
}
