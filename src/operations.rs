//! A private proof of a reviewed operation with validated path/query and preconditions.
use crate::Failure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use stabbur_client::{RawMethod, RawRequest};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize)]
pub struct Contract {
    pub operations: Vec<Operation>,
}
#[derive(Deserialize, Serialize)]
pub struct Operation {
    pub id: String,
    method: String,
    path: String,
    parameters: Vec<Parameter>,
    body: Option<Value>,
    body_required: bool,
    pub credential_download: bool,
}
#[derive(Deserialize, Serialize)]
struct Parameter {
    name: String,
    #[serde(rename = "in")]
    location: String,
    #[serde(default)]
    required: bool,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct OperationInput {
    #[serde(default)]
    parameters: BTreeMap<String, String>,
    #[serde(default)]
    query: BTreeMap<String, String>,
    body: Option<Value>,
    revision: Option<u64>,
    idempotency_key: Option<String>,
}

impl OperationInput {
    fn withdrawn_release(&self, id: &str) -> Result<Option<stabbur_client::ReleaseId>, Failure> {
        Ok(if id == "withdraw_release" {
            Some(
                self.parameters
                    .get("release")
                    .ok_or_else(|| Failure::bad_request("missing_parameter"))?
                    .parse()
                    .map_err(Failure::from)?,
            )
        } else {
            None
        })
    }
}

/// Zero proves an absent channel binding; other operations require an observed positive revision.
enum RevisionPrecondition {
    AbsentChannel,
    Current(std::num::NonZeroU64),
}
impl RevisionPrecondition {
    fn resolve(value: u64, operation: &str) -> Result<Self, Failure> {
        match std::num::NonZeroU64::new(value) {
            Some(value) => Ok(Self::Current(value)),
            None if operation == "promote_channel" => Ok(Self::AbsentChannel),
            None => Err(Failure::bad_request("invalid_revision")),
        }
    }
    fn number(&self) -> u64 {
        match self {
            Self::AbsentChannel => 0,
            Self::Current(value) => value.get(),
        }
    }
}

pub struct ValidatedOperation {
    request: RawRequest,
    credential_download: bool,
    withdrawn_release: Option<stabbur_client::ReleaseId>,
}
impl ValidatedOperation {
    pub fn resolve(contract: &Contract, id: &str, input: OperationInput) -> Result<Self, Failure> {
        let withdrawn_release = input.withdrawn_release(id)?;
        let operation = contract
            .operations
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| Failure::bad_request("unknown_operation"))?;
        for (values, location) in [(&input.parameters, "path"), (&input.query, "query")] {
            if values.len() > 32
                || values.keys().any(|key| {
                    !operation
                        .parameters
                        .iter()
                        .any(|parameter| parameter.location == location && parameter.name == *key)
                })
            {
                return Err(Failure::bad_request("unknown_parameter"));
            }
            for parameter in operation
                .parameters
                .iter()
                .filter(|parameter| parameter.location == location && parameter.required)
            {
                if !values.contains_key(&parameter.name) {
                    return Err(Failure::bad_request("missing_parameter"));
                }
            }
        }
        if (operation.body_required && input.body.is_none())
            || (operation.body.is_none() && input.body.is_some())
        {
            return Err(Failure::bad_request("invalid_body"));
        }
        for parameter in &operation.parameters {
            if parameter.location == "header" {
                match parameter.name.to_ascii_lowercase().as_str() {
                    "if-match" if input.revision.is_none() => {
                        return Err(Failure::bad_request("revision_required"));
                    }
                    "idempotency-key" if input.idempotency_key.is_none() => {
                        return Err(Failure::bad_request("idempotency_key_required"));
                    }
                    _ => (),
                }
            }
        }
        let segments = operation
            .path
            .split('/')
            .map(|part| {
                let value = if let Some(key) = part
                    .strip_prefix('{')
                    .and_then(|part| part.strip_suffix('}'))
                {
                    input
                        .parameters
                        .get(key)
                        .ok_or_else(|| Failure::bad_request("missing_parameter"))?
                        .as_str()
                } else {
                    part
                };
                if value.is_empty()
                    || value.len() > 256
                    || value == "."
                    || value == ".."
                    || value.chars().any(char::is_control)
                {
                    return Err(Failure::bad_request("invalid_parameter"));
                }
                Ok(value.to_owned())
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        let method = match operation.method.as_str() {
            "get" => RawMethod::Get,
            "post" => RawMethod::Post,
            "put" => RawMethod::Put,
            "patch" => RawMethod::Patch,
            "delete" => RawMethod::Delete,
            _ => return Err(Failure::bad_request("unsupported_operation")),
        };
        let mut request = RawRequest::new(method, segments).map_err(Failure::from)?;
        for (key, value) in input.query {
            request = request.query(&key, &value).map_err(Failure::from)?;
        }
        if let Some(body) = input.body {
            request = request.json(body);
        }
        if let Some(revision) = input.revision {
            let precondition = RevisionPrecondition::resolve(revision, &operation.id)?;
            request = request.revision(precondition.number());
        }
        if let Some(key) = input.idempotency_key {
            request = request.idempotency_key(&key).map_err(Failure::from)?;
        }
        Ok(Self {
            request,
            credential_download: operation.credential_download,
            withdrawn_release,
        })
    }
    pub fn withdrawn_release(&self) -> Option<stabbur_client::ReleaseId> {
        self.withdrawn_release
    }
    pub fn request(&self) -> &RawRequest {
        &self.request
    }
    pub fn credential_download(&self) -> bool {
        self.credential_download
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn contract() -> Contract {
        serde_json::from_str(include_str!("../public/contract.json")).unwrap()
    }
    #[test]
    fn gateway_cannot_select_internal_paths_headers_or_unknown_operations() {
        for id in [
            "bootstrap",
            "login",
            "stream_run_events",
            "internal",
            "http://evil",
        ] {
            assert!(
                ValidatedOperation::resolve(&contract(), id, OperationInput::default()).is_err()
            );
        }
        assert!(
            serde_json::from_value::<OperationInput>(
                serde_json::json!({"headers":{"authorization":"secret"}})
            )
            .is_err()
        );
        let mut input = OperationInput::default();
        input.parameters.insert("software".into(), "..".into());
        assert!(ValidatedOperation::resolve(&contract(), "get_software", input).is_err());
        let mut input = OperationInput::default();
        input.query.insert("url".into(), "http://evil".into());
        assert!(ValidatedOperation::resolve(&contract(), "list_software", input).is_err());
    }
    #[test]
    fn mutation_requires_the_reviewed_revision_and_credentials_download() {
        let input = serde_json::from_value(
            serde_json::json!({"parameters":{"worker":"worker-id"},"body":{"draining":true}}),
        )
        .unwrap();
        assert!(ValidatedOperation::resolve(&contract(), "drain_worker", input).is_err());
        assert!(
            contract()
                .operations
                .iter()
                .filter(|op| [
                    "create_api_token",
                    "provision_worker",
                    "rotate_worker_token"
                ]
                .contains(&op.id.as_str()))
                .all(|op| op.credential_download)
        );
    }
}
