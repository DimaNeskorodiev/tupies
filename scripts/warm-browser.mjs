// Warms the runner's Chrome through the Engine's own browser start before timed regressions run.
//
//   node scripts/warm-browser.mjs            start task browsers until one starts quickly (CI and release runners)
//
// A freshly provisioned GitHub runner is sometimes slow for its first minute or two: on those runners a plain
// `chrome --dump-dom about:blank` takes 11–23 s instead of 6–7 s, and the next one to three Engine browser starts still
// miss the Engine's 15 s `Browser.getVersion` limit before starts drop to about a second. This script starts real task
// browsers (the same flags, private profile, environment and limits as a bot's browser) one after another and stops at
// the first start that is comfortably inside the limit. It never changes a limit and never fails on a slow runner: if
// the runner stays slow for the whole budget it prints a warning and the tests report what they see. It fails only
// when no Chrome or Chromium is installed, because the browser tests would then be skipped silently.
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserSession, findBrowser, forgetBrowserUserAgents} from '../lib/browser.mjs';

const WARM_MS=5000,BUDGET_MS=180_000,MAX_STARTS=12;
const executable=await findBrowser();
if(!executable){console.error('::error::No Chrome or Chromium was found, so the browser regressions would be skipped.');process.exit(1);}
const root=await fs.mkdtemp(path.join(os.tmpdir(),'tupies-browser-warmup-'));
const began=Date.now();let warm=false;
try {
  for(let start=1;start<=MAX_STARTS && Date.now()-began<BUDGET_MS;start++) {
    // Each start reads Chrome's own user agent and relaunches once, exactly like the first task browser in a test file.
    forgetBrowserUserAgents();
    const at=Date.now();let outcome='started';
    try {const session=await BrowserSession.start({executable,profileRoot:root});await session.close();}
    catch(error){outcome=`failed: ${error.message}`;}
    const elapsed=Date.now()-at;
    console.log(`Browser start ${start}: ${outcome} in ${(elapsed/1000).toFixed(1)} s`);
    if(outcome==='started' && elapsed<WARM_MS){warm=true;break;}
  }
} finally {await fs.rm(root,{recursive:true,force:true});}
const total=((Date.now()-began)/1000).toFixed(1);
if(warm)console.log(`Chrome (${executable}) starts quickly after ${total} s of warm-up.`);
else console.log(`::warning::Chrome (${executable}) still started slowly after ${total} s of warm-up; timed browser regressions may fail on this runner.`);
