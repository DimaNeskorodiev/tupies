import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'public/assets/brand');
const catalog = path.join(root, 'apps/apple/Tupies/Assets.xcassets');
const source = await readFile(path.join(root, 'assets/brand/tupies-avatar.png'));
// Preserve generated alpha; the build never color-keys the mascot.
const mascot = await sharp(source).trim().png().toBuffer();
const { width, height } = await sharp(mascot).metadata();
const palettes = {
  graphite: ['#53606e', '#252c36'],
  pearl: ['#fffaf3', '#e7dac9'],
  sky: ['#d9edf7', '#92b9d5'],
};

function surface(size, palette, rounded = false) {
  const [light, dark] = palettes[palette];
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="surface" x2=".8" y2="1"><stop stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs><rect width="${size}" height="${size}" rx="${rounded ? size * .22 : 0}" fill="url(#surface)"/></svg>`);
}

async function icon(size, palette = 'graphite', rounded = false, compact = false) {
  // Favicon sizes use the face instead of shrinking the entire silhouette.
  const foreground = compact ? await sharp(mascot).extract({
    left: Math.round(width * .14), top: Math.round(height * .08),
    width: Math.round(width * .65), height: Math.round(height * .80),
  }).png().toBuffer() : mascot;
  const edge = Math.round(size * (compact ? .87 : .91));
  const image = await sharp(foreground).resize(edge, edge, { fit: 'inside' }).png().toBuffer();
  const info = await sharp(image).metadata();
  return sharp(surface(size, palette, rounded)).composite([{
    input: image, left: Math.floor((size - info.width) / 2), top: Math.floor((size - info.height) / 2),
  }]).png().toBuffer();
}

await mkdir(web, { recursive: true });
await sharp(mascot).resize(512, 512, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(web, 'tupies-avatar.png'));
await sharp(mascot).resize(512, 512, { fit: 'contain', background: '#00000000' }).webp({ quality: 92, alphaQuality: 100 }).toFile(path.join(web, 'tupies-avatar.webp'));
for (const palette of Object.keys(palettes)) {
  await writeFile(path.join(web, `tupies-icon-${palette}.png`), await icon(1024, palette));
}
await writeFile(path.join(web, 'apple-touch-icon.png'), await icon(180));
for (const size of [16, 32, 64]) {
  await writeFile(path.join(web, `favicon-${size}.png`), await icon(size, 'graphite', true, size <= 32));
}
// The SVG favicon is self-contained, with no external image requests.
const favicon = await icon(128, 'graphite', true, true);
await writeFile(path.join(web, 'tupies-mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,${favicon.toString('base64')}"/></svg>\n`);

const preview = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520"><rect width="1200" height="520" fill="#f4f5f7"/><g font-family="Helvetica,Arial,sans-serif" text-anchor="middle" fill="#2c333e"><text x="600" y="55" font-size="27">Tupies</text><text x="220" y="457" font-size="20">Graphite · app icon</text><text x="600" y="457" font-size="20">Pearl</text><text x="980" y="457" font-size="20">Sky</text></g></svg>');
await sharp(preview).composite(await Promise.all(Object.keys(palettes).map(async (palette, index) => ({
  input: await icon(310, palette, true), left: 65 + index * 380, top: 100,
})))).png().toFile(path.join(web, 'brand-preview.png'));

if (process.env.TUPIES_BUILD_WEB_ONLY === '1') {
  console.log('Built Tupies mascot, web icons and background alternatives. Native assets are outside this web-only build.');
  process.exit(0);
}
const avatar = path.join(catalog, 'TupiesAvatar.imageset');
await mkdir(avatar, { recursive: true });
await sharp(mascot).resize(1024, 1024, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(avatar, 'tupies-avatar.png'));
await writeFile(path.join(avatar, 'Contents.json'), JSON.stringify({
  images: [{ filename: 'tupies-avatar.png', idiom: 'universal' }],
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n');
const icons = path.join(catalog, 'AppIcon.appiconset');
await mkdir(icons, { recursive: true });
// Apple distribution rejects an alpha channel even when every pixel is opaque.
await sharp(await icon(1024)).removeAlpha().png().toFile(path.join(icons, 'icon-ios-1024.png'));
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const edge = Math.round(size * .8);
  const inset = Math.floor((size - edge) / 2);
  const tile = await icon(edge, 'graphite', true, size <= 32);
  await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: tile, left: inset, top: inset }]).png().toFile(path.join(icons, `icon-mac-${size}.png`));
}
console.log('Built Tupies mascot, web icons, background alternatives and Apple assets.');
