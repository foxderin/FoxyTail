"""Release source selection and non-force tag creation, using a local bare remote."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / '.github/tools/release-source.sh'

class ReleaseSourceTests(unittest.TestCase):
    def test_release_selects_pinned_ndk_over_runner_default(self):
        repo = HELPER.parents[2]
        workflow = (repo / '.github/workflows/release.yml').read_text()
        start = workflow.index('          source native/tailscaled/SOURCE')
        end = workflow.index('          export FOXYTAIL_KEYSTORE_PATH=', start)
        setup = workflow[start:end]
        result = subprocess.run(['bash', '-c', setup + '\nprintf "%s" "$ANDROID_NDK_HOME"'],
                                cwd=repo, text=True, capture_output=True,
                                env=dict(os.environ, ANDROID_HOME='/sdk', ANDROID_NDK_HOME='/sdk/ndk/28'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '/sdk/ndk/27.2.12479018')

    def test_exact_source_and_tag_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote, work = root / 'remote', root / 'work'
            def run(*args, check=True, env=None):
                return subprocess.run(args, cwd=work if work.exists() else root,
                                      env=env, check=check, text=True, capture_output=True)
            run('git', 'init', '--bare', str(remote))
            run('git', 'clone', str(remote), str(work))
            run('git', 'config', 'user.name', 'Release test')
            run('git', 'config', 'user.email', 'test@example.invalid')
            run('git', 'checkout', '-b', 'master')
            (work / 'module.prop').write_text('version=v1.12.0\n')
            run('git', 'add', 'module.prop')
            run('git', 'commit', '-m', 'release fixture')
            sha = run('git', 'rev-parse', 'HEAD').stdout.strip()
            run('git', 'push', '-u', 'origin', 'master')
            env = dict(os.environ, RELEASE_TAG='v1.12.0', REQUESTED_SHA=sha,
                       RELEASE_SHA=sha, GITHUB_OUTPUT=str(root / 'outputs'))
            def helper(mode, **changes):
                return run('bash', str(HELPER), mode, check=False, env=dict(env, **changes))
            self.assertNotEqual(helper('resolve', REQUESTED_SHA='').returncode, 0)
            self.assertNotEqual(helper('resolve', REQUESTED_SHA='master').returncode, 0)
            self.assertNotEqual(helper('resolve', RELEASE_TAG='v1.13.0').returncode, 0)
            self.assertEqual(helper('resolve').returncode, 0)
            self.assertIn('sha=' + sha, (root / 'outputs').read_text())
            self.assertEqual(helper('tag').returncode, 0)
            self.assertEqual(helper('tag').returncode, 0) # Same exact tag is retryable.
            (work / 'extra').write_text('different commit')
            run('git', 'add', 'extra'); run('git', 'commit', '-m', 'different')
            other = run('git', 'rev-parse', 'HEAD').stdout.strip()
            self.assertNotEqual(helper('tag', RELEASE_SHA=other).returncode, 0)
            self.assertTrue(run('git', 'ls-remote', 'origin', 'refs/tags/v1.12.0').stdout.startswith(sha))
            # Annotated existing tags resolve to their commit, never to the tag object.
            run('git', 'tag', '-a', 'v1.12.0', sha, '-m', 'annotated fixture')
            self.assertEqual(helper('resolve', REQUESTED_SHA='').returncode, 0)
            self.assertNotEqual(helper('resolve', REQUESTED_SHA=other).returncode, 0)

if __name__ == '__main__':
    unittest.main()
