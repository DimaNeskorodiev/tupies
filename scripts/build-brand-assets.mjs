import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mark=await readFile(path.join(root,'assets/brand/tupies-mark.svg'));
const web=path.join(root,'public/assets/brand');
const icons=path.join(root,'apps/apple/Tupies/Assets.xcassets/AppIcon.appiconset');
await mkdir(web,{recursive:true});
await writeFile(path.join(web,'tupies-mark.svg'),mark);
await sharp(mark).resize(1024,1024).flatten({background:'#2c333e'}).png().toFile(path.join(icons,'icon-ios-1024.png'));
for(const size of [16,32,64,128,256,512,1024]){
  const edge=Math.round(size*.8),inset=Math.floor((size-edge)/2);
  const image=await sharp(mark).resize(edge,edge).png().toBuffer();
  await sharp({create:{width:size,height:size,channels:4,background:'#00000000'}})
    .composite([{input:image,left:inset,top:inset}]).png().toFile(path.join(icons,`icon-mac-${size}.png`));
}
console.log('Built Tupies web mark and Apple app icons.');
