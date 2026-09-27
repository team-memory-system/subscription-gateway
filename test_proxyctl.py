import io
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import proxyctl

class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for key in ['ROOT', 'STATE', 'AGENTS']:
            folder = root / key
            folder.mkdir()
            p = patch.object(proxyctl, key, folder)
            p.start(); self.addCleanup(p.stop)
        self.label, self.legacy, _, _ = proxyctl.SERVICES['codex']
        self.old = proxyctl.AGENTS / (self.legacy + '.plist')
        self.previous = plistlib.dumps({'Label': self.legacy, 'ProgramArguments':['node','old.mjs'], 'EnvironmentVariables':{'PORT':'11435', 'CODEX_PROXY_SHARED_SECRET':'test-secret'}})
        self.old.write_bytes(self.previous)

    def test_migration_preserves_environment_and_backs_up_original(self):
        with patch.object(proxyctl, 'launch') as launch, patch.object(proxyctl.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps({'status':'ok'}).encode())), patch('sys.stdout', new_callable=io.StringIO) as output:
            launch.return_value.returncode = 0
            proxyctl.install('codex')
            self.assertNotIn('test-secret', output.getvalue())
        target = proxyctl.AGENTS / (self.label + '.plist')
        data = plistlib.loads(target.read_bytes())
        self.assertEqual(data['EnvironmentVariables']['CODEX_PROXY_SHARED_SECRET'], 'test-secret')
        self.assertEqual(data['ProgramArguments'][1], str(proxyctl.ROOT/'codex-openai-proxy/server.mjs'))
        self.assertFalse(self.old.exists())
        self.assertEqual((proxyctl.STATE/'backups'/self.old.name).read_bytes(), self.previous)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_failed_bootstrap_restores_legacy_configuration(self):
        with patch.object(proxyctl, 'launch') as launch:
            launch.return_value.returncode = 1
            with self.assertRaises(SystemExit): proxyctl.install('codex')
        self.assertEqual(self.old.read_bytes(), self.previous)
        self.assertFalse((proxyctl.AGENTS/(self.label+'.plist')).exists())

if __name__ == '__main__': unittest.main()
