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
  assert.match(css,/\.updates-card\{/);
});

test('Update now appears only where the server takes the request; otherwise the page says how the update arrives',()=>{
  const page=load();
  const request=page.engineCard(status());
  assert.match(request,/Version 0\.5\.0 beta 10/);assert.match(request,/0\.5\.0 beta 11 is available/);assert.match(request,/data-updates-install/);assert.match(request,/data-updates-check/);
  const automatic=page.engineCard(status({install:{mode:'automatic',requestedAt:null,installing:false}}));
  assert.doesNotMatch(automatic,/data-updates-install/);assert.match(automatic,/installs it by itself within about 30 minutes/);
  const manual=page.engineCard(status({install:{mode:'manual',requestedAt:null,installing:false}}));
  assert.doesNotMatch(manual,/data-updates-install/);assert.match(manual,/installed by hand/);
  const includedEngine=load({studioApp:'macos',studioAppVersion:'0.5.0',studioAppBuild:'17'},'127.0.0.1').engineCard(status({install:{mode:'manual',requestedAt:null,installing:false}}));
  assert.match(includedEngine,/arrives with the next Mac app update/);
  const expired=page.engineCard(status({latest:{...latest,expired:true}}));
  assert.doesNotMatch(expired,/data-updates-install/);assert.match(expired,/more than 30 days old/);
});

test('up to date, unknown and failed checks are said plainly and release text is escaped',()=>{
  const page=load();
  assert.match(page.engineCard(status({updateAvailable:false,latest:{...latest,id:installed.id,label:installed.label}})),/<strong>Up to date<\/strong>/);
  const source=page.engineCard(status({updateAvailable:null,installed:{kind:'development',version:'0.5.0',id:null,label:'0.5.0 development copy',sequence:null}}));
  assert.match(source,/Newest release: 0\.5\.0 beta 11/);assert.match(source,/runs from source/);assert.match(source,/Running from a source folder/);
  const failed=page.engineCard(status({latest:null,updateAvailable:null,error:'Could not read the release channel.'}));
  assert.match(failed,/Could not check for updates/);assert.match(failed,/Could not read the release channel\./);
  const hostile=page.engineCard(status({latest:{...latest,label:'<img src=x onerror=alert(1)>'}}));
  assert.doesNotMatch(hostile,/<img/);assert.match(hostile,/&lt;img src=x onerror=alert\(1\)&gt; is available/);
});

test('the app card compares the app’s own build with the build this engine expects',()=>{
  const browser=load();
  assert.equal(browser.nativeApp(),null);assert.match(browser.appCard(status()),/Open this page in the Tupies iPhone or Mac app/);
  assert.equal(browser.needsAttention(status({updateAvailable:false})),false);assert.equal(browser.needsAttention(status()),true);

  const current=load({studioApp:'ios',studioAppVersion:'0.5.0',studioAppBuild:'17'});
  assert.equal(JSON.stringify(current.nativeApp()),JSON.stringify({platform:'ios',name:'iPhone app',version:'0.5.0',build:17}));
  assert.match(current.appCard(status()),/Version 0\.5\.0 \(17\)/);assert.match(current.appCard(status()),/<strong>Up to date<\/strong>/);
  assert.equal(current.needsAttention(status({updateAvailable:false})),false);

  // An app from before build 17 says nothing about itself: a newer build exists, but the old one still works.
  const older=load({studioApp:'ios'}),olderCard=older.appCard(status());
  assert.equal(older.appState(older.nativeApp(),apps.ios),'available');
  assert.match(olderCard,/does not report its version/);assert.match(olderCard,/iPhone app 0\.5\.0 \(17\) is available/);assert.match(olderCard,/Open the <strong>TestFlight<\/strong> app/);
  assert.equal(older.needsAttention(status({updateAvailable:false})),true);
  assert.match(older.appCard(status({apps:{...apps,ios:{...apps.ios,testflightURL:'https://testflight.apple.com/join/AbCd1234'}}})),/href="https:\/\/testflight\.apple\.com\/join\/AbCd1234" target="_blank" rel="noopener"/);

  const required=load({studioApp:'ios',studioAppVersion:'0.5.0',studioAppBuild:'17'}),next={...apps,ios:{version:'0.6.0',build:21,minimumBuild:20}};
  assert.equal(required.appState(required.nativeApp(),next.ios),'required');
  assert.match(required.appCard(status({apps:next})),/Update this iPhone app to keep using Tupies/);

  const mac=load({studioApp:'macos',studioAppVersion:'0.5.0',studioAppBuild:'17'});
  assert.match(mac.appCard(status()),/data-updates-app-check/);assert.match(mac.appCard(status()),/Check for Mac app updates/);
  assert.match(load({studioApp:'macos'}).appCard(status()),/Tupies → Check for Updates…/);
});

test('the Mac update check is asked of the native shell with one fixed message',()=>{
  assert.match(source,/postMessage\(\{type:'check-app-updates'\}\)/);
});
