use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use localtake_server::{
    coordinator::{Config, Coordinator},
    http,
    telemetry::TelemetrySink,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Default)]
struct Sink {
    rows: Mutex<Vec<Value>>,
    fail: bool,
}
impl TelemetrySink for Sink {
    fn enqueue(&self, value: Value) -> bool {
        if self.fail {
            false
        } else {
            self.rows.lock().unwrap().push(value);
            true
        }
    }
    fn status(&self) -> Value {
        json!({"enabled": true, "dropped": 0})
    }
}
fn fixture(sink: Option<Arc<Sink>>) -> Router {
    let mut config = Config::new("a".repeat(64), "https://record.example.test".into());
    config.telemetry = sink.map(|s| s as Arc<dyn TelemetrySink>);
    http::router(Coordinator::new(config).unwrap())
}
async fn request(
    app: &Router,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let data = to_bytes(response.into_body(), 32_768).await.unwrap();
    (status, serde_json::from_slice(&data).unwrap_or(Value::Null))
}
async fn credentials(app: &Router) -> Value {
    request(app, "/api/rooms", json!({"name": "Host"}), None)
        .await
        .1
}
fn batch() -> Value {
    json!({"version": 1, "pageId": uuid::Uuid::new_v4().to_string(), "sequence": 1, "dropped": 0, "events": [{"at": "2026-10-26T12:00:00.000Z", "elapsedMs": 1, "scope": "live", "event": "ice.failed"}], "sample": {"socket": "closed"}})
}

#[tokio::test]
async fn telemetry_uses_signed_identities_strict_validation_and_deduplication() {
    let sink = Arc::new(Sink::default());
    let app = fixture(Some(sink.clone()));
    let host = credentials(&app).await;
    assert_eq!(host["telemetry"]["enabled"], true);
    let token = host["token"].as_str().unwrap();
    let data = batch();
    for invalid in [None, Some("invalid"), host["inviteToken"].as_str()] {
        assert_eq!(
            request(&app, "/api/telemetry", data.clone(), invalid)
                .await
                .0,
            401
        );
    }
    let mut forged = data.clone();
    forged["participantId"] = "forged".into();
    assert_eq!(
        request(&app, "/api/telemetry", forged, Some(token)).await.0,
        400
    );
    let mut negative = data.clone();
    negative["sequence"] = (-1).into();
    assert_eq!(
        request(&app, "/api/telemetry", negative, Some(token))
            .await
            .0,
        400
    );
    let mut extra_event = data.clone();
    extra_event["events"][0]["unexpected"] = true.into();
    assert_eq!(
        request(&app, "/api/telemetry", extra_event, Some(token))
            .await
            .0,
        400
    );
    assert_eq!(
        request(&app, "/api/telemetry", data.clone(), Some(token))
            .await
            .1,
        json!({"accepted": true})
    );
    assert_eq!(
        request(&app, "/api/telemetry", data.clone(), Some(token))
            .await
            .1,
        json!({"accepted": true, "duplicate": true})
    );
    let mut next = data;
    next["sequence"] = 2.into();
    assert_eq!(
        request(&app, "/api/telemetry", next, Some(token)).await.0,
        429
    );
    let rows = sink.rows.lock().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["roomId"], host["roomId"]);
    assert_eq!(rows[0]["participantId"], host["participantId"]);
    assert!(rows[0].get("token").is_none());
}

#[tokio::test]
async fn telemetry_failure_and_disabled_storage_preserve_room_api() {
    let app = fixture(Some(Arc::new(Sink {
        fail: true,
        ..Sink::default()
    })));
    let host = credentials(&app).await;
    assert_eq!(
        request(&app, "/api/telemetry", batch(), host["token"].as_str())
            .await
            .1,
        json!({"accepted": false})
    );
    assert_eq!(credentials(&app).await["telemetry"]["enabled"], true);
    let disabled = fixture(None);
    assert_eq!(
        request(&disabled, "/api/telemetry", batch(), None).await.0,
        204
    );
    assert_eq!(credentials(&disabled).await["telemetry"]["enabled"], false);
}

#[tokio::test]
async fn spoofed_forwarding_headers_do_not_bypass_bounded_separate_rate_limits() {
    let app = fixture(Some(Arc::new(Sink::default())));
    for i in 0..241 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/telemetry")
            .header("content-type", "application/json")
            .header("x-forwarded-for", format!("192.0.2.{}", i % 255))
            .body(Body::from("{}"))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), if i < 240 { 401 } else { 429 });
    }
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        request(&app, "/api/rooms", json!({"name": "Normal"}), None)
            .await
            .0,
        200
    );
}

#[tokio::test]
async fn room_input_origin_and_body_limits_match_the_browser_contract() {
    let app = fixture(None);
    for name in [Value::Null, json!(" "), json!("x".repeat(61))] {
        assert_eq!(
            request(&app, "/api/rooms", json!({"name": name}), None)
                .await
                .0,
            400
        );
    }
    let request = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("content-type", "application/json")
        .header("origin", "https://attacker.invalid")
        .body(Body::from(r#"{"name":"No"}"#))
        .unwrap();
    let rejected = app.clone().oneshot(request).await.unwrap();
    assert_eq!(rejected.status(), 403);
    assert_eq!(rejected.headers()["x-content-type-options"], "nosniff");
    let payload = json!({"name": "Host", "ignored": "x".repeat(17_000)}).to_string();
    let request = Request::builder()
        .method("POST")
        .uri("/api/rooms")
        .header("content-type", "application/json")
        .header("content-length", payload.len())
        .body(Body::from(payload))
        .unwrap();
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 413);
}

#[tokio::test]
async fn static_files_stream_ranges_head_and_spa_fallback_without_exposing_api_paths() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html>LocalTake").unwrap();
    std::fs::write(dir.path().join("asset.js"), "0123456789").unwrap();
    let mut config = Config::new("a".repeat(64), "https://record.example.test".into());
    config.client_dir = Some(dir.path().to_owned());
    let app = http::router(Coordinator::new(config).unwrap());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/room/test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    for path in ["/api/missing", "/missing.js", "/%2e%2e/Cargo.toml"] {
        assert_eq!(
            app.clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            404
        );
    }
    let range = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/asset.js")
                .header("range", "bytes=2-4")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(range.status(), 206);
    assert_eq!(to_bytes(range.into_body(), 100).await.unwrap(), "234");
    let head = app
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/asset.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(head.status(), 200);
    assert_eq!(head.headers()["content-length"], "10");
    assert!(to_bytes(head.into_body(), 100).await.unwrap().is_empty());
}
