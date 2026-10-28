import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import sharp from 'sharp';

const sourceRoot=new URL('../assets/companions/',import.meta.url);
const outputRoot=new URL('../public/assets/companions/',import.meta.url);
const catalog=JSON.parse(await readFile(new URL('catalog.json',sourceRoot),'utf8'));
const additions=catalog.filter(item=>item.frames),sizes=[32,64,128,256,512],poses=['idle','blink','look','wave'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const filename=(id,presentation,pose,size)=>`companion-${id}-${presentation}${pose==='idle'?'':`-${pose}`}-${size}.webp`;
async function rgba(file,options){return sharp(await readFile(new URL(file,outputRoot)),options).ensureAlpha().raw().toBuffer({resolveWithObject:true});}
function alphaCounts(data,channels=4){let clear=0,solid=0;for(let index=channels-1;index<data.length;index+=channels){if(data[index]===0)clear++;if(data[index]>=240)solid++;}return {clear,solid};}
function darkEyeArea({data,info}){
  let count=0;
  // Neutral dark pixels in the central face exclude colored fabric and feet.
  // Fully closed eyelids occupy substantially less area than open oval eyes.
  // Low wide portraits sit lower in their square than the tall companions.
  for(let y=Math.floor(info.height*.15);y<info.height*.88;y++)for(let x=Math.floor(info.width*.20);x<info.width*.80;x++){
    const pixel=(y*info.width+x)*4,r=data[pixel],g=data[pixel+1],b=data[pixel+2];
    if(data[pixel+3]>200&&r<65&&g<65&&b<65&&Math.max(r,g,b)-Math.min(r,g,b)<20)count++;
  }
  return count;
}

test('source, shipped and browser companion catalogues describe the same twenty-four identities',async()=>{
  assert.equal(catalog.length,24);assert.equal(additions.length,20);
  assert.equal(new Set(catalog.map(item=>item.id)).size,24);
  const expected=catalog.map(({id,label,motion,frames})=>({id,label,motion,frames}));
  const context={window:{}};
  vm.runInNewContext(await readFile(new URL('../public/companion-catalog.js',import.meta.url),'utf8'),context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.StudioCompanionCatalog)),expected);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',outputRoot),'utf8'));
  assert.deepEqual(manifest.catalog,expected);
  assert.deepEqual(manifest.variants,catalog.map(item=>item.id));
  assert.deepEqual(new Set(manifest.animatedExports),new Set(additions.map(item=>`companion-${item.id}-animated.webp`)));
});

test('every advertised companion pose and retina resolution is a shipped square transparent image',async()=>{
  for(const item of catalog)for(const presentation of ['portrait','mascot'])for(const pose of item.frames?poses:['idle'])for(const size of sizes){
    const file=filename(item.id,presentation,pose,size),metadata=await sharp(await readFile(new URL(file,outputRoot))).metadata();
    assert.equal(metadata.format,'webp',file);assert.equal(metadata.width,size,file);assert.equal(metadata.height,size,file);
    assert.equal(metadata.hasAlpha,true,`${file} needs real alpha`);
  }
  for(const item of additions)for(const presentation of ['portrait','mascot']){
    const file=`companion-${item.id}-${presentation}-512.png`,metadata=await sharp(await readFile(new URL(file,outputRoot))).metadata();
    assert.equal(metadata.format,'png',file);assert.equal(metadata.width,512,file);assert.equal(metadata.height,512,file);assert.equal(metadata.hasAlpha,true,file);
  }
});

test('new companion blink exports contain closed eyelids rather than another copy of idle',async()=>{
  for(const item of additions)for(const presentation of ['portrait','mascot']){
    const idle=await rgba(filename(item.id,presentation,'idle',256)),blink=await rgba(filename(item.id,presentation,'blink',256));
    assert.notEqual(digest(idle.data),digest(blink.data),`${item.id}/${presentation} blink must change the visible artwork`);
    const openArea=darkEyeArea(idle),closedArea=darkEyeArea(blink);
    assert.ok(openArea>70,`${item.id}/${presentation} needs two readable dark eyes, got ${openArea} pixels`);
    assert.ok(closedArea>5,`${item.id}/${presentation} needs visible closed eyelids`);
    assert.ok(closedArea<openArea*.70,`${item.id}/${presentation}: closed eyelids (${closedArea}) must be smaller than open eyes (${openArea})`);
    for(const image of [idle,blink]){const {clear,solid}=alphaCounts(image.data);assert.ok(clear>256*256*.08,`${item.id}/${presentation} needs a transparent surround`);assert.ok(solid>256*256*.05,`${item.id}/${presentation} needs visible character artwork`);}
  }
});

test('portable companion WebP files have seven transparent frames and the intended gentle timing',async()=>{
  const expectedDelay=[3100,160,2300,850,1800,1000,1000];
  for(const item of additions){
    const file=`companion-${item.id}-animated.webp`,bytes=await readFile(new URL(file,outputRoot)),metadata=await sharp(bytes,{animated:true}).metadata();
    assert.equal(metadata.format,'webp',file);assert.equal(metadata.width,256,file);assert.equal(metadata.pageHeight,256,file);
    assert.equal(metadata.pages,7,file);assert.equal(metadata.loop,0,file);assert.equal(metadata.hasAlpha,true,file);assert.deepEqual(metadata.delay,expectedDelay,file);
    const decoded=[];
    for(let page=0;page<7;page++){
      const frame=await sharp(bytes,{page,pages:1}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      assert.equal(frame.info.width,256,file);assert.equal(frame.info.height,256,file);
      const {clear,solid}=alphaCounts(frame.data);assert.ok(clear>256*256*.08,`${file} frame ${page} needs a transparent surround`);assert.ok(solid>256*256*.05,`${file} frame ${page} is empty`);decoded.push(frame);
    }
    assert.ok(new Set(decoded.map(frame=>digest(frame.data))).size>=4,`${file} must contain four visible poses`);
    assert.ok(darkEyeArea(decoded[1])<darkEyeArea(decoded[0])*.70,`${file} second frame must visibly blink`);
  }
});

test('twenty original generated sheets are unique, transparent and contain four nonempty pose cells',async()=>{
  const originals=new Set();
  for(const item of additions){
    const bytes=await readFile(new URL(item.source,sourceRoot)),metadata=await sharp(bytes).metadata();
    assert.equal(metadata.format,'png',item.id);assert.equal(metadata.hasAlpha,true,item.id);assert.equal(metadata.width%2,0,item.id);assert.equal(metadata.height%2,0,item.id);
    const hash=digest(bytes);assert.equal(originals.has(hash),false,`${item.id} must have its own generated original`);originals.add(hash);
    const cellWidth=metadata.width/2,cellHeight=metadata.height/2,frameHashes=new Set();
    for(let index=0;index<4;index++){
      const {data,info}=await sharp(bytes).extract({left:index%2*cellWidth,top:Math.floor(index/2)*cellHeight,width:cellWidth,height:cellHeight}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      const {clear,solid}=alphaCounts(data);assert.ok(clear>cellWidth*cellHeight*.08,`${item.id}/${poses[index]} needs true transparent pixels`);assert.ok(solid>cellWidth*cellHeight*.05,`${item.id}/${poses[index]} needs visible artwork`);assert.equal(info.channels,4,item.id);frameHashes.add(digest(data));
    }
    assert.equal(frameHashes.size,4,`${item.id} source needs four distinct pose renders`);
  }
  assert.equal(originals.size,20);
});
