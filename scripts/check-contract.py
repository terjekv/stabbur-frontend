#!/usr/bin/env python3
"""Generate/check the explicit browser gateway surface from the pinned public contract."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Each exclusion has a dedicated transport or deliberately belongs outside this console.
EXCLUDED = {
    'bootstrap': 'Bootstrap remains a local server administration operation.',
    'login': 'Dedicated login endpoint; credentials never pass through the gateway.',
    'me': 'Dedicated session endpoint.',
    'openapi_document': 'Contract is pinned at build time.',
    'healthz': 'Not an authenticated management operation.',
    'readyz': 'Not an authenticated management operation.',
    'stream_run_events': 'The console uses bounded paginated run logs.',
    'download_artifact_content': 'Dedicated streaming download endpoint.',
    'upload_artifact_content': 'Binary uploads use the CLI; builds publish through workers.',
    'head_artifact_content': 'Metadata is available through get_artifact.',
}
CREDENTIALS = {'create_api_token', 'provision_worker', 'rotate_worker_token'}

def generated(document):
    operations = []
    for path, methods in sorted(document['paths'].items()):
        for method, operation in sorted(methods.items()):
            identity = operation['operationId']
            if identity in EXCLUDED:
                continue
            if not path.startswith('/api/v1/') or not operation.get('security'):
                raise ValueError(f'Unreviewed public operation: {identity}')
            parameters = operation.get('parameters', [])
            content = operation.get('requestBody', {}).get('content', {})
            if content and set(content) != {'application/json'}:
                raise ValueError(f'Unsupported transport: {identity}')
            operations.append(dict(id=identity, method=method, path=path.removeprefix('/api/v1/'),
                parameters=parameters, body=content.get('application/json', {}).get('schema'),
                body_required=operation.get('requestBody', {}).get('required', False),
                credential_download=identity in CREDENTIALS, tag=operation.get('tags', ['management'])[0],
                summary=operation.get('summary', identity.replace('_', ' '))))
    return {'operations': operations, 'schemas': document['components']['schemas'], 'excluded': EXCLUDED,
            'contract_sha256': hashlib.sha256((ROOT / 'contract/openapi.json').read_bytes()).hexdigest()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--update', action='store_true')
    args = parser.parse_args()
    encoded = json.dumps(generated(json.loads((ROOT / 'contract/openapi.json').read_text())), indent=2, sort_keys=True) + '\n'
    destination = ROOT / 'public/contract.json'
    if args.update:
        destination.write_text(encoded)
    elif destination.read_text() != encoded:
        raise SystemExit('Gateway contract drift; review then run --update')
    print('Gateway contract is synchronized')
