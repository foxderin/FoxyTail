"""Synthetic identity state only: no connected device or real credentials."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from api_fixture import ApiTestCase

class IdentityApiTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.state=self.base/'state'; self.state.mkdir(exist_ok=True)
        self.original=self.identity('old')
        (self.state/'tailscaled.state').write_bytes(self.original)
        self.identity_shell=self.scripts/'foxytail.identity.sh'
        source=(Path(__file__).resolve().parents[1]/'tailscale/scripts/foxytail.identity.sh').read_text()
        self.identity_shell.write_text(source)

    def identity(self,name):
        key='privkey:'+'1'*64
        raw={'_machinekey':key,'_profiles':json.dumps({'abcd':{'ID':'abcd','Key':'profile-abcd','Name':name}}),
             '_current-profile':'profile-abcd','profile-abcd':json.dumps({'ProfileName':name,'Config':{'PrivateNodeKey':key}})}
        return json.dumps({k:base64.b64encode(v.encode()).decode() for k,v in raw.items()}).encode()

    def service(self,args, running=False,trial=False,ok=True):
        script='. "$1"\n. "$2"\ndaemon_pids() { '+('echo 4242' if running else ':')+'; }\nconf_trial_active() { '+('return 0' if trial else 'return 1')+'; }\nidentity_service '+args
        result=subprocess.run(['sh','-c',script,'test',str(self.lib),str(self.identity_shell)],capture_output=True,timeout=15)
        if ok:self.assertEqual(result.returncode,0,result.stderr.decode())
        return result

    def stage(self,data):
        script='. "$1"\ncmd_identity_stage edited.state '+str(len(data))
        result=subprocess.run(['sh','-c',script,'test',str(self.lib)],input=data,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stdout.decode());return json.loads(result.stdout)['id']

    def test_explicit_stop_daemon_and_trial_gates(self):
        self.assertNotEqual(self.service('export',ok=False).returncode,0)
        (self.run/'manual-stop').touch()
        self.assertNotEqual(self.service('export',running=True,ok=False).returncode,0)
        self.assertNotEqual(self.service('export',trial=True,ok=False).returncode,0)
        result=json.loads(self.service('export').stdout)
        self.assertEqual(result['filename'],'foxytail-identity.state')
        self.assertNotIn('privkey',json.dumps(result))
        self.assertEqual((self.state/'tailscaled.state').read_bytes(),self.original)

    def test_preview_and_restore_stay_stopped_preserve_rollback(self):
        (self.run/'manual-stop').touch()
        candidate=self.identity('edited'); token=self.stage(candidate)
        preview=json.loads(self.service('preview '+token).stdout)
        self.assertEqual(preview['baselineSha256'],hashlib.sha256(self.original).hexdigest())
        self.assertEqual(preview['sha256'],hashlib.sha256(candidate).hexdigest())
        result=json.loads(self.service('restore '+token+' '+preview['sha256']+' '+preview['baselineSha256']).stdout)
        self.assertTrue(result['restored']);self.assertTrue(result['restartRequired'])
        self.assertTrue((self.run/'manual-stop').exists())
        self.assertEqual((self.state/'tailscaled.state').read_bytes(),candidate)
        saved=self.shell('cmd_artifact_read '+result['rollbackArtifactId'])
        self.assertEqual(saved.stdout.encode(),self.original)
        shared=self.shell('cmd_artifact_read '+token+' share',ok=False)
        self.assertNotEqual(shared.returncode,0);self.assertEqual(shared.stdout,'')

    def test_malformed_import_and_stale_preview_do_not_change_state(self):
        (self.run/'manual-stop').touch()
        token=self.stage(self.identity('new'))
        result=self.service('restore '+token+' '+'0'*64+' '+'0'*64,ok=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual((self.state/'tailscaled.state').read_bytes(),self.original)
        result=subprocess.run(['sh','-c','. "$1"; cmd_identity_stage broken.state 2','test',str(self.lib)],input=b'{}',capture_output=True)
        self.assertNotEqual(result.returncode,0);self.assertNotIn(b'privkey',result.stdout+result.stderr)

    def test_real_service_lifecycle_lock_serializes_identity_maintenance(self):
        root=Path(__file__).resolve().parents[1]
        service=self.scripts/'foxytail.service'
        service.write_text((root/'tailscale/scripts/foxytail.service').read_text())
        (self.run/'manual-stop').touch()
        wrapper=self.base/'bin/foxyfiles'
        wrapper.rename(self.base/'bin/foxyfiles-real')
        wrapper.write_text('#!/bin/sh\nif [ "$1" = identity-export ]; then echo started >>"'+str(self.base/'starts')+'"; sleep 0.4; fi\nexec "'+str(self.base/'bin/foxyfiles-real')+'" "$@"\n')
        wrapper.chmod(0o755)
        one=subprocess.Popen(['sh',str(service),'identity','export'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for _ in range(100):
            if (self.base/'starts').exists():break
            time.sleep(.01)
        two=subprocess.Popen(['sh',str(service),'identity','export'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        time.sleep(.1)
        self.assertEqual((self.base/'starts').read_text().count('started'),1)
        for process in (one,two):
            output,error=process.communicate(timeout=10)
            self.assertEqual(process.returncode,0,error.decode())
            self.assertTrue(json.loads(output)['ok'])
        self.assertEqual((self.base/'starts').read_text().count('started'),2)

    def test_nickname_expected_profile_fence_and_readback(self):
        fixture='''ts_cli() {
 case "$2" in
 switch) if [ -f "${TS_RUN_DIR}/renamed" ]; then printf '%s\\n' '[{"id":"abcd","selected":true,"nickname":"Work"}]'; else printf '%s\\n' '[{"id":"abcd","selected":true,"nickname":"Old"}]'; fi ;;
 set) [ "$3" = --nickname=Work ] && touch "${TS_RUN_DIR}/renamed" ;;
 *) return 1;; esac
}
'''
        failed=self.shell(fixture+'cmd_account_rename wrong Work',ok=False)
        self.assertNotEqual(failed.returncode,0);self.assertFalse((self.run/'renamed').exists())
        self.assertTrue(json.loads(self.shell(fixture+'cmd_account_rename abcd Work').stdout)['renamed'])

if __name__=='__main__':
    import unittest;unittest.main()
