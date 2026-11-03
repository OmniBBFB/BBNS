import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'deploy/remote-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class DeploymentTest(unittest.TestCase):
    def test_only_pinned_bbns_image_is_accepted(self):
        image = 'ghcr.io/omnibbfb/bbns@sha256:' + 'a' * 64
        self.assertTrue(release.valid_image(image))
        for other in [image.replace('/bbns@', '/board-games@'), 'ghcr.io/omnibbfb/bbns:latest', image + '; id', None]:
            self.assertFalse(release.valid_image(other))

    def test_only_bbns_env_setting_changes(self):
        source = '# shared configuration\nOTHER_IMAGE=retain:1\nBBNS_IMAGE=bbns:old\nOTHER_SECRET=retained\n'
        expected = source.replace('BBNS_IMAGE=bbns:old', 'BBNS_IMAGE=ghcr.io/omnibbfb/bbns@sha256:abc')
        self.assertEqual(release.update_image_env(source, 'ghcr.io/omnibbfb/bbns@sha256:abc'), expected)
        for source in ['OTHER_IMAGE=retained\n', 'BBNS_IMAGE=old\nexport BBNS_IMAGE=another\n']:
            with self.assertRaises(ValueError):
                release.update_image_env(source, 'new')

    def test_task_detection_handles_both_scheduler_versions_and_ignores_idle(self):
        for args in ['node src/scheduler-cli.mjs tick config/scheduler.local.json', 'node /app/src/workflow-cli.mjs tick config/scheduler.local.json']:
            self.assertTrue(release.has_active_tick('COMMAND\n' + args))
        self.assertFalse(release.has_active_tick('COMMAND\nnode tools/container-worker.mjs config/scheduler.local.json'))
        self.assertFalse(release.has_active_tick('node src/scheduler-cli.mjs check'))

    def test_env_update_is_atomic_and_preserves_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('BBNS_IMAGE=old\n')
            path.chmod(0o600)
            release.atomic_write(path, 'BBNS_IMAGE=new\n')
            self.assertEqual(path.read_text(), 'BBNS_IMAGE=new\n')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
