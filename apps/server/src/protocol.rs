use serde::Serialize;
use serde_json::{Map, Value, json};

#[derive(Debug)]
pub struct InvalidMessage;

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub const TELEMETRY_BODY_BYTES: usize = 12_288;

pub fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && (value == "00000000-0000-0000-0000-000000000000"
            || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            || ((b'1'..=b'8').contains(&bytes[14])
                && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')))
}

pub fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

fn string(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| s.chars().count() <= max)
}

pub fn name(value: &Value) -> Option<String> {
    let name = trim(value.as_str()?);
    (!name.is_empty() && name.chars().count() <= 60).then(|| name.to_owned())
}

fn number(value: &Value, integer: bool, max: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= max && (!integer || n.fract() == 0.0))
}

fn enumeration(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|s| options.contains(&s))
}

fn required(
    object: &Map<String, Value>,
    key: &str,
    check: impl FnOnce(&Value) -> bool,
) -> Result<(), InvalidMessage> {
    object
        .get(key)
        .is_some_and(check)
        .then_some(())
        .ok_or(InvalidMessage)
}

fn optional(
    object: &Map<String, Value>,
    key: &str,
    check: impl FnOnce(&Value) -> bool,
) -> Result<(), InvalidMessage> {
    match object.get(key) {
        Some(value) => check(value).then_some(()).ok_or(InvalidMessage),
        None => Ok(()),
    }
}

fn object(value: &mut Value, fields: &[&str]) -> Result<(), InvalidMessage> {
    value
        .as_object_mut()
        .ok_or(InvalidMessage)?
        .retain(|key, _| fields.contains(&key.as_str()));
    Ok(())
}

fn id(value: &Value) -> bool {
    value.as_str().is_some_and(valid_id)
}
fn boolean(value: &Value) -> bool {
    value.is_boolean()
}
fn quality(value: &Value) -> bool {
    enumeration(value, &["720", "1080", "2160"])
}
fn status(value: &Value) -> bool {
    enumeration(
        value,
        &["recording", "finalizing", "saved", "partial", "failed"],
    )
}

fn media(value: &mut Value) -> Result<(), InvalidMessage> {
    object(value, &["micMuted", "camMuted", "sharing", "livePaused"])?;
    let obj = value.as_object_mut().ok_or(InvalidMessage)?;
    for key in ["micMuted", "camMuted", "sharing"] {
        required(obj, key, boolean)?;
    }
    optional(obj, "livePaused", boolean)?;
    obj.entry("livePaused").or_insert(Value::Bool(false));
    Ok(())
}

fn recording(value: &mut Value) -> Result<(), InvalidMessage> {
    object(value, &["recordingId", "state", "sources"])?;
    let obj = value.as_object_mut().ok_or(InvalidMessage)?;
    required(obj, "recordingId", id)?;
    required(obj, "state", status)?;
    let sources = obj
        .get_mut("sources")
        .and_then(Value::as_array_mut)
        .ok_or(InvalidMessage)?;
    if sources.len() > 16 {
        return Err(InvalidMessage);
    }
    for source in sources {
        object(
            source,
            &[
                "trackId",
                "label",
                "kind",
                "state",
                "savedSeconds",
                "capturedSeconds",
                "bytes",
                "segments",
                "error",
                "warning",
            ],
        )?;
        let src = source.as_object().ok_or(InvalidMessage)?;
        required(src, "trackId", id)?;
        required(src, "label", |v| string(v, 120))?;
        required(src, "kind", |v| {
            enumeration(v, &["video", "audio", "screen"])
        })?;
        required(src, "state", status)?;
        for key in ["savedSeconds", "capturedSeconds"] {
            required(src, key, |v| number(v, false, f64::MAX))?;
        }
        for key in ["bytes", "segments"] {
            required(src, key, |v| number(v, true, MAX_SAFE_INTEGER))?;
        }
        for key in ["error", "warning"] {
            optional(src, key, |v| string(v, 300))?;
        }
    }
    Ok(())
}

pub fn client_message(mut value: Value) -> Result<Value, InvalidMessage> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or(InvalidMessage)?
        .to_owned();
    let fields: &[&str] = match kind.as_str() {
        "auth" => &["type", "version", "token", "name"],
        "clock.probe" => &["type", "t1"],
        "peer.signal" => &[
            "type",
            "to",
            "linkId",
            "restart",
            "description",
            "candidate",
        ],
        "media" => &["type", "media"],
        "ready" => &["type", "ready", "reason", "archiveReady"],
        "room.quality" => &["type", "quality"],
        "archive.status" => &["type", "status"],
        "record.prepare" => &["type", "commandId"],
        "record.ready" => &["type", "recordingId", "ready", "reason", "prepared"],
        "record.stop" => &["type", "commandId", "recordingId"],
        "record.status" => &["type", "status"],
        "chat" => &["type", "text"],
        _ => return Err(InvalidMessage),
    };
    object(&mut value, fields)?;
    let obj = value.as_object_mut().ok_or(InvalidMessage)?;
    match kind.as_str() {
        "auth" => {
            required(obj, "version", |v| v.as_f64() == Some(1.0))?;
            required(obj, "token", |v| string(v, 4096))?;
            let name = name(obj.get("name").ok_or(InvalidMessage)?).ok_or(InvalidMessage)?;
            obj.insert("name".into(), name.into());
        }
        "clock.probe" => required(obj, "t1", |v| number(v, false, f64::MAX))?,
        "peer.signal" => {
            required(obj, "to", id)?;
            optional(obj, "linkId", id)?;
            optional(obj, "restart", |v| v == &Value::Bool(true))?;
            if let Some(description) = obj.get_mut("description") {
                object(description, &["type", "sdp"])?;
                let d = description.as_object().ok_or(InvalidMessage)?;
                required(d, "type", |v| enumeration(v, &["offer", "answer"]))?;
                required(d, "sdp", |v| string(v, 48_000))?;
            }
            if let Some(candidate) = obj.get_mut("candidate").filter(|v| !v.is_null()) {
                object(
                    candidate,
                    &["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"],
                )?;
                let c = candidate.as_object().ok_or(InvalidMessage)?;
                required(c, "candidate", |v| string(v, 4096))?;
                optional(c, "sdpMid", |v| v.is_null() || string(v, 64))?;
                optional(c, "sdpMLineIndex", |v| v.is_null() || number(v, true, 64.0))?;
                optional(c, "usernameFragment", |v| v.is_null() || string(v, 256))?;
            }
        }
        "media" => media(obj.get_mut("media").ok_or(InvalidMessage)?)?,
        "ready" | "record.ready" => {
            required(obj, "ready", boolean)?;
            optional(obj, "reason", |v| {
                string(v, if kind == "ready" { 300 } else { 200 })
            })?;
            if kind == "ready" {
                optional(obj, "archiveReady", boolean)?;
            } else {
                required(obj, "recordingId", id)?;
                optional(obj, "prepared", boolean)?;
            }
        }
        "room.quality" => required(obj, "quality", quality)?,
        "archive.status" => {
            let value = obj.get_mut("status").ok_or(InvalidMessage)?;
            object(value, &["pending", "bytes", "total", "state", "reason"])?;
            let s = value.as_object().ok_or(InvalidMessage)?;
            required(s, "pending", |v| number(v, true, MAX_SAFE_INTEGER))?;
            for key in ["bytes", "total"] {
                required(s, key, |v| number(v, false, f64::MAX))?;
            }
            required(s, "state", |v| {
                enumeration(v, &["idle", "waiting", "uploading", "done", "error"])
            })?;
            optional(s, "reason", |v| string(v, 300))?;
        }
        "record.prepare" | "record.stop" => {
            required(obj, "commandId", id)?;
            if kind == "record.stop" {
                required(obj, "recordingId", id)?;
            }
        }
        "record.status" => recording(obj.get_mut("status").ok_or(InvalidMessage)?)?,
        "chat" => {
            let text = trim(
                obj.get("text")
                    .and_then(Value::as_str)
                    .ok_or(InvalidMessage)?,
            );
            if text.is_empty() || text.chars().count() > 2000 {
                return Err(InvalidMessage);
            }
            obj.insert("text".into(), text.to_owned().into());
        }
        _ => unreachable!(),
    }
    Ok(value)
}

pub fn telemetry_batch(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    if obj.keys().any(|k| {
        ![
            "version", "pageId", "sequence", "dropped", "events", "sample",
        ]
        .contains(&k.as_str())
    }) {
        return false;
    }
    if required(obj, "version", |v| v.as_f64() == Some(1.0)).is_err()
        || required(obj, "pageId", id).is_err()
        || ["sequence", "dropped"]
            .iter()
            .any(|k| required(obj, k, |v| number(v, true, MAX_SAFE_INTEGER)).is_err())
    {
        return false;
    }
    let Some(events) = obj.get("events").and_then(Value::as_array) else {
        return false;
    };
    events.len() <= 24
        && events.iter().all(|e| {
            let Some(e) = e.as_object() else {
                return false;
            };
            e.keys()
                .all(|k| ["at", "elapsedMs", "scope", "event", "detail"].contains(&k.as_str()))
                && required(e, "at", |v| {
                    v.as_str().is_some_and(|s| {
                        static SHAPE: std::sync::OnceLock<regex::Regex> =
                            std::sync::OnceLock::new();
                        SHAPE
                            .get_or_init(|| {
                                regex::Regex::new(
                                r"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$",
                            )
                            .unwrap()
                            })
                            .is_match(s)
                            && chrono::DateTime::parse_from_rfc3339(s).is_ok()
                    })
                })
                .is_ok()
                && required(e, "elapsedMs", |v| number(v, false, f64::MAX)).is_ok()
                && required(e, "scope", |v| string(v, 40)).is_ok()
                && required(e, "event", |v| string(v, 80)).is_ok()
        })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub role: String,
    pub connected: bool,
    pub connection_id: String,
    pub media: Value,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_reason: Option<String>,
    pub archive_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload: Option<Value>,
    pub recording: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub created_at: String,
    pub command_id: String,
    pub phase: &'static str,
    pub participants: Vec<String>,
    pub ready: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn initial_media() -> Value {
    json!({"micMuted": false, "camMuted": false, "sharing": false, "livePaused": false})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_contract_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../tests/fixtures/protocol.json")).unwrap();
        for case in cases {
            let actual = client_message(case["input"].clone()).unwrap_or(Value::Null);
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }
}
