import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read=name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');
const [source,app,index,css]=await Promise.all([read('updates.js'),read('app.js'),read('index.html'),read('updates.css')]);

/** The page script in a bare document. `dataset` stands for what the native app writes on <html>. */
function load(dataset={},hostname='tupies.example') {
  const document={documentElement:{dataset},visibilityState:'hidden',addEventListener(){},querySelector(){return null;},getElementById(){return null;}};
  const window={addEventListener(){}};
  vm.runInNewContext(source,{window,document,location:{hostname,reload(){}},setTimeout(){},clearInterval(){},setInterval(){},queueMicrotask(){},Date,Number,Math,String,Boolean,fetch(){throw new Error('The page must not fetch while it is only being rendered.');}});
  return window.StudioUpdates;
}
const installed={kind:'release',version:'0.5.0',id:'0.5.0-engine.beta.10',label:'0.5.0 beta 10',sequence:1,releasedAt:'2026-11-11T09:06:18.000Z'};
const latest={id:'0.5.0-engine.beta.11',version:'0.5.0-engine.beta.11',label:'0.5.0 beta 11',sequence:2,publishedAt:'2026-11-15T10:00:00.000Z',channel:'beta',expired:false};
const apps={ios:{version:'0.5.0',build:17,minimumBuild:10},mac:{version:'0.5.0',build:17,minimumBuild:10}};
const status=(overrides={})=>({installed,latest,checkedAt:new Date().toISOString(),error:'',updateAvailable:true,install:{mode:'request',requestedAt:null,installing:false},apps,...overrides});

test('the page is registered in Settings with its script, styles and route',()=>{
  assert.match(index,/<link rel="stylesheet" href="\/updates\.css">/);assert.match(index,/<script defer src="\/updates\.js"><\/script>/);
  assert.match(app,/\['updates','Version & updates','sync'\]/);
  assert.match(app,/case 'updates':return window\.StudioUpdates\?\.render\(studioContext\(\)\)/);
  assert.match(app,/card\('updates','Version & updates',/);
  assert.match(css,/\.updates-row\{/);assert.match(css,/\.updates-summary\{/);
});

const published=(build,days=1)=>({version:'0.5.0',build,publishedAt:new Date(Date.now()-days*86400_000).toISOString(),downloadURL:`https://github.com/fixture-owner/fixture-repo/releases/download/v0.5.0-beta.${build}/Tupies.dmg`,notesURL:`https://github.com/fixture-owner/fixture-repo/releases/tag/v0.5.0-beta.${build}`});
const withMac=build=>({...apps,mac:{...apps.mac,published:published(build)}});

test('Update now appears only where the server takes the request; otherwise the row says how the update arrives',()=>{
  const page=load();
  const request=page.engineRow(status({engine:{name:'Home server'}}));
  assert.match(request,/Engine · Home server/);assert.match(request,/0\.5\.0 beta 10 · released/);assert.match(request,/<strong>0\.5\.0 beta 11<\/strong>/);
  assert.match(request,/Update available/);assert.match(request,/data-updates-install/);assert.match(request,/Update now/);
  const automatic=page.engineRow(status({install:{mode:'automatic',requestedAt:null,installing:false}}));
  assert.doesNotMatch(automatic,/data-updates-install/);assert.match(automatic,/installs it by itself within about 30 minutes/);
  const manual=page.engineRow(status({install:{mode:'manual',requestedAt:null,installing:false}}));
  assert.doesNotMatch(manual,/data-updates-install/);assert.match(manual,/installed by hand/);
  const includedEngine=load({studioApp:'macos',studioAppVersion:'0.5.0',studioAppBuild:'17'},'127.0.0.1').engineRow(status({install:{mode:'manual',requestedAt:null,installing:false}}));
  assert.match(includedEngine,/arrives with the next Mac app update/);
  const expired=page.engineRow(status({latest:{...latest,expired:true}}));
  assert.doesNotMatch(expired,/data-updates-install/);assert.match(expired,/more than 30 days old/);
});

test('the summary answers first, honestly, and release text and links are made safe',()=>{
  const page=load(),current={updateAvailable:false,latest:{...latest,id:installed.id,label:installed.label}};
  assert.match(page.summary(status(current)),/Everything is up to date/);assert.match(page.summary(status(current)),/Checked just now/);
  assert.match(page.engineRow(status(current)),/Up to date/);
  assert.match(page.summary(status()),/An update is ready/);assert.match(page.summary(status()),/data-updates-check/);
  const both=load({studioApp:'macos',studioAppVersion:'0.5.0',studioAppBuild:'17'});
  assert.match(both.summary(status({apps:withMac(18)})),/2 updates are ready/);
  const failed=page.summary(status({latest:null,updateAvailable:null,error:'Could not read the release channel.'}));
  assert.match(failed,/Could not check for updates/);assert.match(failed,/Could not read the release channel\./);assert.match(failed,/Try again/);
  // A failed check after a good one does not claim that everything is current.
  const stale=page.summary(status({...current,error:'Could not read the release channel.'}));
  assert.match(stale,/Could not check just now/);assert.match(stale,/At the last successful check everything was up to date/);assert.doesNotMatch(stale,/Everything is up to date/);
  const source=status({updateAvailable:null,installed:{kind:'development',version:'0.5.0',id:null,label:'0.5.0 development copy',sequence:null}});
  assert.match(page.summary(source),/Running a development copy/);assert.match(page.engineRow(source),/Newest release: <strong>0\.5\.0 beta 11<\/strong>/);assert.match(page.engineRow(source),/runs from source/);
  const hostile=page.engineRow(status({latest:{...latest,label:'<img src=x onerror=alert(1)>',notesURL:'javascript:alert(1)'}}));
  assert.doesNotMatch(hostile,/<img/);assert.match(hostile,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(hostile,/javascript:|What’s new/);
  assert.match(page.engineRow(status({latest:{...latest,notesURL:'https://github.com/fixture-owner/fixture-repo/releases/tag/v0.5.0-engine.beta.11'}})),/href="https:\/\/github\.com\/fixture-owner\/fixture-repo\/releases\/tag\/v0\.5\.0-engine\.beta\.11" target="_blank" rel="noopener">What’s new</);
});

test('an app update is offered only for a build that was actually published',()=>{
  // In a browser there is no app around the page: offer the published Mac app instead, if there is one.
  const browser=load();
  assert.equal(browser.nativeApp(),null);
  assert.match(browser.appRow(status({apps:withMac(16)})),/Tupies for Mac[\s\S]*0\.5\.0 \(16\)[\s\S]*data-updates-app-download href="https:\/\/github\.com\/fixture-owner\/fixture-repo\/releases\/download\/v0\.5\.0-beta\.16\/Tupies\.dmg"/);
  assert.equal(browser.appRow(status()),'');
  assert.equal(browser.needsAttention(status({updateAvailable:false})),false);assert.equal(browser.needsAttention(status()),true);

  // Mac app 17 knows its build and starts its own Sparkle update from the button.
  const mac=load({studioApp:'macos',studioAppVersion:'0.5.0',studioAppBuild:'17'});
  const newer=mac.appRow(status({apps:withMac(18)}));
  assert.match(newer,/Version 0\.5\.0 \(17\)/);assert.match(newer,/Update available/);assert.match(newer,/<strong>0\.5\.0 \(18\)<\/strong>/);assert.match(newer,/data-updates-app-check/);assert.match(newer,/What’s new/);
  assert.match(mac.appRow(status({apps:withMac(17)})),/Up to date/);
  // The source may already expect build 17, but nothing newer was published: nothing is promised.
  assert.equal(mac.appState(mac.nativeApp(),{...apps.mac,build:19,published:published(17)}),'current');
  assert.equal(mac.needsAttention(status({updateAvailable:false,apps:withMac(17)})),false);

  // An older Mac app cannot start an update from the page, so it gets the published download.
  const older=load({studioApp:'macos'});
  const download=older.appRow(status({apps:withMac(17)}));
  assert.match(download,/An older version/);assert.match(download,/data-updates-app-download/);assert.match(download,/drag Tupies into Applications/);assert.doesNotMatch(download,/data-updates-app-check/);
  assert.equal(older.appState(older.nativeApp(),withMac(16).mac),'unknown');
  const unknown=older.appRow(status({apps:withMac(16)}));
  assert.doesNotMatch(unknown,/Update available|Up to date/);assert.match(unknown,/newest published build is <strong>0\.5\.0 \(16\)<\/strong>/);
  assert.equal(older.needsAttention(status({updateAvailable:false,apps:withMac(16)})),false);
  assert.match(older.appRow(status()),/Tupies → Check for Updates…|An older version/);

  // iPhone: TestFlight is the published place; without its link nothing is promised, but a required update still is.
  const phone=load({studioApp:'ios',studioAppVersion:'0.5.0',studioAppBuild:'17'});
  assert.equal(JSON.stringify(phone.nativeApp()),JSON.stringify({platform:'ios',name:'iPhone app',version:'0.5.0',build:17}));
  assert.match(phone.appRow(status()),/Up to date/);
  const oldPhone=load({studioApp:'ios'});
  assert.equal(oldPhone.appState(oldPhone.nativeApp(),apps.ios),'unknown');
  const flight={...apps,ios:{...apps.ios,testflightURL:'https://testflight.apple.com/join/AbCd1234'}};
  assert.equal(oldPhone.appState(oldPhone.nativeApp(),flight.ios),'available');
  assert.match(oldPhone.appRow(status({apps:flight})),/href="https:\/\/testflight\.apple\.com\/join\/AbCd1234" target="_blank" rel="noopener"/);
  const next={...apps,ios:{version:'0.6.0',build:21,minimumBuild:20}};
  assert.equal(phone.appState(phone.nativeApp(),next.ios),'required');
  assert.match(phone.appRow(status({apps:next})),/Update required/);assert.match(phone.summary(status({apps:next})),/Update this iPhone app to keep using Tupies/);
});

test('the Mac update check is asked of the native shell with one fixed message',()=>{
  assert.match(source,/postMessage\(\{type:'check-app-updates'\}\)/);
});
