import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNumber,developerIdentity,distributionProfile,sign,packageSignedApp,notarize,finish} from '../scripts/release-macos.mjs';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('distribution refuses development certificates and missing private-key identities',()=>{
  const sha='A'.repeat(40),team='0123456789';
  assert.throws(()=>developerIdentity(`1) ${sha} "Apple Development: Fixture (${team})"`,sha),/Developer ID Application/);
  assert.throws(()=>developerIdentity('0 valid identities found',sha),/Developer ID Application/);
  assert.throws(()=>developerIdentity('', 'Fixture Name'),/SHA-1/);
  assert.deepEqual(developerIdentity(`1) ${sha} "Developer ID Application: Fixture (${team})"`,sha.toLowerCase()),{hash:sha,team});
  assert.throws(()=>buildNumber('0'),/positive/);assert.throws(()=>buildNumber('12;command'),/positive/);assert.equal(buildNumber('12'),'12');
});
test('Developer ID profile binds the certificate, production identity, expiry and Keychain prefix',()=>{
  const identity={hash:'A'.repeat(40),team:'0123456789'},prefix='LEGACYPFX1';
  const fixture={allDevices:true,platforms:['OSX'],teams:[identity.team],certificates:[identity.hash],prefixes:[prefix],expires:'2099-01-01T00:00:00Z',entitlements:{'com.apple.application-identifier':`${prefix}.dev.tupies.app`,'com.apple.developer.team-identifier':identity.team,'keychain-access-groups':[`${prefix}.*`]}};
  assert.deepEqual(distributionProfile(fixture,identity),{prefix,group:`${prefix}.dev.tupies.app`});
  for(const patch of [{allDevices:false},{provisionedDevices:true},{certificates:['B'.repeat(40)]},{expires:'2000-01-01T00:00:00Z'},{entitlements:{...fixture.entitlements,'keychain-access-groups':['OTHER.*']}},{entitlements:{...fixture.entitlements,'com.apple.security.get-task-allow':true}}])assert.throws(()=>distributionProfile({...fixture,...patch},identity));
});
test('release stages cannot skip signing or submit an unsigned disk image',async t=>{
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-release-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const file=path.join(output,'release.json');
  await fs.writeFile(file,JSON.stringify({schema:1,bundleIdentifier:'dev.tupies.app',stage:'unsigned-candidate'}));
  await assert.rejects(packageSignedApp({output}),/Developer ID signed/);
  await assert.rejects(notarize({output,profile:'fixture'}),/Developer ID signed/);
  await assert.rejects(finish({output,profile:'fixture'}),/No pending/);
  await fs.writeFile(file,JSON.stringify({schema:1,bundleIdentifier:'dev.tupies.app',stage:'notarized'}));
  await assert.rejects(sign({output,identity:'A'.repeat(40)}),/untouched unsigned/);
  await fs.writeFile(file,JSON.stringify({schema:1,bundleIdentifier:'dev.tupies.app',stage:'notarization-submitting'}));
  await assert.rejects(notarize({output,profile:'fixture'}),/Developer ID signed/);
});
