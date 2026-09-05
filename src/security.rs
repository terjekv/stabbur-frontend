//! Validated deployment and session boundaries.
use std::{collections::HashMap, net::SocketAddr, sync::Mutex};

use actix_web::{
    HttpRequest,
    cookie::{Cookie, SameSite, time::Duration as CookieDuration},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use stabbur_client::{Authenticated, Client};
use subtle::ConstantTimeEq;
use url::Url;

use crate::Failure;

/// An exact, credential-free HTTP origin validated once at startup.
#[derive(Clone)]
pub struct Origin(String);
impl Origin {
    pub fn parse(raw: &str, development: bool) -> Result<Self, &'static str> {
        let url = Url::parse(raw).map_err(|_| "invalid origin")?;
        let loopback = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !(url.scheme() == "https" || (development && loopback && url.scheme() == "http"))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(
                "origins require HTTPS, no credentials or path; explicit development permits loopback HTTP",
            );
        }
        Ok(Self(url.origin().ascii_serialization()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn verify(&self, request: &HttpRequest) -> Result<(), Failure> {
        if request
            .headers()
            .get("origin")
            .and_then(|h| h.to_str().ok())
            == Some(self.as_str())
        {
            Ok(())
        } else {
            Err(Failure::forbidden("origin_rejected"))
        }
    }
}

pub struct Config {
    pub public: Origin,
    pub upstream: Origin,
    pub bind: SocketAddr,
    pub development: bool,
}
impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        let development =
            std::env::var("STABBUR_FRONTEND_DEVELOPMENT").is_ok_and(|value| value == "1");
        let public = Origin::parse(
            &std::env::var("STABBUR_FRONTEND_ORIGIN")
                .map_err(|_| "STABBUR_FRONTEND_ORIGIN is required")?,
            development,
        )?;
        let upstream = Origin::parse(
            &std::env::var("STABBUR_SERVER_ORIGIN")
                .map_err(|_| "STABBUR_SERVER_ORIGIN is required")?,
            development,
        )?;
        let bind: SocketAddr = std::env::var("STABBUR_FRONTEND_BIND")
            .unwrap_or_else(|_| "127.0.0.1:3000".into())
            .parse()
            .map_err(|_| "invalid bind address")?;
        if development && !bind.ip().is_loopback() {
            return Err("development must bind to loopback");
        }
        Ok(Self {
            public,
            upstream,
            bind,
            development,
        })
    }
    pub fn cookie_name(&self) -> &'static str {
        if self.development {
            "stabbur-dev-session"
        } else {
            "__Host-stabbur-session"
        }
    }
    pub fn cookie(&self, value: String, seconds: i64) -> Cookie<'static> {
        Cookie::build(self.cookie_name(), value)
            .path("/")
            .http_only(true)
            .secure(!self.development)
            .same_site(SameSite::Strict)
            .max_age(CookieDuration::seconds(seconds))
            .finish()
    }
}

/// Opaque, canonical 256-bit secret. Never formats or serializes implicitly.
#[derive(Clone)]
struct SessionSecret([u8; 32]);
impl SessionSecret {
    fn generate() -> Self {
        Self(rand::random())
    }
    fn parse(value: &str) -> Result<Self, Failure> {
        if value.len() != 43 {
            return Err(Failure::unauthorized());
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| Failure::unauthorized())?;
        let secret = Self(bytes.try_into().map_err(|_| Failure::unauthorized())?);
        if secret.encode() != value {
            return Err(Failure::unauthorized());
        }
        Ok(secret)
    }
    fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }
    fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.0).into()
    }
}

/// A session proven present and unexpired. Construction is confined to the session store.
#[derive(Clone)]
pub struct AuthenticatedSession {
    client: Client<Authenticated>,
    csrf: SessionSecret,
    expires_at: DateTime<Utc>,
}
impl AuthenticatedSession {
    pub fn client(&self) -> &Client<Authenticated> {
        &self.client
    }
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
    pub fn csrf(&self) -> String {
        self.csrf.encode()
    }
    pub fn mutation(&self, request: &HttpRequest, origin: &Origin) -> Result<(), Failure> {
        origin.verify(request)?;
        let supplied = request
            .headers()
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .and_then(|value| SessionSecret::parse(value).ok())
            .ok_or_else(|| Failure::forbidden("csrf_rejected"))?;
        if bool::from(self.csrf.0.ct_eq(&supplied.0)) {
            Ok(())
        } else {
            Err(Failure::forbidden("csrf_rejected"))
        }
    }
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<[u8; 32], AuthenticatedSession>>);
impl Sessions {
    pub fn insert(
        &self,
        client: Client<Authenticated>,
    ) -> Result<(String, AuthenticatedSession), Failure> {
        let now = Utc::now();
        let expires_at = client
            .session_expires_at()
            .ok_or_else(Failure::upstream)?
            .min(now + chrono::Duration::minutes(30));
        if expires_at <= now {
            return Err(Failure::unauthorized());
        }
        let session = AuthenticatedSession {
            client,
            expires_at,
            csrf: SessionSecret::generate(),
        };
        let mut sessions = self.0.lock().map_err(|_| Failure::upstream())?;
        sessions.retain(|_, value| value.expires_at > now);
        if sessions.len() >= 1000 {
            return Err(Failure::busy());
        }
        let secret = SessionSecret::generate();
        sessions.insert(secret.digest(), session.clone());
        Ok((secret.encode(), session))
    }
    pub fn authenticate(
        &self,
        request: &HttpRequest,
        config: &Config,
    ) -> Result<AuthenticatedSession, Failure> {
        let cookie = request
            .cookie(config.cookie_name())
            .ok_or_else(Failure::unauthorized)?;
        let secret = SessionSecret::parse(cookie.value())?;
        let mut sessions = self.0.lock().map_err(|_| Failure::upstream())?;
        sessions.retain(|_, value| value.expires_at > Utc::now());
        sessions
            .get(&secret.digest())
            .cloned()
            .ok_or_else(Failure::unauthorized)
    }
    pub fn remove(&self, request: &HttpRequest, config: &Config) {
        if let Some(secret) = request
            .cookie(config.cookie_name())
            .and_then(|cookie| SessionSecret::parse(cookie.value()).ok())
            && let Ok(mut sessions) = self.0.lock()
        {
            sessions.remove(&secret.digest());
        }
    }
}

#[derive(Default)]
pub struct LoginLimiter(Mutex<HashMap<String, (std::time::Instant, u8)>>);
impl LoginLimiter {
    pub fn check(&self, request: &HttpRequest, username: &str) -> Result<(), Failure> {
        let now = std::time::Instant::now();
        let mut entries = self.0.lock().map_err(|_| Failure::upstream())?;
        entries.retain(|_, (start, _)| now.duration_since(*start).as_secs() < 60);
        // Separate per-peer and per-account budgets prevent account spraying and username rotation.
        let keys = [
            format!(
                "peer:{}",
                request
                    .peer_addr()
                    .map(|a| a.ip().to_string())
                    .unwrap_or_default()
            ),
            format!("user:{username}"),
        ];
        for key in &keys {
            if entries.get(key).is_some_and(|(_, count)| *count >= 5)
                || (!entries.contains_key(key) && entries.len() >= 2048)
            {
                return Err(Failure::busy());
            }
        }
        for key in keys {
            entries.entry(key).or_insert((now, 0)).1 += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;
    #[test]
    fn sessions_are_bound_to_csrf_and_expiry_is_enforced() {
        let config = Config {
            public: Origin::parse("https://console.example", false).unwrap(),
            upstream: Origin::parse("https://server.example", false).unwrap(),
            bind: "127.0.0.1:3000".parse().unwrap(),
            development: false,
        };
        let session = AuthenticatedSession {
            client: Client::from_url(config.upstream.as_str())
                .unwrap()
                .authenticate(stabbur_client::SecretToken::new("fixture-token").unwrap()),
            csrf: SessionSecret::generate(),
            expires_at: Utc::now() + chrono::Duration::minutes(1),
        };
        let valid = TestRequest::post()
            .insert_header(("origin", config.public.as_str()))
            .insert_header(("x-csrf-token", session.csrf()))
            .to_http_request();
        assert!(session.mutation(&valid, &config.public).is_ok());
        let other = TestRequest::post()
            .insert_header(("origin", config.public.as_str()))
            .insert_header(("x-csrf-token", SessionSecret::generate().encode()))
            .to_http_request();
        assert!(session.mutation(&other, &config.public).is_err());
        let sessions = Sessions::default();
        let secret = SessionSecret::generate();
        sessions
            .0
            .lock()
            .unwrap()
            .insert(secret.digest(), session.clone());
        let request = TestRequest::default()
            .cookie(config.cookie(secret.encode(), 60))
            .to_http_request();
        assert!(sessions.authenticate(&request, &config).is_ok());
        let mut expired = session;
        expired.expires_at = Utc::now() - chrono::Duration::seconds(1);
        sessions.0.lock().unwrap().insert(secret.digest(), expired);
        assert!(sessions.authenticate(&request, &config).is_err());
        assert!(sessions.0.lock().unwrap().is_empty());
    }

    #[test]
    fn origins_reject_credentials_paths_and_insecure_remote_hosts() {
        for origin in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/a",
            "https://example.com/?a=1",
            "https://example.com/#x",
        ] {
            assert!(Origin::parse(origin, true).is_err());
        }
        assert!(Origin::parse("http://127.0.0.1:3000", false).is_err());
        assert!(Origin::parse("http://127.0.0.1:3000", true).is_ok());
        let origin = Origin::parse("https://console.example", false).unwrap();
        assert!(
            origin
                .verify(
                    &TestRequest::default()
                        .insert_header(("origin", "https://console.example.evil"))
                        .to_http_request()
                )
                .is_err()
        );
        assert!(
            origin
                .verify(&TestRequest::default().to_http_request())
                .is_err()
        );
    }
    #[test]
    fn opaque_session_values_are_strict_and_cookies_are_hardened() {
        let secret = SessionSecret::generate();
        assert_eq!(
            SessionSecret::parse(&secret.encode()).unwrap().digest(),
            secret.digest()
        );
        assert!(SessionSecret::parse("../").is_err());
        let config = Config {
            public: Origin::parse("https://console.example", false).unwrap(),
            upstream: Origin::parse("https://server.example", false).unwrap(),
            bind: "127.0.0.1:3000".parse().unwrap(),
            development: false,
        };
        let cookie = config.cookie(secret.encode(), 100);
        assert_eq!(cookie.name(), "__Host-stabbur-session");
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Strict));
        assert_eq!(cookie.domain(), None);
    }
}
