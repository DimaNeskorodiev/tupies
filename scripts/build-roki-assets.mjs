// Slice approved generated atlases and encode local, alpha-preserving UI assets.
// This step performs packaging only; character artwork lives in assets/roki/.
import sharp from 'sharp';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceRoot = new URL('../assets/roki/', import.meta.url);
const outputRoot = new URL('../public/assets/roki/', import.meta.url);
await mkdir(outputRoot, {recursive:true});
const poses = ['idle','blink','look','thinking','working','success','greeting','sad','floating'];
const turns = ['front','front-right','right','back-right','back','back-left','left','front-left'];
const expressions = ['default','happy','focused','curious','sleepy','excited','surprised','winking'];
const portraits = ['idle','happy','focused','curious','blink','sleepy'];

async function sliceAtlas(filename, names, columns, rows, prefix, sizes) {
  const source = fileURLToPath(new URL(filename, sourceRoot));
  const {width,height,hasAlpha} = await sharp(source).metadata();
  if (!hasAlpha) throw new Error(`${filename} must have actual transparent alpha.`);
  for (let index = 0; index < names.length; index++) {
    const column=index%columns, row=Math.floor(index/columns);
    const left=Math.round(column*width/columns), top=Math.round(row*height/rows);
    const cell={left,top,width:Math.round((column+1)*width/columns)-left,height:Math.round((row+1)*height/rows)-top};
    const pixels=await sharp(source).extract(cell).png().toBuffer();
    for (const size of sizes) {
      const image=sharp(pixels).resize(size,size,{fit:'contain',background:'#00000000'});
      await image.clone().webp({quality:88,alphaQuality:100,effort:6}).toFile(fileURLToPath(new URL(`${prefix}${names[index]}-${size}.webp`,outputRoot)));
      if ((prefix==='roki-'||prefix==='roki-portrait-')&&names[index]==='idle') await image.clone().png({compressionLevel:9}).toFile(fileURLToPath(new URL(`${prefix}idle-${size}.png`,outputRoot)));
    }
  }
}
await sliceAtlas('roki-poses-source.png',poses,3,3,'roki-',[32,64,128,256,512]);
await sliceAtlas('roki-portraits-source.png',portraits,3,2,'roki-portrait-',[32,64,128,256,512]);
// Supporting design atlases are optional until approved; the UI only uses poses.
for (const [file,names,prefix] of [['roki-turnaround-source.png',turns,'roki-turn-'],['roki-expressions-source.png',expressions,'roki-expression-']]) {
  if (await access(new URL(file,sourceRoot)).then(()=>true,()=>false)) await sliceAtlas(file,names,4,2,prefix,[256]);
}
await writeFile(new URL('manifest.json',outputRoot),JSON.stringify({character:'Roki',version:2,portraits,poses,turns,expressions,iconSizes:[32,64,128,256,512],format:'webp',transparency:true},null,2)+'\n');
console.log('Roki local portraits, mascot poses and transparent icon sizes built.');
