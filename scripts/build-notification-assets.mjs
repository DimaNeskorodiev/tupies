import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
if (process.env.TUPIES_BUILD_WEB_ONLY === '1') {
  console.log('Skipped native notification portraits in this web-only build.');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await fs.readFile(path.join(root, 'assets/companions/catalog.json'), 'utf8'));
const out = path.join(root, 'apps/apple/NotificationService/Avatars');
await fs.mkdir(out, {recursive:true});
for (const {id} of catalog) {
  if (!/^[a-z]+$/.test(id)) throw new Error('Invalid companion identity.');
  await sharp(path.join(root, `public/assets/companions/companion-${id}-portrait-256.webp`))
    .png().toFile(path.join(out, `notification-avatar-${id}.png`));
}
console.log(`Built ${catalog.length} bundled notification portraits.`);
