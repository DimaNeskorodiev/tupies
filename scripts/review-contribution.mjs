// Maintainer intake: never applies patches or runs contributed code on the host.
import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensure } from '../lib/store.mjs';
import { validateWorkshopPackage, testWorkshopPackage, workshopDigest } from '../lib/workshop.mjs';
import { verifyEngineCandidate } from '../lib/engine-workshop.mjs';

export async function reviewContribution(file,{acceptDigest,checkEngineDigest,sourceRoot,catalogDirectory=fileURLToPath(new URL('../assets/tool-catalog/',import.meta.url))}={}){
  const handle=await fs.open(path.resolve(file),FS.O_RDONLY|FS.O_NOFOLLOW);let bytes;
  try{const stat=await handle.stat();ensure(stat.isFile()&&stat.size<=150000,413,'Choose a regular contribution JSON file under 150 KB.');bytes=await handle.readFile();}finally{await handle.close();}
  const bundle=JSON.parse(bytes);
  ensure(bundle.format==='tupies-contribution-v1' && bundle.proposal?.format==='tupies-improvement-v1' && workshopDigest(bundle.proposal)===bundle.digest,400,'Invalid contribution or digest.');
  const summary={digest:bundle.digest,kind:bundle.proposal.kind,title:bundle.proposal.title,summary:bundle.proposal.summary,action:'Review complete source and fixtures before acceptance. Imported verification is not trusted.'};
  ensure(!(acceptDigest!==undefined&&checkEngineDigest!==undefined),400,'Choose one review action.');
  if(checkEngineDigest!==undefined){
    ensure(checkEngineDigest===bundle.digest&&bundle.proposal.kind==='engine'&&bundle.proposal.candidate?.format==='tupies-engine-candidate-v1',400,'Check only an exact reviewed Engine candidate contribution.');
    const checked=await verifyEngineCandidate(bundle.proposal.candidate.request,{root:sourceRoot});
    ensure(checked.patch===bundle.proposal.patch&&workshopDigest(checked.base)===workshopDigest(bundle.proposal.candidate.base),409,'Candidate patch or base differs from its declared edits.');
    summary.verification=checked.verification;summary.action='Independently checked exact edits against local source in memory. No source was applied. Review and run full build/regressions in an appropriately isolated checkout before release.';
  }
  if(acceptDigest!==undefined){
    ensure(acceptDigest===bundle.digest && bundle.proposal.kind==='tool',400,'Accept only an exact reviewed tool contribution. Engine patches require normal source review.');
    const pkg=validateWorkshopPackage(bundle.proposal.package);
    ensure(workshopDigest(pkg)===bundle.proposal.toolDigest,400,'Package identity mismatch.');
    await testWorkshopPackage(pkg);
    const stat=await fs.lstat(catalogDirectory);ensure(stat.isDirectory()&&!stat.isSymbolicLink(),400,'The catalog must be a real directory.');
    // Exclusive create: existing product versions are never overwritten by import.
    await fs.writeFile(path.join(catalogDirectory,`${pkg.id}.json`),JSON.stringify(pkg,null,2)+'\n',{flag:'wx',mode:0o644});
    summary.accepted=true;summary.action='Added to source catalog after isolated tests. Review, build, verify and release through the normal product workflow.';
  }
  return summary;
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    const [file,flag,expected,...extra]=process.argv.slice(2);
    ensure(file && !extra.length && (!flag || ['--accept-tool','--check-engine'].includes(flag)) && (!flag || expected),400,'Usage: node scripts/review-contribution.mjs PACKAGE.json [--accept-tool|--check-engine REVIEWED_SHA256]');
    console.log(JSON.stringify(await reviewContribution(file,{...(flag?{[flag==='--accept-tool'?'acceptDigest':'checkEngineDigest']:expected}:{})}),null,2));
  }catch(error){console.error(error.code==='EEXIST'?'That catalog id already exists. Review the version change manually.':error.message);process.exitCode=1;}
}
