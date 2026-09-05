//! Self-hosted management console: Stabbur credentials stay on the server.
mod operations;
mod security;

use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, ResponseError,
    http::{StatusCode, header},
    middleware::DefaultHeaders,
    web,
};
use futures_util::TryStreamExt;
use operations::{Contract, OperationInput, ValidatedOperation};
use security::{Config, LoginLimiter, Sessions};
use serde::Deserialize;
use serde_json::json;
use stabbur_client::{CatalogPlan, Client, Credentials, Unauthenticated, ValidatedCatalogManifest};
use std::fmt;

#[derive(Debug)]
pub struct Failure {
    status: StatusCode,
    code: &'static str,
    request_id: Option<String>,
}
impl Failure {
    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "session_expired")
    }
    fn forbidden(code: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code)
    }
    fn bad_request(code: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }
    fn upstream() -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "server_unavailable")
    }
    fn busy() -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "try_again_later")
    }
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            request_id: None,
        }
    }
}
impl From<stabbur_client::ApiError> for Failure {
    fn from(error: stabbur_client::ApiError) -> Self {
        match error {
            stabbur_client::ApiError::Server(problem) => {
                let mut value = match problem.status {
                    400 | 422 => Self::bad_request("validation_failed"),
                    401 => Self::unauthorized(),
                    403 => Self::forbidden("permission_denied"),
                    404 => Self::new(StatusCode::NOT_FOUND, "not_found"),
                    409 => Self::new(StatusCode::CONFLICT, "conflict"),
                    412 => Self::new(StatusCode::PRECONDITION_FAILED, "revision_changed"),
                    429 => Self::busy(),
                    _ => Self::upstream(),
                };
                if problem.request_id.len() <= 128
                    && !problem.request_id.chars().any(char::is_control)
                {
                    value.request_id = Some(problem.request_id);
                }
                value
            }
            stabbur_client::ApiError::InvalidValue { .. } => Self::bad_request("invalid_value"),
            stabbur_client::ApiError::StalePlan => Self::new(StatusCode::CONFLICT, "plan_changed"),
            _ => Self::upstream(),
        }
    }
}
impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}
impl ResponseError for Failure {
    fn status_code(&self) -> StatusCode {
        self.status
    }
    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status)
            .json(json!({"code":self.code,"request_id":self.request_id}))
    }
}

struct State {
    config: Config,
    public_client: Client<Unauthenticated>,
    sessions: Sessions,
    limiter: LoginLimiter,
    contract: Contract,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginInput {
    username: String,
    password: String,
}
async fn login(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<LoginInput>,
) -> Result<HttpResponse, Failure> {
    state.config.public.verify(&request)?;
    if request
        .headers()
        .get("x-stabbur-login")
        .and_then(|v| v.to_str().ok())
        != Some("1")
    {
        return Err(Failure::forbidden("login_header_required"));
    }
    if input.username.is_empty()
        || input.username.len() > 128
        || input.password.is_empty()
        || input.password.len() > 4096
    {
        return Err(Failure::bad_request("invalid_credentials"));
    }
    state.limiter.check(&request, &input.username)?;
    let input = input.into_inner();
    let client = state
        .public_client
        .login(&Credentials::new(input.username, input.password))
        .await
        .map_err(Failure::from)?;
    let principal = client.me().await.map_err(Failure::from)?;
    // Rotate any previous browser session only after successful upstream authentication.
    state.sessions.remove(&request, &state.config);
    let (cookie, session) = state.sessions.insert(client)?;
    Ok(HttpResponse::Ok()
        .cookie(state.config.cookie(
            cookie,
            (session.expires_at() - chrono::Utc::now()).num_seconds(),
        ))
        .json(
            json!({"principal":principal,"csrf":session.csrf(),"expires_at":session.expires_at()}),
        ))
}
async fn session(request: HttpRequest, state: web::Data<State>) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    let principal = session.client().me().await.map_err(Failure::from)?;
    Ok(HttpResponse::Ok().json(
        json!({"principal":principal,"csrf":session.csrf(),"expires_at":session.expires_at()}),
    ))
}
async fn logout(request: HttpRequest, state: web::Data<State>) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    state.sessions.remove(&request, &state.config);
    Ok(HttpResponse::NoContent()
        .cookie(state.config.cookie(String::new(), 0))
        .finish())
}
async fn operation(
    request: HttpRequest,
    state: web::Data<State>,
    id: web::Path<String>,
    input: web::Json<OperationInput>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    let operation = ValidatedOperation::resolve(&state.contract, &id, input.into_inner())?;
    let response = session
        .client()
        .raw(operation.request())
        .await
        .map_err(Failure::from)?;
    if operation.credential_download() {
        return Ok(HttpResponse::Ok()
            .insert_header((
                header::CONTENT_DISPOSITION,
                "attachment; filename=stabbur-credential.json",
            ))
            .content_type("application/octet-stream")
            .body(response.body));
    }
    if response.status == 204 || response.body.is_empty() {
        return Ok(HttpResponse::NoContent().finish());
    }
    let body = response
        .json::<serde_json::Value>()
        .map_err(Failure::from)?;
    Ok(HttpResponse::Ok().json(body))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogInput {
    manifest: ValidatedCatalogManifest,
    plan: Option<CatalogPlan>,
}
async fn catalog(
    request: HttpRequest,
    state: web::Data<State>,
    action: web::Path<String>,
    input: web::Json<CatalogInput>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    match action.as_str() {
        "plan" => Ok(HttpResponse::Ok().json(
            session
                .client()
                .catalog()
                .plan_validated(&input.manifest)
                .await
                .map_err(Failure::from)?,
        )),
        "apply" => {
            let plan = input
                .plan
                .as_ref()
                .ok_or_else(|| Failure::bad_request("reviewed_plan_required"))?;
            Ok(HttpResponse::Ok().json(
                session
                    .client()
                    .catalog()
                    .sync_validated(&input.manifest, Some(plan))
                    .await
                    .map_err(Failure::from)?,
            ))
        }
        _ => Err(Failure::bad_request("unknown_operation")),
    }
}
async fn download(
    request: HttpRequest,
    state: web::Data<State>,
    digest: web::Path<String>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    let digest = digest
        .parse::<stabbur_client::Sha256Digest>()
        .map_err(Failure::from)?;
    let download = session
        .client()
        .artifacts()
        .download(&digest, None)
        .await
        .map_err(Failure::from)?;
    Ok(HttpResponse::Ok()
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename={digest}"),
        ))
        .content_type("application/octet-stream")
        .streaming(
            download
                .into_stream()
                .map_err(|_| actix_web::error::ErrorBadGateway("artifact_stream_failed")),
        ))
}
async fn asset(path: web::Path<String>) -> HttpResponse {
    let (content_type, body) = match path.as_str() {
        "app.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/app.js"),
        ),
        "model.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/model.js"),
        ),
        "style.css" => (
            "text/css; charset=utf-8",
            include_str!("../public/style.css"),
        ),
        "contract.json" => ("application/json", include_str!("../public/contract.json")),
        _ => return HttpResponse::NotFound().finish(),
    };
    HttpResponse::Ok().content_type(content_type).body(body)
}
fn routes(config: &mut web::ServiceConfig) {
    config
        .route(
            "/",
            web::get().to(|| async {
                HttpResponse::Ok()
                    .content_type("text/html; charset=utf-8")
                    .body(include_str!("../public/index.html"))
            }),
        )
        .route("/assets/{asset}", web::get().to(asset))
        .route("/api/login", web::post().to(login))
        .route("/api/session", web::get().to(session))
        .route("/api/logout", web::post().to(logout))
        .route("/api/operation/{id}", web::post().to(operation))
        .route("/api/catalog/{action}", web::post().to(catalog))
        .route("/api/download/{digest}", web::get().to(download));
}
fn security_headers() -> DefaultHeaders {
    DefaultHeaders::new().add(("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"))
        .add(("x-content-type-options", "nosniff")).add(("x-frame-options", "DENY"))
        .add(("referrer-policy", "no-referrer")).add(("cache-control", "no-store"))
        .add(("permissions-policy", "camera=(), microphone=(), geolocation=()"))
}
#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let bind = config.bind;
    let public_client = Client::from_url(config.upstream.as_str())
        .map_err(|_| std::io::Error::other("invalid upstream client configuration"))?;
    let contract = serde_json::from_str(include_str!("../public/contract.json"))
        .map_err(|_| std::io::Error::other("invalid embedded gateway contract"))?;
    let state = web::Data::new(State {
        config,
        public_client,
        sessions: Sessions::default(),
        limiter: LoginLimiter::default(),
        contract,
    });
    HttpServer::new(move || {
        App::new()
            .wrap(security_headers())
            .app_data(state.clone())
            .app_data(
                web::JsonConfig::default()
                    .limit(2 * 1024 * 1024)
                    .error_handler(|_, _| Failure::bad_request("invalid_json").into()),
            )
            .configure(routes)
    })
    .workers(2)
    .max_connections(1024)
    .client_request_timeout(std::time::Duration::from_secs(15))
    .bind(bind)?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[actix_web::test]
    async fn anonymous_requests_cannot_reach_the_gateway_and_assets_are_hardened() {
        let config = Config {
            public: security::Origin::parse("https://console.example", false).unwrap(),
            upstream: security::Origin::parse("https://server.example", false).unwrap(),
            bind: "127.0.0.1:3000".parse().unwrap(),
            development: false,
        };
        let state = web::Data::new(State {
            public_client: Client::from_url(config.upstream.as_str()).unwrap(),
            config,
            sessions: Sessions::default(),
            limiter: LoginLimiter::default(),
            contract: serde_json::from_str(include_str!("../public/contract.json")).unwrap(),
        });
        let app = actix_web::test::init_service(
            App::new()
                .wrap(security_headers())
                .app_data(state)
                .configure(routes),
        )
        .await;
        let request = actix_web::test::TestRequest::post()
            .uri("/api/operation/create_software")
            .set_json(json!({"body":{"slug":"test","name":"Test"}}))
            .to_request();
        let response = actix_web::test::call_service(&app, request).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = actix_web::test::call_service(
            &app,
            actix_web::test::TestRequest::get().uri("/").to_request(),
        )
        .await;
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        assert!(
            response
                .headers()
                .get("content-security-policy")
                .unwrap()
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let response = actix_web::test::call_service(
            &app,
            actix_web::test::TestRequest::get()
                .uri("/assets/../../secret")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
