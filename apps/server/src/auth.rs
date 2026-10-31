use crate::protocol::{MAX_SAFE_INTEGER, name, valid_id};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::Sha256;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub purpose: String,
    pub room_id: String,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub room_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub participant_id: Option<String>,
    pub role: String,
    pub exp: f64,
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

pub fn sign(claims: &Claims, secret: &str) -> String {
    let data = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("serializable claims"));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(data.as_bytes());
    format!(
        "{data}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

pub fn verify(
    token: &str,
    secret: &str,
    purpose: &str,
    now_ms: u64,
) -> Result<Claims, &'static str> {
    let invalid = "Ungültiger Zugang.";
    if token.len() > 4096 {
        return Err(invalid);
    }
    let (data, signature) = token.split_once('.').ok_or(invalid)?;
    let actual = URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| invalid)?;
    mac.update(data.as_bytes());
    mac.verify_slice(&actual).map_err(|_| invalid)?;
    let bytes = URL_SAFE_NO_PAD.decode(data).map_err(|_| invalid)?;
    let mut claims: Claims = serde_json::from_slice(&bytes).map_err(|_| invalid)?;
    if !["session", "invite"].contains(&claims.purpose.as_str())
        || !["host", "guest"].contains(&claims.role.as_str())
        || !valid_id(&claims.room_id)
        || claims
            .participant_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
        || !claims.exp.is_finite()
        || claims.exp.fract() != 0.0
        || claims.exp <= 0.0
        || claims.exp > MAX_SAFE_INTEGER
    {
        return Err(invalid);
    }
    if let Some(room_name) = claims.room_name.as_mut() {
        *room_name = name(&serde_json::Value::String(room_name.clone())).ok_or(invalid)?;
    }
    if claims.exp <= now_ms as f64 / 1000.0
        || claims.purpose != purpose
        || (purpose == "session" && claims.participant_id.is_none())
    {
        return Err("Zugang abgelaufen oder ungültig.");
    }
    if purpose == "invite" && claims.role != "guest" {
        return Err("Ungültige Einladung.");
    }
    Ok(claims)
}

pub fn turn_credential(username: &str, secret: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens_bind_identity_role_purpose_and_expiry() {
        let claims = Claims {
            purpose: "session".into(),
            room_id: uuid::Uuid::new_v4().to_string(),
            room_name: None,
            participant_id: Some(uuid::Uuid::new_v4().to_string()),
            role: "host".into(),
            exp: 2000.0,
        };
        let token = sign(&claims, "secret");
        assert_eq!(
            verify(&token, "secret", "session", 1_000_000).unwrap(),
            claims
        );
        assert!(verify(&token, "wrong", "session", 1_000_000).is_err());
        assert!(verify(&token, "secret", "invite", 1_000_000).is_err());
        assert!(verify(&token, "secret", "session", 2_000_000).is_err());
        let mut forged = claims.clone();
        forged.participant_id = Some(uuid::Uuid::new_v4().to_string());
        let data = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        let forged = format!("{data}.{}", token.split('.').nth(1).unwrap());
        assert!(verify(&forged, "secret", "session", 1_000_000).is_err());
        let mut malformed = serde_json::to_value(&claims).unwrap();
        malformed["roomName"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Claims>(malformed).is_err());
    }
}
