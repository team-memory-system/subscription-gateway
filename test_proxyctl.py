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
        # Migration only happens for an installation that names its older label.
        p = patch.object(proxyctl, 'LEGACY_PREFIX', 'com.example.old-gateway')
        p.start(); self.addCleanup(p.stop)
        self.label, _, _ = proxyctl.SERVICES['codex']
        self.legacy = proxyctl.legacy_label('codex')
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

    def test_a_new_computer_has_no_legacy_label_to_adopt(self):
        # The default: nothing to migrate from, so install must not look for, boot
        # out, or delete a plist named after the label it is about to write.
        stop = patch.object(proxyctl, 'LEGACY_PREFIX', '')
        stop.start(); self.addCleanup(stop.stop)
        self.assertEqual(proxyctl.legacy_label('codex'), '')
        self.old.unlink()
        with patch.object(proxyctl, 'launch') as launch, patch.object(proxyctl.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps({'status':'ok'}).encode())), patch('sys.stdout', new_callable=io.StringIO):
            launch.return_value.returncode = 0
            proxyctl.install('codex')
        target = proxyctl.AGENTS / (self.label + '.plist')
        self.assertTrue(target.exists())
        data = plistlib.loads(target.read_bytes())
        self.assertEqual(data['Label'], self.label)
        self.assertEqual(data['EnvironmentVariables']['PORT'], '11435')
        booted_out = [call.args for call in launch.call_args_list if call.args[0] == 'bootout']
        self.assertEqual(booted_out, [('bootout', f'gui/{proxyctl.os.getuid()}/{self.label}')])

    def test_the_screen_gets_its_own_port_variable_and_no_session_path(self):
        # A terminal's per-session directory on the installing shell's PATH must not
        # end up in a plist that runs at every login.
        env = {**proxyctl.os.environ, 'PATH': '/private/tmp/session-shims:' + proxyctl.os.environ.get('PATH', '')}
        ok = io.BytesIO(json.dumps({'status': 'ok'}).encode())
        with patch.dict(proxyctl.os.environ, env, clear=True), patch.object(proxyctl, 'launch') as launch, \
                patch.object(proxyctl.urllib.request, 'urlopen', return_value=ok) as urlopen, patch('sys.stdout', new_callable=io.StringIO):
            launch.return_value.returncode = 0
            proxyctl.install('ui')
        data = plistlib.loads((proxyctl.AGENTS / (proxyctl.SERVICES['ui'][0] + '.plist')).read_bytes())
        variables = data['EnvironmentVariables']
        self.assertEqual(data['ProgramArguments'][1], str(proxyctl.ROOT/'ui/server.mjs'))
        self.assertEqual(variables['GATEWAY_UI_PORT'], '11450')
        # Its children would inherit these and bind the wrong port.
        self.assertNotIn('PORT', variables)
        self.assertNotIn('HOST', variables)
        self.assertNotIn('/private/tmp/session-shims', variables['PATH'].split(':'))
        self.assertIn('/usr/bin', variables['PATH'].split(':'))
        self.assertEqual(urlopen.call_args.args[0], 'http://127.0.0.1:11450/health')

    def test_the_screen_and_the_single_account_router_are_never_installed_together(self):
        self.assertNotIn('ui', proxyctl.ALL)
        router = proxyctl.AGENTS / (proxyctl.SERVICES['router'][0] + '.plist')
        router.write_bytes(plistlib.dumps({'Label': proxyctl.SERVICES['router'][0]}))
        with patch.object(proxyctl, 'launch') as launch:
            with self.assertRaises(SystemExit): proxyctl.install('ui')
            launch.assert_not_called()
        self.assertFalse((proxyctl.AGENTS / (proxyctl.SERVICES['ui'][0] + '.plist')).exists())

if __name__ == '__main__': unittest.main()
