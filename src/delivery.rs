//! Reviewed, immutable Munki delivery snapshots owned by the console.
use crate::{Failure, State};
use actix_web::{
    HttpRequest, HttpResponse,
    http::{StatusCode, header},
    web,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use fs2::FileExt;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use stabbur_client::{Authenticated, Client, ReleaseId, Resolution, Sha256Digest};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};

const MAX_ARTIFACT: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 1000;
fn invalid(detail: &str) -> Failure {
    let mut error = Failure::bad_request("delivery_validation");
    error.detail = crate::SafeDiagnostic::new(detail.to_owned(), 1024);
    error
}
fn storage_error(_: impl std::fmt::Display) -> Failure {
    Failure::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "delivery_storage_unavailable",
    )
}
fn stale() -> Failure {
    Failure::new(StatusCode::CONFLICT, "delivery_changed")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Testing,
    Stable,
}
impl Channel {
    fn name(self) -> &'static str {
        match self {
            Self::Testing => "testing",
            Self::Stable => "stable",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Architecture {
    Aarch64,
    X86_64,
    Universal,
}
impl Architecture {
    fn name(self) -> &'static str {
        match self {
            Self::Aarch64 => "aarch64",
            Self::X86_64 => "x86_64",
            Self::Universal => "universal",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Pkg,
    DmgApp,
}
impl Format {
    fn extension(self) -> &'static str {
        match self {
            Self::Pkg => "pkg",
            Self::DmgApp => "dmg",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Detection {
    Application { name: String, bundle_id: String },
    Receipt { package_id: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSpec {
    software: String,
    channel: Channel,
    architecture: Architecture,
    macos: String,
    format: Format,
    detection: Detection,
}
/// Validation applies equally to incoming forms and persisted snapshots.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawSpec", into = "RawSpec")]
pub struct Spec(RawSpec);
impl From<Spec> for RawSpec {
    fn from(value: Spec) -> Self {
        value.0
    }
}
impl TryFrom<RawSpec> for Spec {
    type Error = &'static str;
    fn try_from(value: RawSpec) -> Result<Self, Self::Error> {
        let slug = &value.software;
        if slug.is_empty()
            || slug.len() > 128
            || !slug
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(
                "Choose a software slug containing lowercase letters, numbers and hyphens.",
            );
        }
        if value.macos.is_empty()
            || value.macos.len() > 32
            || !value
                .macos
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        {
            return Err("Enter the test Mac's macOS version, such as 15.0.");
        }
        let identifier = |s: &str| {
            !s.is_empty()
                && s.len() <= 255
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
        };
        match &value.detection {
            Detection::Application { name, bundle_id } => {
                if name.is_empty()
                    || name.len() > 200
                    || name.contains(['/', '\\', ':'])
                    || name.chars().any(char::is_control)
                    || !Path::new(name)
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
                    || !identifier(bundle_id)
                {
                    return Err(
                        "Supply an application filename ending in .app and its bundle identifier.",
                    );
                }
            }
            Detection::Receipt { package_id } => {
                if value.format != Format::Pkg || !identifier(package_id) {
                    return Err(
                        "Receipt detection requires a package and a valid package identifier.",
                    );
                }
            }
        }
        Ok(Self(value))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishInput {
    spec: Spec,
    release: ReleaseId,
    expected_revision: u64,
    reviewed: bool,
    test_confirmed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    spec: Spec,
    release: ReleaseId,
    version: String,
    name: String,
    digest: Sha256Digest,
    size: u64,
    pkginfo: Value,
    published_at: String,
    tested: bool,
}
impl Entry {
    fn key(&self) -> String {
        format!(
            "{}:{}:{}",
            self.spec.0.channel.name(),
            self.spec.0.software,
            self.spec.0.architecture.name()
        )
    }
    fn filename(&self) -> String {
        format!("{}.{}", self.digest, self.spec.0.format.extension())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    revision: u64,
    entries: BTreeMap<String, Entry>,
    action: String,
    actor: String,
    occurred_at: String,
}
/// A checked upstream administrator; browser role claims are never consulted.
struct Publisher {
    client: Client<Authenticated>,
    actor: String,
}
impl Publisher {
    async fn authorize(client: &Client<Authenticated>) -> Result<Self, Failure> {
        let me = client.me().await?;
        if !me.roles.iter().any(|role| role == "admin") {
            return Err(Failure::forbidden("delivery_admin_required"));
        }
        Ok(Self {
            client: client.clone(),
            actor: me.id.to_string(),
        })
    }
}
/// Owns private local state; a process lock excludes other publishers using this directory.
pub struct Repository {
    root: PathBuf,
    credential: String,
    snapshot: Mutex<Snapshot>,
    _lock: File,
}
impl Repository {
    pub fn open(root: &Path) -> Result<Self, Failure> {
        fs::create_dir_all(root).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(storage_error)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("lock"))
            .map_err(storage_error)?;
        lock.try_lock_exclusive().map_err(storage_error)?;
        for name in ["objects", "history", "staging"] {
            fs::create_dir_all(root.join(name)).map_err(storage_error)?;
        }
        let credential_path = root.join("reader");
        let credential = if credential_path.exists() {
            let bytes = fs::read(&credential_path).map_err(storage_error)?;
            if bytes.len() != 32 {
                return Err(storage_error("invalid reader"));
            }
            STANDARD.encode(bytes)
        } else {
            let bytes: [u8; 32] = rand::random();
            let mut file = private_file(&credential_path)?;
            file.write_all(&bytes).map_err(storage_error)?;
            file.sync_all().map_err(storage_error)?;
            STANDARD.encode(bytes)
        };
        let mut revisions = Vec::new();
        for item in fs::read_dir(root.join("history")).map_err(storage_error)? {
            let path = item.map_err(storage_error)?.path();
            if let Some(n) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u64>().ok())
            {
                revisions.push((n, path));
            }
        }
        revisions.sort_by_key(|r| r.0);
        let snapshot = if let Some((revision, path)) = revisions.last() {
            if fs::metadata(path).map_err(storage_error)?.len() > 8 * 1024 * 1024 {
                return Err(storage_error("snapshot too large"));
            }
            let snapshot: Snapshot =
                serde_json::from_slice(&fs::read(path).map_err(storage_error)?)
                    .map_err(storage_error)?;
            if snapshot.revision != *revision || snapshot.entries.len() > MAX_ENTRIES {
                return Err(storage_error("invalid snapshot"));
            }
            snapshot
        } else {
            Snapshot::default()
        };
        Ok(Self {
            root: root.to_owned(),
            credential,
            snapshot: Mutex::new(snapshot),
            _lock: lock,
        })
    }
    fn auth_header(&self) -> String {
        format!(
            "Basic {}",
            STANDARD.encode(format!("stabbur:{}", self.credential))
        )
    }
    fn authorize_reader(&self, request: &HttpRequest) -> Result<(), Failure> {
        let actual = request
            .headers()
            .get(header::AUTHORIZATION)
            .map_or(&b""[..], actix_web::http::header::HeaderValue::as_bytes);
        if !bool::from(actual.ct_eq(self.auth_header().as_bytes())) {
            return Err(Failure::new(
                StatusCode::UNAUTHORIZED,
                "repository_credentials_required",
            ));
        }
        Ok(())
    }
    fn commit(
        &self,
        current: &mut Snapshot,
        mut next: Snapshot,
        actor: &str,
        action: &str,
    ) -> Result<(), Failure> {
        next.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| storage_error("revision overflow"))?;
        actor.clone_into(&mut next.actor);
        action.clone_into(&mut next.action);
        next.occurred_at = Utc::now().to_rfc3339();
        let bytes = serde_json::to_vec(&next).map_err(storage_error)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(invalid(
                "The repository has reached its metadata size limit.",
            ));
        }
        let mut file =
            tempfile::NamedTempFile::new_in(self.root.join("staging")).map_err(storage_error)?;
        file.write_all(&bytes).map_err(storage_error)?;
        file.as_file().sync_all().map_err(storage_error)?;
        file.persist_noclobber(
            self.root
                .join("history")
                .join(format!("{:020}.json", next.revision)),
        )
        .map_err(storage_error)?;
        File::open(self.root.join("history"))
            .and_then(|f| f.sync_all())
            .map_err(storage_error)?;
        *current = next;
        Ok(())
    }
    pub async fn withdraw(&self, release: ReleaseId, actor: &str) -> Result<(), Failure> {
        let mut current = self.snapshot.lock().await;
        let mut next = current.clone();
        next.entries.retain(|_, e| e.release != release);
        if next.entries.len() != current.entries.len() {
            self.commit(&mut current, next, actor, "release withdrawn")?;
        }
        Ok(())
    }
}
fn private_file(path: &Path) -> Result<File, Failure> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(storage_error)
}
fn xml(value: &Value) -> Result<Vec<u8>, Failure> {
    let plist: plist::Value = serde_json::from_value(value.clone()).map_err(storage_error)?;
    let mut bytes = Vec::new();
    plist.to_writer_xml(&mut bytes).map_err(storage_error)?;
    Ok(bytes)
}
fn repository(state: &State) -> Result<&Repository, Failure> {
    state
        .delivery
        .as_ref()
        .ok_or_else(|| Failure::new(StatusCode::SERVICE_UNAVAILABLE, "delivery_not_configured"))
}
async fn publisher(request: &HttpRequest, state: &State) -> Result<Publisher, Failure> {
    let session = state.sessions.authenticate(request, &state.config)?;
    session.mutation(request, &state.config.public)?;
    Publisher::authorize(session.client()).await
}
pub async fn status(
    request: HttpRequest,
    state: web::Data<State>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.client().me().await?;
    let Some(repo) = state.delivery.as_ref() else {
        return Ok(HttpResponse::Ok().json(json!({"configured":false})));
    };
    let snapshot = repo.snapshot.lock().await;
    Ok(HttpResponse::Ok().json(json!({"configured":true,"revision":snapshot.revision,"url":format!("{}/munki",state.config.public.as_str()),"entries":snapshot.entries.values().collect::<Vec<_>>(),"last_action":snapshot.action,"updated_at":snapshot.occurred_at})))
}
async fn resolve(
    publisher: &Publisher,
    input: &PublishInput,
) -> Result<(stabbur_client::Software, Resolution), Failure> {
    let spec = &input.spec.0;
    let software = publisher.client.software().get(&spec.software).await?;
    let resolution = publisher
        .client
        .software()
        .resolve(
            &spec.software,
            spec.channel.name(),
            "mac_os",
            spec.architecture.name(),
            Some(&spec.macos),
        )
        .await?;
    if resolution.release.id != input.release
        || !matches!(
            resolution.release.availability,
            stabbur_client::ReleaseAvailability::Available
        )
    {
        return Err(stale());
    }
    if resolution.artifact_size == 0 || resolution.artifact_size > MAX_ARTIFACT {
        return Err(invalid(
            "Munki delivery accepts installers between 1 byte and 4 GiB.",
        ));
    }
    Ok((software, resolution))
}
fn package_info(
    spec: &Spec,
    software: &stabbur_client::Software,
    resolution: &Resolution,
) -> Result<Value, Failure> {
    let mut info = json!({"name":software.slug,"display_name":software.name,"version":resolution.release.version,
        "catalogs":[spec.0.channel.name()],"installer_item_location":format!("{}.{}",resolution.artifact_digest,spec.0.format.extension()),
        "installer_item_hash":resolution.artifact_digest,"installer_item_size":resolution.artifact_size.div_ceil(1024),"unattended_install":false});
    info["supported_architectures"] = match resolution.variant.architecture.as_str() {
        "aarch64" => json!(["arm64"]),
        "x86_64" => json!(["x86_64"]),
        "universal" => json!(["arm64", "x86_64"]),
        _ => return Err(invalid("Unsupported installer architecture.")),
    };
    for (key, value) in [
        ("minimum_os_version", &resolution.variant.minimum_macos),
        ("maximum_os_version", &resolution.variant.maximum_macos),
    ] {
        if let Some(value) = value {
            info[key] = json!(value);
        }
    }
    match &spec.0.detection {
        Detection::Application { name, bundle_id } => {
            info["installs"] = json!([{"type":"application","path":format!("/Applications/{name}"),"CFBundleIdentifier":bundle_id,"CFBundleShortVersionString":resolution.release.version,"version_comparison_key":"CFBundleShortVersionString"}]);
            if spec.0.format == Format::DmgApp {
                info["installer_type"] = json!("copy_from_dmg");
                info["items_to_copy"] =
                    json!([{"source_item":name,"destination_path":"/Applications"}]);
            }
        }
        Detection::Receipt { package_id } => {
            info["receipts"] =
                json!([{"packageid":package_id,"version":resolution.release.version}]);
        }
    }
    Ok(info)
}
/// The only production constructor is the bounded hash-and-format verifier below.
struct VerifiedInstaller {
    digest: Sha256Digest,
    size: u64,
    format: Format,
}
async fn verified_download(
    repo: &Repository,
    publisher: &Publisher,
    resolution: &Resolution,
    format: Format,
) -> Result<VerifiedInstaller, Failure> {
    let temp = tempfile::NamedTempFile::new_in(repo.root.join("staging")).map_err(storage_error)?;
    let mut file = tokio::fs::File::from_std(temp.reopen().map_err(storage_error)?);
    let download = publisher
        .client
        .artifacts()
        .download(&resolution.artifact_digest, None)
        .await?;
    let mut stream = download.into_stream();
    let mut hash = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = stream.try_next().await.map_err(Failure::from)? {
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| invalid("Installer exceeds its declared size."))?;
        if size > resolution.artifact_size {
            return Err(invalid("Installer exceeds its declared size."));
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(storage_error)?;
    }
    if size != resolution.artifact_size
        || format!("{:x}", hash.finalize()) != resolution.artifact_digest.to_string()
    {
        return Err(invalid("Installer checksum or size verification failed."));
    }
    file.flush().await.map_err(storage_error)?;
    let mut magic = [0u8; 4];
    file.seek(std::io::SeekFrom::Start(if format == Format::Pkg {
        0
    } else {
        size.checked_sub(512)
            .ok_or_else(|| invalid("Not a disk image."))?
    }))
    .await
    .map_err(storage_error)?;
    file.read_exact(&mut magic).await.map_err(storage_error)?;
    if magic
        != *(if format == Format::Pkg {
            b"xar!"
        } else {
            b"koly"
        })
    {
        return Err(invalid(
            "The installer bytes do not match the selected PKG or DMG format.",
        ));
    }
    file.sync_all().await.map_err(storage_error)?;
    drop(file);
    let destination = repo.root.join("objects").join(format!(
        "{}.{}",
        resolution.artifact_digest,
        format.extension()
    ));
    if destination.exists() {
        // Reuse only after verifying the previously stored immutable object too.
        let mut existing = tokio::fs::File::open(&destination)
            .await
            .map_err(storage_error)?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 65536];
        let mut length = 0u64;
        loop {
            let count = existing.read(&mut buffer).await.map_err(storage_error)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            length += count as u64;
        }
        if length != size
            || format!("{:x}", hash.finalize()) != resolution.artifact_digest.to_string()
        {
            return Err(invalid(
                "Stored installer verification failed. Restore the delivery repository from a verified backup.",
            ));
        }
    } else {
        temp.persist_noclobber(destination).map_err(storage_error)?;
    }
    Ok(VerifiedInstaller {
        digest: resolution.artifact_digest.clone(),
        size,
        format,
    })
}
pub async fn publish(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<PublishInput>,
) -> Result<HttpResponse, Failure> {
    let publisher = publisher(&request, &state).await?;
    let repo = repository(&state)?;
    if !input.reviewed {
        return Err(invalid(
            "Review the installer and installed-state detection before publishing.",
        ));
    }
    if input.spec.0.channel == Channel::Stable && !input.test_confirmed {
        return Err(invalid(
            "Confirm installation and a second successful detection check on a test Mac before publishing to stable.",
        ));
    }
    if repo.snapshot.lock().await.revision != input.expected_revision {
        return Err(stale());
    }
    let (software, resolution) = resolve(&publisher, &input).await?;
    let info = package_info(&input.spec, &software, &resolution)?;
    let verified = verified_download(repo, &publisher, &resolution, input.spec.0.format).await?;
    let mut current = repo.snapshot.lock().await;
    if current.revision != input.expected_revision {
        return Err(stale());
    }
    // Fresh authorization and resolution fence slow downloads and changed channel selections.
    let publisher = Publisher::authorize(&publisher.client).await?;
    let (current_software, current_resolution) = resolve(&publisher, &input).await?;
    if resolution != current_resolution || software != current_software {
        return Err(stale());
    }
    let mut raw_spec = input.spec.0.clone();
    raw_spec.format = verified.format;
    raw_spec.architecture = match resolution.variant.architecture.as_str() {
        "aarch64" => Architecture::Aarch64,
        "x86_64" => Architecture::X86_64,
        "universal" => Architecture::Universal,
        _ => return Err(invalid("Unsupported installer architecture.")),
    };
    let entry = Entry {
        spec: Spec::try_from(raw_spec).map_err(invalid)?,
        release: resolution.release.id,
        version: resolution.release.version,
        name: software.name,
        digest: verified.digest,
        size: verified.size,
        pkginfo: info,
        published_at: Utc::now().to_rfc3339(),
        tested: input.test_confirmed,
    };
    let mut next = current.clone();
    next.entries.retain(|_, old| {
        old.spec.0.software != entry.spec.0.software
            || old.spec.0.channel != entry.spec.0.channel
            || (old.spec.0.architecture != entry.spec.0.architecture
                && old.spec.0.architecture != Architecture::Universal
                && entry.spec.0.architecture != Architecture::Universal)
    });
    next.entries.insert(entry.key(), entry);
    if next.entries.len() > MAX_ENTRIES {
        return Err(invalid(
            "The repository supports at most 1000 published variants.",
        ));
    }
    repo.commit(&mut current, next, &publisher.actor, "published")?;
    Ok(
        HttpResponse::Ok()
            .json(json!({"revision":current.revision,"message":"Published to Munki"})),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveInput {
    release: ReleaseId,
    expected_revision: u64,
    reviewed: bool,
}
pub async fn remove(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<RemoveInput>,
) -> Result<HttpResponse, Failure> {
    let publisher = publisher(&request, &state).await?;
    let repo = repository(&state)?;
    if !input.reviewed {
        return Err(invalid("Confirm removal from all delivery channels."));
    }
    let mut current = repo.snapshot.lock().await;
    if current.revision != input.expected_revision {
        return Err(stale());
    }
    let mut next = current.clone();
    next.entries
        .retain(|_, entry| entry.release != input.release);
    repo.commit(
        &mut current,
        next,
        &publisher.actor,
        "removed from delivery",
    )?;
    Ok(HttpResponse::Ok().json(json!({"revision":current.revision})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    channel: Channel,
    software: Option<String>,
}
pub async fn profile(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<ProfileInput>,
) -> Result<HttpResponse, Failure> {
    publisher(&request, &state).await?;
    let repo = repository(&state)?;
    let manifest = if let Some(slug) = &input.software {
        if !repo
            .snapshot
            .lock()
            .await
            .entries
            .values()
            .any(|e| e.spec.0.software == *slug && e.spec.0.channel == input.channel)
        {
            return Err(invalid(
                "Publish this application before downloading its test Mac settings.",
            ));
        }
        slug.clone()
    } else {
        "site_default".into()
    };
    let preferences = json!({"SoftwareRepoURL":format!("{}/munki/{}",state.config.public.as_str(),input.channel.name()),"ClientIdentifier":manifest,"AdditionalHttpHeaders":[format!("Authorization: {}",repo.auth_header())],"InstallAppleSoftwareUpdates":false});
    // This is a credential download, never JSON rendered into the management UI.
    Ok(HttpResponse::Ok().insert_header((header::CONTENT_DISPOSITION,"attachment; filename=Stabbur-Munki.mobileconfig")).content_type("application/x-plist").body(xml(&json!({
        "PayloadType":"Configuration","PayloadVersion":1,"PayloadScope":"System","PayloadIdentifier":format!("org.stabbur.munki.{}",input.channel.name()),"PayloadUUID":profile_uuid(),"PayloadDisplayName":format!("Stabbur Munki {}",input.channel.name()),
        "PayloadContent":[{ "PayloadType":"com.googlecode.munki","PayloadVersion":1,"PayloadIdentifier":format!("org.stabbur.munki.{}.preferences",input.channel.name()),"PayloadUUID":profile_uuid(),
            "SoftwareRepoURL":preferences["SoftwareRepoURL"],"ClientIdentifier":preferences["ClientIdentifier"],"AdditionalHttpHeaders":preferences["AdditionalHttpHeaders"],"InstallAppleSoftwareUpdates":false }]
    }))?))
}
pub async fn serve(
    request: HttpRequest,
    state: web::Data<State>,
    path: web::Path<(Channel, String, String)>,
) -> Result<HttpResponse, Failure> {
    let repo = repository(&state)?;
    repo.authorize_reader(&request)?;
    let (channel, kind, name) = path.into_inner();
    let current = repo.snapshot.lock().await;
    let entries: Vec<_> = current
        .entries
        .values()
        .filter(|e| e.spec.0.channel == channel)
        .collect();
    let not_found = || Failure::new(StatusCode::NOT_FOUND, "not_found");
    match kind.as_str() {
        "catalogs" if name == channel.name() || name == "all" => Ok(HttpResponse::Ok()
            .content_type("application/x-plist")
            .body(xml(&json!(
                entries.iter().map(|e| &e.pkginfo).collect::<Vec<_>>()
            ))?)),
        "manifests" => {
            let mut software: Vec<_> = entries
                .iter()
                .filter(|e| name == "site_default" || e.spec.0.software == name)
                .map(|e| e.spec.0.software.clone())
                .collect();
            software.sort();
            software.dedup();
            if name != "site_default" && software.is_empty() {
                return Err(not_found());
            }
            let key = if name == "site_default" {
                "optional_installs"
            } else {
                "managed_installs"
            };
            Ok(HttpResponse::Ok()
                .content_type("application/x-plist")
                .body(xml(&json!({"catalogs":[channel.name()],key:software}))?))
        }
        "pkgs" => {
            let entry = entries
                .iter()
                .find(|e| e.filename() == name)
                .ok_or_else(not_found)?;
            let file = File::open(repo.root.join("objects").join(entry.filename()))
                .map_err(storage_error)?;
            let size = entry.size;
            drop(current);
            // Bounded chunks; no paths or credentials are included in errors.
            let stream = futures_util::stream::try_unfold(
                tokio::fs::File::from_std(file),
                |mut file| async move {
                    let mut bytes = vec![0u8; 65536];
                    let n = file.read(&mut bytes).await.map_err(|_| {
                        actix_web::error::ErrorServiceUnavailable("installer_read_failed")
                    })?;
                    if n == 0 {
                        Ok::<_, actix_web::Error>(None)
                    } else {
                        bytes.truncate(n);
                        Ok(Some((web::Bytes::from(bytes), file)))
                    }
                },
            );
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_LENGTH, size.to_string()))
                .content_type("application/octet-stream")
                .streaming(stream))
        }
        _ => Err(not_found()),
    }
}

fn profile_uuid() -> String {
    let text = format!("{:032x}", rand::random::<u128>());
    format!(
        "{}-{}-4{}-a{}-{}",
        &text[..8],
        &text[8..12],
        &text[13..16],
        &text[17..20],
        &text[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> Spec {
        serde_json::from_value(json!({"software":"example","channel":"testing","architecture":"aarch64","macos":"15.0","format":"pkg","detection":{"kind":"receipt","package_id":"org.example.app"}})).unwrap()
    }
    fn entry() -> Entry {
        Entry {
            spec: spec(),
            release: "01900000-0000-7000-8000-000000000001".parse().unwrap(),
            version: "1.0".into(),
            name: "Example".into(),
            digest: "a".repeat(64).parse().unwrap(),
            size: 4,
            pkginfo: json!({"name":"example","version":"1.0"}),
            published_at: Utc::now().to_rfc3339(),
            tested: false,
        }
    }
    #[test]
    fn persisted_and_incoming_settings_share_validation() {
        let good = serde_json::to_value(spec()).unwrap();
        for (key, value) in [
            ("software", json!("../escape")),
            ("architecture", json!("arm64")),
            ("macos", json!("15\nsecret")),
            ("channel", json!("other")),
            (
                "detection",
                json!({"kind":"receipt","package_id":"../escape"}),
            ),
            (
                "detection",
                json!({"kind":"application","name":"../A.app","bundle_id":"org.example"}),
            ),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(serde_json::from_value::<Spec>(bad).is_err());
        }
        let mut bad = good;
        bad["format"] = json!("dmg_app");
        assert!(serde_json::from_value::<Spec>(bad).is_err());
    }
    #[test]
    fn generated_plists_are_real_munki_dictionaries() {
        let bytes=xml(&json!({"name":"A&B","installs":[{"type":"application","path":"/Applications/A.app","CFBundleShortVersionString":"1.0"}],"catalogs":["testing"],"installer_item_size":12,"unattended_install":false})).unwrap();
        let value = plist::Value::from_reader_xml(bytes.as_slice()).unwrap();
        assert_eq!(
            value.as_dictionary().unwrap()["name"].as_string(),
            Some("A&B")
        );
        assert_eq!(
            value.as_dictionary().unwrap()["installer_item_size"].as_unsigned_integer(),
            Some(12)
        );
        assert_eq!(
            value.as_dictionary().unwrap()["unattended_install"].as_boolean(),
            Some(false)
        );
    }
    #[actix_web::test]
    async fn publication_history_survives_restart_and_withdrawal() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::open(temp.path()).unwrap();
        assert!(Repository::open(temp.path()).is_err());
        let original = entry();
        let mut current = repo.snapshot.lock().await;
        let mut next = current.clone();
        next.entries.insert(original.key(), original.clone());
        repo.commit(&mut current, next, "actor", "published")
            .unwrap();
        drop(current);
        let credential = repo.auth_header();
        drop(repo);
        let repo = Repository::open(temp.path()).unwrap();
        assert_eq!(repo.auth_header(), credential);
        assert_eq!(repo.snapshot.lock().await.entries.len(), 1);
        repo.withdraw(original.release, "actor").await.unwrap();
        assert!(repo.snapshot.lock().await.entries.is_empty());
        assert_eq!(
            fs::read_dir(temp.path().join("history")).unwrap().count(),
            2
        );
        drop(repo);
        assert!(
            Repository::open(temp.path())
                .unwrap()
                .snapshot
                .lock()
                .await
                .entries
                .is_empty()
        );
    }
    #[test]
    fn device_auth_requires_its_own_read_credential() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::open(temp.path()).unwrap();
        assert!(
            repo.authorize_reader(&actix_web::test::TestRequest::default().to_http_request())
                .is_err()
        );
        assert!(
            repo.authorize_reader(
                &actix_web::test::TestRequest::default()
                    .insert_header((header::AUTHORIZATION, "Bearer stabbur-admin-token"))
                    .to_http_request()
            )
            .is_err()
        );
        assert!(
            repo.authorize_reader(
                &actix_web::test::TestRequest::default()
                    .insert_header((header::AUTHORIZATION, repo.auth_header()))
                    .to_http_request()
            )
            .is_ok()
        );
    }
    #[actix_web::test]
    #[allow(clippy::too_many_lines)]
    async fn repository_http_denies_anonymous_traversal_and_withdrawn_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let repo = Repository::open(temp.path()).unwrap();
        let entry = entry();
        fs::write(temp.path().join("objects").join(entry.filename()), b"data").unwrap();
        let mut current = repo.snapshot.lock().await;
        let mut next = current.clone();
        next.entries.insert(entry.key(), entry.clone());
        repo.commit(&mut current, next, "actor", "published")
            .unwrap();
        drop(current);
        let auth = repo.auth_header();
        let state = web::Data::new(State {
            config: crate::security::Config {
                public: crate::security::Origin::parse("http://127.0.0.1:3333", true).unwrap(),
                upstream: crate::security::Origin::parse("http://127.0.0.1:9090", true).unwrap(),
                bind: "127.0.0.1:3333".parse().unwrap(),
                development: true,
            },
            public_client: Client::from_url("http://127.0.0.1:9090").unwrap(),
            sessions: crate::security::Sessions::default(),
            limiter: crate::security::LoginLimiter::default(),
            contract: serde_json::from_str(include_str!("../public/contract.json")).unwrap(),
            delivery: Some(repo),
        });
        let app = actix_web::test::init_service(
            actix_web::App::new()
                .app_data(state.clone())
                .configure(crate::routes),
        )
        .await;
        let anonymous = actix_web::test::call_service(
            &app,
            actix_web::test::TestRequest::get()
                .uri("/munki/testing/catalogs/testing")
                .to_request(),
        )
        .await;
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        for path in [
            "/munki/testing/catalogs/testing",
            "/munki/testing/manifests/example",
            "/munki/testing/manifests/site_default",
        ] {
            let response = actix_web::test::call_service(
                &app,
                actix_web::test::TestRequest::get()
                    .uri(path)
                    .insert_header((header::AUTHORIZATION, auth.clone()))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = actix_web::test::read_body(response).await;
            assert!(plist::Value::from_reader_xml(bytes.as_ref()).is_ok());
        }
        for path in [
            "/munki/testing/pkgs/%2e%2e%2freader",
            "/munki/testing/private/reader",
            "/munki/testing/manifests/unknown",
        ] {
            let response = actix_web::test::call_service(
                &app,
                actix_web::test::TestRequest::get()
                    .uri(path)
                    .insert_header((header::AUTHORIZATION, auth.clone()))
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        state
            .delivery
            .as_ref()
            .unwrap()
            .withdraw(entry.release, "actor")
            .await
            .unwrap();
        let response = actix_web::test::call_service(
            &app,
            actix_web::test::TestRequest::get()
                .uri(&format!("/munki/testing/pkgs/{}", entry.filename()))
                .insert_header((header::AUTHORIZATION, auth))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
