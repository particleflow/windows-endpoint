#!/usr/bin/env python3
"""Package the existing foreground launcher and unchanged producer review bundle.

Build-time only: no downloads, installer, activation, credential or trust changes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

RUNTIME_FILES = (
    'endpoint.mjs', 'endpoint.ps1', 'WindowsEndpoint.ps1', 'product-installation.mjs', 'host.mjs', 'runtime.mjs', 'installed.mjs',
    'pi-catalog-sync.mjs', 'pi-magpie-catalog.mjs',
    'pi-magpie-native-extension.mjs', 'pi-magpie-native-profile-entry.mjs', 'pi-native-catalog-profile.mjs',
    'pi-native-catalog-transaction.mjs', 'producer-upgrade.mjs',
    'native-connector.mjs', 'native-connector-child.mjs', 'setup.mjs', 'host-recovery.mjs', 'host-recovery.ps1',
    'directory-selection.mjs', 'directory-selection.ps1',
    'lifecycle.mjs', 'handoff.mjs', 'owned-herdr.ps1', 'session-continuation.mjs',
    'session-diagnostics.mjs', 'transfer-contract.mjs', 'transfer-lifecycle.mjs',
    'deployment.mjs', 'deployment-layout.json', 'candidate.mjs', 'program-deployment.mjs', 'dependencies.json', 'LICENSE',
)
PRODUCER_FILES = (
    'README.md', 'herdr-plugin.toml', 'transfer.example.json',
    'transferqueue-cli.test.exe', 'transferqueue.exe', 'transferqueue.test.exe',
    'verify-fixtures.ps1',
)
TEMPLATES = {
    'packaging/README.md': 'README.md',
    'packaging/runtime.example.json': 'examples/runtime.example.json',
    'packaging/endpoint.native-runtime.example.json': 'examples/endpoint.native-runtime.example.json',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def committed(root, commit, name):
    data = git(root, 'show', f'{commit}:{name}')
    file = root / name
    if file.is_symlink() or not file.is_file() or file.read_bytes().replace(b'\r\n', b'\n') != data.replace(b'\r\n', b'\n'):
        raise ValueError(f'packaged source differs from exact commit: {name}')
    return data


def runtime_payload(root, pin):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('unsafe Runtime root')
    for item in root.rglob('*'):
        if item.is_symlink():
            raise ValueError('linked Runtime payload')
    proof_file = root / 'SHA256SUMS.json'
    if proof_file.is_symlink() or not proof_file.is_file() or proof_file.stat().st_nlink != 1:
        raise ValueError('unsafe Runtime proof')
    proof_bytes = proof_file.read_bytes()
    proof = json.loads(proof_bytes)
    if (proof.get('schema') != 1 or proof.get('kind') != 'memoh-runtime-source-build'
            or proof.get('source_repository') != 'particleflow/Memoh' or proof.get('source_commit') != pin['revision']
            or proof.get('package_name') != '@memohai/runtime' or proof.get('package_version') != pin['version']):
        raise ValueError('Runtime source/version mismatch')
    files = proof.get('files')
    if not isinstance(files, list) or not files or len(files) > 200:
        raise ValueError('Runtime inventory invalid')
    payload = {}
    for entry in files:
        name = entry.get('path', '')
        if (not isinstance(name, str) or '\\' in name or name.startswith('/')
                or any(not part or part in ('.', '..') for part in name.split('/'))
                or name in payload or not (name in ('package.json', 'LICENSE') or name.startswith('dist/'))):
            raise ValueError('Runtime inventory path invalid')
        file = root / name
        if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise ValueError('unsafe Runtime payload')
        data = file.read_bytes()
        if sha(data) != entry.get('sha256') or len(data) != entry.get('size'):
            raise ValueError('Runtime hash mismatch')
        payload[name] = data
    if not {'package.json', 'LICENSE', 'dist/cli.mjs', 'dist/index.mjs', 'dist/index.d.ts', 'dist/bridge.proto', 'dist/endpoint-host-api.mjs'} <= payload.keys():
        raise ValueError('Runtime entry missing')
    actual = []
    for file in root.rglob('*'):
        if file.is_symlink():
            raise ValueError('linked Runtime payload')
        if file.is_file():
            actual.append(file.relative_to(root).as_posix())
    if sorted(actual) != sorted([*payload, 'SHA256SUMS.json']):
        raise ValueError('unexpected Runtime files')
    metadata = json.loads(payload['package.json'])
    if metadata.get('name') != '@memohai/runtime' or metadata.get('version') != pin['version']:
        raise ValueError('Runtime package metadata mismatch')
    payload['SHA256SUMS.json'] = proof_bytes
    return {f'runtime-connector/{name}': data for name, data in payload.items()}


def build(source, commit, producer, producer_source, output, native_runtime=None):
    if len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('full source commit required')
    payload = {name: committed(source, commit, name) for name in RUNTIME_FILES}
    payload.update({destination: committed(source, commit, name) for name, destination in TEMPLATES.items()})
    catalog = json.loads(payload['dependencies.json'])
    native = catalog.get('nativeRuntime')
    if native:
        if native_runtime is None:
            raise ValueError('fixed-source Runtime build required')
        runtime = runtime_payload(native_runtime, native)
        proof = json.loads(runtime['runtime-connector/SHA256SUMS.json'])
        recipe = 'packaging/build_runtime_host.mjs'
        if proof.get('endpoint_adapter') != {'recipe': recipe, 'sha256': sha(committed(source, commit, recipe).replace(b'\r\n', b'\n'))}:
            raise ValueError('Runtime endpoint adapter recipe mismatch')
        payload.update(runtime)
    pin = catalog['components']['transfer']['revision']
    proof_file = producer / 'SHA256SUMS.json'
    if proof_file.is_symlink():
        raise ValueError('linked producer proof')
    proof_bytes = proof_file.read_bytes()
    proof = json.loads(proof_bytes)
    if proof['source_commit'] != pin or proof['arch'] != 'amd64':
        raise ValueError('producer source or architecture mismatch')
    entries = proof['files']
    if len(entries) != len(PRODUCER_FILES) or sorted(e['name'] for e in entries) != sorted(PRODUCER_FILES):
        raise ValueError('producer inventory mismatch')
    if sorted(p.name for p in producer.iterdir()) != sorted((*PRODUCER_FILES, 'SHA256SUMS.json')):
        raise ValueError('unexpected producer files')
    for entry in entries:
        file = producer / entry['name']
        if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise ValueError('unsafe producer file')
        data = file.read_bytes()
        if sha(data) != entry['sha256']:
            raise ValueError('producer hash mismatch')
        if file.suffix == '.exe' and not data.startswith(b'MZ'):
            raise ValueError('Windows producer executable required')
        payload[f'transfer/{file.name}'] = data
    payload['transfer/SHA256SUMS.json'] = proof_bytes
    # Keep the complete existing producer inventory. Its test executables are
    # identified as review tools, never presented as additional product services.
    payload['licenses/Memoh-LICENSE'] = git(producer_source, 'show', f'{pin}:LICENSE')
    manifest = {
        'schema': 1,
        'kind': 'portable-existing-installations-review',
        'qualification': 'not-for-production-release',
        'source_repository': 'particleflow/windows-endpoint',
        'source_commit': commit,
        'producer_repository': 'particleflow/Memoh',
        'producer_commit': pin,
        'platform': 'win32-x64',
        'entry': 'endpoint.mjs',
        'official_components': 'referenced-existing-installations-not-bundled',
        'producer_test_tools': ['transfer/transferqueue.test.exe', 'transfer/transferqueue-cli.test.exe', 'transfer/verify-fixtures.ps1'],
        'positive_production_tls': 'unverified',
        'activation_update_rollback': 'stopped-endpoint-program-only',
        'workspace_unc_source_root': True,
        'central_component_data': True,
        'stable_installation_entry': 1,
        'state_profile': 'endpoint-program-v1',
        'native_pi_catalog': {'schema': 1, 'mode': 'pi-in-process', 'piVersion': '1.4.0',
                              'entry': 'pi-magpie-native-profile-entry.mjs',
                              'settingsKey': 'windowsEndpointPiCatalog', 'legacyFileSync': False,
                              'bindingVersion': 1, 'profileReference': 'extensions/windows-endpoint-magpie.js'},
        'files': [{'path': name, 'size': len(data), 'sha256': sha(data)} for name, data in sorted(payload.items())],
    }
    if native:
        manifest['native_runtime'] = {'repository': 'particleflow/Memoh', 'commit': native['revision'], 'version': native['version'],
                                      'entry': native['entry'], 'provenance': 'runtime-connector/SHA256SUMS.json'}
        manifest['native_transfer_directory_pair'] = True
        manifest['native_transfer_direct_cli'] = True
        manifest['native_runtime_project_root'] = True
        manifest['native_running_recovery'] = True
        manifest['native_stopped_observation_recovery'] = True
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    payload['candidate.json'] = manifest_bytes
    output.mkdir(parents=True, exist_ok=False)
    archive_name = f'windows-endpoint-review-{commit[:12]}-win32-x64.zip'
    archive = output / archive_name
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, data)
    summary = {
        'schema': 1, 'source_commit': commit, 'producer_commit': pin,
        'archive': archive_name, 'sha256': sha(archive.read_bytes()),
        'size_bytes': archive.stat().st_size, 'files': len(payload),
        'manifest_sha256': sha(manifest_bytes),
        'qualification': manifest['qualification'],
        'positive_production_tls': 'unverified',
    }
    if native:
        summary['native_runtime_commit'] = native['revision']
    (output / 'candidate-summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.cwd())
    parser.add_argument('--commit', required=True)
    parser.add_argument('--producer', type=Path, required=True)
    parser.add_argument('--producer-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-runtime', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.commit, args.producer, args.producer_source, args.output, args.native_runtime)))
