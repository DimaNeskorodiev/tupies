// Package generated transparent companion artwork. Sources stay unchanged;
// this only extracts, registers, resizes and encodes the shipped animation frames.
import sharp from 'sharp';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const sourceRoot=new URL('../assets/companions/',import.meta.url);
const outputRoot=new URL('../public/assets/companions/',import.meta.url);
const layout=JSON.parse(await readFile(new URL('layout.json',sourceRoot),'utf8'));
const catalog=JSON.parse(await readFile(new URL('catalog.json',sourceRoot),'utf8'));
const sizes=[32,64,128,256,512],poses=['idle','blink','look','wave'];
const selected=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
const wanted=id=>!selected||selected.includes(id);
if(catalog.length!==24||new Set(catalog.map(item=>item.id)).size!==24)throw new Error('The companion catalog must contain four originals and twenty additions.');
for(const item of catalog){if(!/^[a-z]+$/.test(item.id)||!['breathe','sway','float','bounce','rock'].includes(item.motion)||typeof item.frames!=='boolean')throw new Error('Invalid companion catalog entry.');}
if(selected?.some(id=>!catalog.some(item=>item.id===id)))throw new Error('Unknown --only companion.');
await mkdir(outputRoot,{recursive:true});
const out=name=>fileURLToPath(new URL(name,outputRoot));
const encodeWebp=(pixels,name)=>sharp(pixels).webp({quality:88,alphaQuality:100,effort:4}).toFile(out(name));

// Largest alpha-connected component gives a reliable *crop and alignment*, so
// tiny generation specks do not determine scale. Never paint or color-key alpha.
function component(raw,width,height,channels){
  const count=width*height,seen=new Uint8Array(count),queue=new Uint32Array(count);let largest=null;
  for(let start=0;start<count;start++){
    if(seen[start]||raw[start*channels+channels-1]<32)continue;
    let head=0,tail=1,left=width,right=0,top=height,bottom=0;queue[0]=start;seen[start]=1;
    while(head<tail){const index=queue[head++],x=index%width,y=Math.floor(index/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;const next=ny*width+nx;if(!seen[next]&&raw[next*channels+channels-1]>=32){seen[next]=1;queue[tail++]=next;}}
    }
    if(!largest||tail>largest.area){let weightedX=0,weight=0;const feet=top+(bottom-top)*.79;for(let index=0;index<tail;index++){const value=queue[index];if(Math.floor(value/width)>=feet){weightedX+=value%width;weight++;}}largest={left,top,width:right-left+1,height:bottom-top+1,anchorX:weight?weightedX/weight:(left+right)/2,area:tail};}
  }
  if(!largest||largest.area<width*height*.055)throw new Error('A sprite cell does not contain a substantial transparent character.');
  return largest;
}

// Preserve the four established assets/URLs and their dedicated portraits.
for(const [presentation,atlas] of Object.entries(layout.atlases)){
  const source=fileURLToPath(new URL(atlas.file,sourceRoot)),metadata=await sharp(source).metadata();
  if(!metadata.hasAlpha||metadata.width!==atlas.width||metadata.height!==atlas.height)throw new Error(`${atlas.file} needs its original transparent artwork.`);
  for(const [variant,region] of Object.entries(atlas.regions)){
    if(!wanted(variant))continue;
    const crop=await sharp(source).extract(region).png().toBuffer();
    for(const size of sizes){const inner=Math.round(size*(presentation==='portrait'?.96:.90));const pixels=await sharp(crop).resize(inner,inner,{fit:'contain',position:presentation==='portrait'?'south':'centre',background:'#00000000'}).extend({top:size-inner,bottom:0,left:Math.floor((size-inner)/2),right:Math.ceil((size-inner)/2),background:'#00000000'}).png().toBuffer();const prefix=`companion-${variant}-${presentation}-${size}`;await encodeWebp(pixels,`${prefix}.webp`);await sharp(pixels).png({compressionLevel:9}).toFile(out(`${prefix}.png`));}
  }
}

const registrations=[];
for(const item of catalog.filter(item=>item.frames&&wanted(item.id))){
  const source=fileURLToPath(new URL(item.source,sourceRoot)),metadata=await sharp(source).metadata();
  if(!metadata.hasAlpha||metadata.width%2||metadata.height%2)throw new Error(`${item.id} requires its transparent 2×2 pose sheet.`);
  const cellWidth=metadata.width/2,cellHeight=metadata.height/2,frames=[];
  for(let index=0;index<poses.length;index++){
    const region={left:index%2*cellWidth,top:Math.floor(index/2)*cellHeight,width:cellWidth,height:cellHeight};
    const {data,info}=await sharp(source).extract(region).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const bounds=component(data,info.width,info.height,info.channels);
    const transparentPixels=data.filter((_,offset)=>offset%info.channels===info.channels-1&&data[offset]===0).length;
    if(transparentPixels<data.length/info.channels*.08)throw new Error(`${item.id}/${poses[index]} is missing a transparent backdrop.`);
    // A two-pixel margin retains the antialiased silhouette of the original.
    const left=Math.max(0,bounds.left-2),top=Math.max(0,bounds.top-2),right=Math.min(cellWidth,bounds.left+bounds.width+2),bottom=Math.min(cellHeight,bounds.top+bounds.height+2);
    const crop={left,top,width:right-left,height:bottom-top};
    frames.push({pose:poses[index],bounds,crop,pixels:await sharp(source).extract({left:region.left+crop.left,top:region.top+crop.top,width:crop.width,height:crop.height}).png().toBuffer()});
  }
  const canvas=1024,baseline=974,span=Math.max(...frames.map(frame=>Math.max(2*(frame.bounds.anchorX-frame.crop.left),2*(frame.crop.left+frame.crop.width-frame.bounds.anchorX),frame.crop.height))),scale=canvas*.88/span;
  const master=[];
  for(const frame of frames){const width=Math.max(1,Math.round(frame.crop.width*scale)),height=Math.max(1,Math.round(frame.crop.height*scale)),left=Math.max(0,Math.min(canvas-width,Math.round(canvas/2-(frame.bounds.anchorX-frame.crop.left)*scale))),top=baseline-height;const pixels=await sharp({create:{width:canvas,height:canvas,channels:4,background:'#00000000'}}).composite([{input:await sharp(frame.pixels).resize(width,height).png().toBuffer(),left,top}]).png().toBuffer();master.push({...frame,pixels,placement:{left,top,width,height}});}
  const idle=master[0].placement;
  const portraitRegion={left:Math.max(0,Math.round(idle.left+idle.width*.06)),top:Math.max(0,idle.top-5),width:Math.round(idle.width*.88),height:Math.round(idle.height*.78)+5};
  portraitRegion.width=Math.min(portraitRegion.width,canvas-portraitRegion.left);portraitRegion.height=Math.min(portraitRegion.height,canvas-portraitRegion.top);
  const portable=[];
  for(const presentation of ['portrait','mascot']){
    for(const frame of master){const original=presentation==='portrait'?await sharp(frame.pixels).extract(portraitRegion).png().toBuffer():frame.pixels;
      for(const size of sizes){const inner=Math.round(size*(presentation==='portrait'?.96:.94));const pixels=await sharp(original).resize(inner,inner,{fit:'contain',position:presentation==='portrait'?'south':'centre',background:'#00000000'}).extend({top:size-inner,bottom:0,left:Math.floor((size-inner)/2),right:Math.ceil((size-inner)/2),background:'#00000000'}).png().toBuffer();const name=`companion-${item.id}-${presentation}${frame.pose==='idle'?'':`-${frame.pose}`}-${size}`;await encodeWebp(pixels,`${name}.webp`);if(size===512&&frame.pose==='idle')await sharp(pixels).png({compressionLevel:8}).toFile(out(`${name}.png`));if(presentation==='mascot'&&size===256)portable.push(pixels);}
    }
  }
  // Portable transparent animation is a presentation loop, never a task status.
  await sharp([portable[0],portable[1],portable[0],portable[2],portable[0],portable[3],portable[0]],{join:{animated:true}}).webp({quality:88,alphaQuality:100,effort:4,loop:0,delay:[3100,160,2300,850,1800,1000,1000]}).toFile(out(`companion-${item.id}-animated.webp`));
  registrations.push({id:item.id,source:item.source,sourceDimensions:[metadata.width,metadata.height],frameBounds:frames.map(({pose,bounds,crop})=>({pose,bounds,crop})),portraitRegion});
}
const browserCatalog=catalog.map(({id,label,motion,frames})=>({id,label,motion,frames}));
await writeFile(new URL('../public/companion-catalog.js',import.meta.url),`/* Generated from assets/companions/catalog.json by build-companion-assets.mjs. */\nwindow.StudioCompanionCatalog=Object.freeze(${JSON.stringify(browserCatalog)}.map(entry=>Object.freeze(entry)));\n`);
await writeFile(new URL('manifest.json',outputRoot),JSON.stringify({family:'Cushion companions',version:2,variants:catalog.map(item=>item.id),catalog:browserCatalog,presentations:['portrait','mascot'],poses,iconSizes:sizes,format:'webp',transparency:true,animatedExports:catalog.filter(item=>item.frames).map(item=>`companion-${item.id}-animated.webp`),motion:'Registered generated blink/look/wave artwork with CSS body motion; paused and reduced motion show idle.'},null,2)+'\n');
const registrationPath=new URL('registration.json',outputRoot);
let previous=[];try{previous=JSON.parse(await readFile(registrationPath,'utf8'));}catch{}
const merged=[...previous.filter(record=>!registrations.some(item=>item.id===record.id)),...registrations].sort((a,b)=>a.id.localeCompare(b.id));
await writeFile(registrationPath,JSON.stringify(merged,null,2)+'\n');
console.log(`Cushion companions: packaged ${selected?selected.length:catalog.length} identities; ${registrations.length} four-pose sheets, portraits and portable animations.`);
