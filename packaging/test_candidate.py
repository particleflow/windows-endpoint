import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('candidate', ROOT / 'packaging/build_candidate.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='endpoint-package-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.producer = self.root / 'producer'
        self.producer.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        (self.source / 'LICENSE').write_bytes((ROOT / 'LICENSE').read_bytes())
        self.pin = self.commit('synthetic producer license')
        for name in (*pack.RUNTIME_FILES, *pack.TEMPLATES, 'packaging/build_runtime_host.mjs'):
            destination = self.source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        catalog = json.loads((self.source / 'dependencies.json').read_bytes())
        catalog['components']['transfer']['revision'] = self.pin
        catalog['nativeRuntime']['revision'] = self.pin
        (self.source / 'dependencies.json').write_text(json.dumps(catalog), encoding='utf-8')
        self.head = self.commit('synthetic candidate source')
        entries = []
        for name in pack.PRODUCER_FILES:
            # Inert test bytes; never a qualified or executed Windows binary.
            data = b'MZ INERT TEST FILE' if name.endswith('.exe') else b'SYNTHETIC REVIEW INPUT'
            (self.producer / name).write_bytes(data)
            entries.append({'name': name, 'sha256': pack.sha(data)})
        (self.producer / 'SHA256SUMS.json').write_text(json.dumps({'source_commit': self.pin, 'arch': 'amd64', 'files': entries}), encoding='utf-8')
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        # Inert package boundary only. No official Runtime connection is made.
        runtime_files = {
            'package.json': json.dumps({'name': '@memohai/runtime', 'version': '0.22.0'}).encode(),
            'LICENSE': b'SYNTHETIC LICENSE',
            'dist/cli.mjs': b"if (process.argv[2] === 'version') console.log('0.22.0'); else process.exitCode = 2;\n",
            'dist/index.mjs': b'export class RuntimeSession {}\n',
            'dist/endpoint-host-api.mjs': b'// INERT ENDPOINT ENTRY\n',
            'dist/index.d.ts': b'export declare class RuntimeSession {}\n',
            'dist/bridge.proto': b'INERT PROTOCOL FIXTURE\n',
        }
        entries = []
        for name, data in runtime_files.items():
            target = self.runtime / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entries.append({'path': name, 'size': len(data), 'sha256': pack.sha(data)})
        (self.runtime / 'SHA256SUMS.json').write_text(json.dumps({'schema': 1, 'kind': 'memoh-runtime-source-build', 'source_repository': 'particleflow/Memoh', 'source_commit': self.pin,
            'package_name': '@memohai/runtime', 'package_version': '0.22.0',
            'endpoint_adapter': {'recipe': 'packaging/build_runtime_host.mjs', 'sha256': pack.sha((self.source / 'packaging/build_runtime_host.mjs').read_bytes().replace(b'\r\n', b'\n'))},
            'files': entries}), encoding='utf-8')

    def commit(self, message):
        subprocess.run(['git', '-C', str(self.source), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.source), '-c', 'user.name=Package Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], check=True)
        return pack.git(self.source, 'rev-parse', 'HEAD').decode().strip()

    def build(self, name='out'):
        return pack.build(self.source, self.head, self.producer, self.source, self.root / name, self.runtime)

    def test_reproducible_archive_runs_existing_entry_without_checkout_or_npm(self):
        (self.source / 'credentials.json').write_text('SYNTHETIC EXCLUDED USER INPUT', encoding='utf-8')
        a, b = self.build('a'), self.build('b')
        self.assertEqual(a, b)
        archive = self.root / 'a' / a['archive']
        with zipfile.ZipFile(archive) as zipped:
            names = zipped.namelist()
            self.assertNotIn('credentials.json', names)
            self.assertFalse(any(name.startswith(('node_modules/', 'herdr/', 'git/', 'official-smoke/')) for name in names))
            manifest = json.loads(zipped.read('candidate.json'))
            self.assertEqual(manifest['source_commit'], self.head)
            self.assertEqual(manifest['positive_production_tls'], 'unverified')
            self.assertEqual(manifest['native_runtime']['commit'], self.pin)
            self.assertTrue(manifest['native_transfer_directory_pair'])
            self.assertTrue(manifest['native_transfer_direct_cli'])
            self.assertTrue(manifest['native_runtime_project_root'])
            self.assertIn('runtime-connector/dist/cli.mjs', names)
            self.assertEqual(set(names), {f['path'] for f in manifest['files']} | {'candidate.json'})
            for entry in manifest['files']:
                data = zipped.read(entry['path'])
                self.assertEqual(len(data), entry['size'])
                self.assertEqual(pack.sha(data), entry['sha256'])
            extracted = self.root / 'extracted Unicode 空格'
            zipped.extractall(extracted)
        result = subprocess.run(['node', str(extracted / 'endpoint.mjs'), 'help'], cwd=self.root, capture_output=True, text=True, timeout=15, check=True)
        self.assertIn('host run --root DIR', json.loads(result.stdout)['commands'])
        self.assertEqual(pack.sha(archive.read_bytes()), a['sha256'])
        checked = subprocess.run(['node', str(ROOT / 'packaging/verify_candidate.mjs'), str(extracted), str(self.root / 'a/candidate-summary.json')], cwd=self.root, capture_output=True, text=True, timeout=25)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(json.loads(checked.stdout)['passed'], 8)

    def test_changed_source_and_producer_are_rejected_without_output(self):
        file = self.source / 'host.mjs'
        original = file.read_bytes()
        file.write_bytes(original + b'\n// uncommitted\n')
        with self.assertRaisesRegex(ValueError, 'differs from exact commit'):
            self.build()
        self.assertFalse((self.root / 'out').exists())
        file.write_bytes(original)
        (self.producer / 'transferqueue.exe').write_bytes(b'MZ CHANGED')
        with self.assertRaisesRegex(ValueError, 'producer hash mismatch'):
            self.build()
        self.assertFalse((self.root / 'out').exists())

    def test_extra_producer_files_and_existing_output_are_not_adopted(self):
        extra = self.producer / 'device.credential'
        extra.write_text('SYNTHETIC EXCLUDED INPUT', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'unexpected producer files'):
            self.build()
        extra.unlink()
        summary = self.build()
        archive = self.root / 'out' / summary['archive']
        before = archive.read_bytes()
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(archive.read_bytes(), before)

    def test_runtime_payload_tamper_extra_secret_and_wrong_source_are_rejected(self):
        extra = self.runtime / 'credentials.json'
        extra.write_bytes(b'EXCLUDED SYNTHETIC INPUT')
        with self.assertRaisesRegex(ValueError, 'unexpected Runtime files'):
            self.build()
        extra.unlink()
        original = (self.runtime / 'dist/cli.mjs').read_bytes()
        (self.runtime / 'dist/cli.mjs').write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, 'Runtime hash mismatch'):
            self.build()
        (self.runtime / 'dist/cli.mjs').write_bytes(original)
        proof_file = self.runtime / 'SHA256SUMS.json'
        proof = json.loads(proof_file.read_bytes())
        proof['source_commit'] = '0' * 40
        proof_file.write_text(json.dumps(proof), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Runtime source/version mismatch'):
            self.build()
        self.assertFalse((self.root / 'out').exists())


if __name__ == '__main__':
    unittest.main()
