//! Self-hosted management console: Stabbur credentials stay on the server.
mod delivery;
mod exports;
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
use serde::{Deserialize, Serialize};
use serde_json::json;
use stabbur_client::{CatalogPlan, Client, Credentials, Unauthenticated, ValidatedCatalogManifest};
use std::fmt;

#[derive(Debug)]
pub struct Failure {
    status: StatusCode,
    code: &'static str,
    request_id: Option<String>,
    detail: Option<SafeDiagnostic>,
    validation_errors: Vec<FieldDiagnostic>,
}

/// A bounded diagnostic from Stabbur's public, credential-free problem contract.
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct SafeDiagnostic(String);
impl SafeDiagnostic {
    fn new(value: String, limit: usize) -> Option<Self> {
        (!value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control))
            .then_some(Self(value))
    }
}
#[derive(Debug, Serialize)]
struct FieldDiagnostic {
    field: SafeDiagnostic,
    message: SafeDiagnostic,
}
impl Failure {
    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "session_expired")
    }
    fn forbidden(code: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code)
    }
    fn origin_rejected(origin: &security::Origin) -> Self {
        let mut failure = Self::forbidden("origin_rejected");
        failure.detail = SafeDiagnostic::new(
            format!(
                "Open {} before signing in. The browser address must match the configured console address exactly.",
                origin.as_str()
            ),
            1024,
        );
        failure
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
            detail: None,
            validation_errors: vec![],
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
                if matches!(problem.status, 400 | 404 | 409 | 412 | 422) {
                    value.detail = SafeDiagnostic::new(problem.detail, 1024);
                    value.validation_errors = problem
                        .validation_errors
                        .into_iter()
                        .take(32)
                        .filter_map(|error| {
                            Some(FieldDiagnostic {
                                field: SafeDiagnostic::new(error.field, 128)?,
                                message: SafeDiagnostic::new(error.message, 512)?,
                            })
                        })
                        .collect();
                }
                value
            }
            stabbur_client::ApiError::InvalidValue { kind, detail } => {
                let mut value = Self::bad_request("invalid_value");
                value.detail = SafeDiagnostic::new(format!("{kind}: {detail}"), 1024);
                value
            }
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
        HttpResponse::build(self.status).json(json!({"code":self.code,"request_id":self.request_id,
                "detail":self.detail,"validation_errors":self.validation_errors}))
    }
}

struct State {
    config: Config,
    public_client: Client<Unauthenticated>,
    sessions: Sessions,
    limiter: LoginLimiter,
    contract: Contract,
    delivery: Option<delivery::Repository>,
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
    let input = input.into_inner();
    let operation = ValidatedOperation::resolve(&state.contract, &id, input)?;
    let response = session
        .client()
        .raw(operation.request())
        .await
        .map_err(Failure::from)?;
    if let (Some(repo), Some(release)) = (&state.delivery, operation.withdrawn_release()) {
        let actor = session
            .client()
            .me()
            .await
            .map_err(Failure::from)?
            .id
            .to_string();
        repo.withdraw(release, &actor).await?;
    }
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecipeImportInput {
    snapshot: stabbur_client::RecipeCatalogSnapshotId,
    selections: Vec<stabbur_client::RecipeImportSelection>,
}
async fn prepare_import(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<RecipeImportInput>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    let snapshot = session
        .client()
        .catalog()
        .snapshot(input.snapshot)
        .await
        .map_err(Failure::from)?;
    let manifest = stabbur_client::prepare_recipe_import(&snapshot.manifest, &input.selections)
        .map_err(Failure::from)?;
    Ok(HttpResponse::Ok().json(manifest))
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
async fn index(request: HttpRequest, state: web::Data<State>) -> HttpResponse {
    if state.config.development && state.config.public.as_str().starts_with("http://") {
        let alias = request
            .headers()
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            .and_then(|host| security::Origin::parse(&format!("http://{host}"), true).ok());
        if alias.is_some_and(|origin| origin.as_str() != state.config.public.as_str()) {
            return HttpResponse::TemporaryRedirect()
                .insert_header((
                    header::LOCATION,
                    format!("{}/", state.config.public.as_str()),
                ))
                .finish();
        }
    }
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(include_str!("../public/index.html"))
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
        "recipe-model.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/recipe-model.js"),
        ),
        "library.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/library.js"),
        ),
        "exports.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/exports.js"),
        ),
        "delivery.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/delivery.js"),
        ),
        "workflows.js" => (
            "text/javascript; charset=utf-8",
            include_str!("../public/workflows.js"),
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
        .route("/", web::get().to(index))
        .route("/assets/{asset}", web::get().to(asset))
        .route("/api/login", web::post().to(login))
        .route("/api/session", web::get().to(session))
        .route("/api/logout", web::post().to(logout))
        .route("/api/operation/{id}", web::post().to(operation))
        .route("/api/catalog/{action}", web::post().to(catalog))
        .route("/api/recipe-import", web::post().to(prepare_import))
        .route("/api/download/{digest}", web::get().to(download))
        .route("/api/exports/apply", web::post().to(exports::apply))
        .route(
            "/api/exports/{export}/profile",
            web::post().to(exports::profile),
        )
        .route(
            "/api/exports/{export}/snapshots/{generation}/download",
            web::get().to(exports::bundle),
        )
        .route(
            "/munki/exports/{export}/{kind}/{name}",
            web::get().to(exports::serve),
        )
        .route("/api/delivery", web::get().to(delivery::status))
        .route("/api/delivery/publish", web::post().to(delivery::publish))
        .route("/api/delivery/remove", web::post().to(delivery::remove))
        .route("/api/delivery/profile", web::post().to(delivery::profile))
        .route(
            "/munki/{channel}/{kind}/{name}",
            web::get().to(delivery::serve),
        );
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
    let delivery = std::env::var_os("STABBUR_FRONTEND_DATA_DIR")
        .map(|root| delivery::Repository::open(std::path::Path::new(&root)))
        .transpose()
        .map_err(|_| std::io::Error::other("delivery storage initialization failed"))?;
    let state = web::Data::new(State {
        config,
        public_client,
        sessions: Sessions::default(),
        limiter: LoginLimiter::default(),
        contract,
        delivery,
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
    async fn loopback_navigation_redirects_without_relaxing_login_origins() {
        for development in [true, false] {
            let public = if development {
                "http://127.0.0.1:13000"
            } else {
                "https://console.example"
            };
            let config = Config {
                public: security::Origin::parse(public, development).unwrap(),
                upstream: security::Origin::parse("https://server.example", false).unwrap(),
                bind: "127.0.0.1:13000".parse().unwrap(),
                development,
            };
            let state = web::Data::new(State {
                public_client: Client::from_url(config.upstream.as_str()).unwrap(),
                config,
                sessions: Sessions::default(),
                limiter: LoginLimiter::default(),
                contract: serde_json::from_str(include_str!("../public/contract.json")).unwrap(),
                delivery: None,
            });
            let app = actix_web::test::init_service(
                App::new()
                    .wrap(security_headers())
                    .app_data(state)
                    .configure(routes),
            )
            .await;
            for (host, loopback_alias) in [
                ("localhost:13000", true),
                ("[::1]:13000", true),
                ("127.0.0.2:13000", true),
                ("127.0.0.1:13000", false),
                ("console.example", false),
                ("evil.example:13000", false),
                ("localhost.evil.example:13000", false),
            ] {
                let response = actix_web::test::call_service(
                    &app,
                    actix_web::test::TestRequest::get()
                        .uri("/")
                        .insert_header((header::HOST, host))
                        .insert_header(("x-forwarded-host", "evil.example"))
                        .to_request(),
                )
                .await;
                if development && loopback_alias {
                    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
                    assert_eq!(
                        response.headers().get(header::LOCATION).unwrap(),
                        format!("{public}/").as_str()
                    );
                } else {
                    assert_eq!(response.status(), StatusCode::OK);
                    assert!(!response.headers().contains_key(header::LOCATION));
                }
                assert_eq!(
                    response.headers().get(header::CACHE_CONTROL).unwrap(),
                    "no-store"
                );
            }
            let response = actix_web::test::call_service(
                &app,
                actix_web::test::TestRequest::post()
                    .uri("/api/login")
                    .insert_header((header::ORIGIN, "http://localhost:13000"))
                    .insert_header(("x-stabbur-login", "1"))
                    .set_json(json!({"username":"","password":""}))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let problem: serde_json::Value = actix_web::test::read_body_json(response).await;
            assert_eq!(problem["code"], "origin_rejected");
            assert!(problem["detail"].as_str().unwrap().contains(public));
            assert!(!problem["detail"].as_str().unwrap().contains("localhost"));
        }
    }

    #[actix_web::test]
    async fn public_validation_diagnostics_are_bounded_and_attached_to_fields() {
        let error = Failure::from(stabbur_client::ApiError::Server(stabbur_client::Problem {
            code: "validation_failed".into(),
            status: 400,
            detail: "The slug is invalid.".into(),
            request_id: "test-validation".into(),
            validation_errors: vec![
                stabbur_client::ValidationError {
                    field: "slug".into(),
                    code: "invalid".into(),
                    message: "Use lowercase letters.".into(),
                },
                stabbur_client::ValidationError {
                    field: "name".into(),
                    code: "invalid".into(),
                    message: "x".repeat(513),
                },
            ],
        }));
        let body = actix_web::body::to_bytes(error.error_response().into_body())
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["validation_errors"].as_array().unwrap().len(), 1);
        assert_eq!(value["validation_errors"][0]["field"], "slug");
        assert_eq!(value["detail"], "The slug is invalid.");
    }
    #[actix_web::test]
    async fn backend_failures_never_forward_internal_diagnostics() {
        let error = Failure::from(stabbur_client::ApiError::Server(stabbur_client::Problem {
            code: "internal".into(),
            status: 500,
            detail: "private-backend-detail".into(),
            request_id: "test-backend".into(),
            validation_errors: vec![],
        }));
        let body = actix_web::body::to_bytes(error.error_response().into_body())
            .await
            .unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(!text.contains("private-backend-detail"));
        assert!(text.contains("server_unavailable"));
    }
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
            delivery: None,
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
