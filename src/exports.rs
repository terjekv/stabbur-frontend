//! Session-protected export attachments and a narrowly scoped device repository proxy.
use super::{
    Deserialize, Failure, HttpRequest, HttpResponse, State, StatusCode, TryStreamExt, header, json,
    web,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use stabbur_client::{
    ExportId, SecretToken,
    exports::{ExportPlan, MaterializableExport, RepositoryKind},
};
use std::io::{Seek, SeekFrom};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn xml(value: &serde_json::Value) -> Result<Vec<u8>, Failure> {
    let value: plist::Value =
        serde_json::from_value(value.clone()).map_err(|_| Failure::upstream())?;
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|_| Failure::upstream())?;
    Ok(bytes)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    reviewed: bool,
    #[serde(default)]
    test_all: bool,
}
pub async fn profile(
    request: HttpRequest,
    state: web::Data<State>,
    id: web::Path<ExportId>,
    input: web::Json<ProfileInput>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    if !input.reviewed {
        return Err(Failure::bad_request("review_required"));
    }
    let record = session.client().exports().get(&id.to_string()).await?;
    let reader = session
        .client()
        .exports()
        .issue_reader(&id.to_string())
        .await?;
    let repo = format!("{}/munki/exports/{}", state.config.public.as_str(), id);
    let identifier = format!("org.stabbur.export.{id}");
    let auth = STANDARD.encode(format!("stabbur:{}", reader.token.expose_secret()));
    let preferences = json!({"PayloadType":"ManagedInstalls","PayloadVersion":1,"PayloadIdentifier":format!("{identifier}.preferences"),"PayloadUUID":super::delivery::profile_uuid(),"SoftwareRepoURL":repo,"ClientIdentifier":if input.test_all {"test-all"}else{"site_default"},"AdditionalHttpHeaders":[format!("Authorization: Basic {auth}")],"InstallAppleSoftwareUpdates":false});
    let data = xml(
        &json!({"PayloadType":"Configuration","PayloadVersion":1,"PayloadScope":"System","PayloadIdentifier":identifier,"PayloadUUID":super::delivery::profile_uuid(),"PayloadDisplayName":format!("Stabbur · {}",record.definition.data().name),"PayloadContent":[preferences]}),
    )?;
    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .insert_header((
            header::CONTENT_DISPOSITION,
            "attachment; filename=Stabbur-Munki.mobileconfig",
        ))
        .content_type("application/x-plist")
        .body(data))
}
pub async fn apply(
    request: HttpRequest,
    state: web::Data<State>,
    input: web::Json<ExportPlan>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    session.mutation(&request, &state.config.public)?;
    Ok(HttpResponse::Ok().json(session.client().exports().apply(&input).await?))
}
pub async fn serve(
    request: HttpRequest,
    state: web::Data<State>,
    path: web::Path<(ExportId, String, String)>,
) -> Result<HttpResponse, Failure> {
    let kind = match path.1.as_str() {
        "catalogs" => RepositoryKind::Catalogs,
        "manifests" => RepositoryKind::Manifests,
        "pkgsinfo" => RepositoryKind::Pkgsinfo,
        "pkgs" => RepositoryKind::Pkgs,
        _ => return Err(Failure::new(StatusCode::NOT_FOUND, "not_found")),
    };
    let secret = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .filter(|s| s.len() < 512)
        .and_then(|v| STANDARD.decode(v).ok())
        .and_then(|v| String::from_utf8(v).ok())
        .and_then(|v| v.strip_prefix("stabbur:").map(str::to_owned))
        .ok_or_else(Failure::unauthorized)?;
    let token = SecretToken::new(secret)?;
    let download = state
        .public_client
        .export_repository(&path.0.to_string(), kind, &path.2, &token)
        .await?;
    let mut response = HttpResponse::Ok();
    response.insert_header((header::CACHE_CONTROL, "no-store"));
    if let Some(size) = download.content_length {
        response.insert_header((header::CONTENT_LENGTH, size));
    }
    Ok(response
        .content_type(if matches!(kind, RepositoryKind::Pkgs) {
            "application/octet-stream"
        } else {
            "application/x-plist"
        })
        .streaming(
            download
                .into_stream()
                .map_err(|_| actix_web::error::ErrorBadGateway("repository_stream_failed")),
        ))
}
/// Assemble into a private temporary directory; expose the archive only after every checksum and a fresh eligibility check.
#[allow(clippy::too_many_lines)] // Bounded download, verification and archive publication form one operation.
pub async fn bundle(
    request: HttpRequest,
    state: web::Data<State>,
    path: web::Path<(ExportId, u64)>,
) -> Result<HttpResponse, Failure> {
    let session = state.sessions.authenticate(&request, &state.config)?;
    let checked = MaterializableExport::try_from(
        session
            .client()
            .exports()
            .snapshot(&path.0.to_string(), path.1)
            .await?,
    )?;
    let view = checked.view();
    let temp = tempfile::tempdir().map_err(|_| Failure::upstream())?;
    let root = temp.path().join("repository");
    for name in ["pkgs", "pkgsinfo", "catalogs"] {
        tokio::fs::create_dir_all(root.join(name))
            .await
            .map_err(|_| Failure::upstream())?;
    }
    let mut seen = std::collections::BTreeSet::new();
    for (item, info) in view.snapshot.items.iter().zip(&view.pkginfo) {
        tokio::fs::write(root.join("pkgsinfo").join(item.pkginfo_name()), xml(info)?)
            .await
            .map_err(|_| Failure::upstream())?;
        if !seen.insert(item.installer_name()) {
            continue;
        }
        let mut file = tokio::fs::File::create(root.join("pkgs").join(item.installer_name()))
            .await
            .map_err(|_| Failure::upstream())?;
        let mut stream = session
            .client()
            .artifacts()
            .download(&item.digest, None)
            .await?
            .into_stream();
        let mut hash = Sha256::new();
        let mut size = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or_else(Failure::upstream)?;
            if size > item.size {
                return Err(Failure::upstream());
            }
            hash.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| Failure::upstream())?;
        }
        if size != item.size || format!("{:x}", hash.finalize()) != item.digest.as_str() {
            return Err(Failure::upstream());
        }
        file.flush().await.map_err(|_| Failure::upstream())?;
    }
    let catalog = xml(&json!(view.pkginfo))?;
    tokio::fs::write(
        root.join("catalogs")
            .join(view.snapshot.definition.data().catalog.as_str()),
        &catalog,
    )
    .await
    .map_err(|_| Failure::upstream())?;
    tokio::fs::write(root.join("catalogs/all"), catalog)
        .await
        .map_err(|_| Failure::upstream())?;
    tokio::fs::write(
        root.join("export.json"),
        serde_json::to_vec_pretty(&view.snapshot).map_err(|_| Failure::upstream())?,
    )
    .await
    .map_err(|_| Failure::upstream())?;
    // These files intentionally contain no manifests: the destination operator owns assignments.
    MaterializableExport::try_from(
        session
            .client()
            .exports()
            .snapshot(&path.0.to_string(), path.1)
            .await?,
    )?;
    let (file, temp) = tokio::task::spawn_blocking(move || -> Result<_, Failure> {
        let mut file = tempfile::tempfile().map_err(|_| Failure::upstream())?;
        {
            let mut archive = tar::Builder::new(&mut file);
            archive
                .append_dir_all("repository", root)
                .map_err(|_| Failure::upstream())?;
            archive.finish().map_err(|_| Failure::upstream())?;
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| Failure::upstream())?;
        Ok((file, temp))
    })
    .await
    .map_err(|_| Failure::upstream())??;
    let size = file.metadata().map_err(|_| Failure::upstream())?.len();
    let stream = futures_util::stream::try_unfold(
        (tokio::fs::File::from_std(file), temp),
        |(mut file, temp)| async move {
            let mut buffer = vec![0u8; 65536];
            let size = file
                .read(&mut buffer)
                .await
                .map_err(|_| actix_web::error::ErrorInternalServerError("archive_read_failed"))?;
            if size == 0 {
                Ok::<_, actix_web::Error>(None)
            } else {
                buffer.truncate(size);
                Ok(Some((web::Bytes::from(buffer), (file, temp))))
            }
        },
    );
    Ok(HttpResponse::Ok()
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=stabbur-export-{}-{}.tar",
                path.0, path.1
            ),
        ))
        .insert_header((header::CONTENT_LENGTH, size))
        .content_type("application/x-tar")
        .streaming(stream))
}
