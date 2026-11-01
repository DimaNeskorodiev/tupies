import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const configuredPort = process.env.MISSION_PREVIEW_PORT ?? '4387';
const port = Number(configuredPort);
if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MISSION_PREVIEW_PORT must be an integer between 1 and 65535.');
}

const routes = new Map([
  ['/prototypes/mission/index.html', 'text/html; charset=utf-8'],
  ['/prototypes/mission/mission-preview.html', 'text/html; charset=utf-8'],
  ['/prototypes/mission/mission.css', 'text/css; charset=utf-8'],
  ['/prototypes/mission/mission.js', 'text/javascript; charset=utf-8'],
  ...['style', 'buttons', 'creature-avatars', 'mobile', 'pearl'].map(name => [
    `/public/${name}.css`, 'text/css; charset=utf-8',
  ]),
  ['/public/assets/brand/tupies-avatar.webp', 'image/webp'],
  ['/public/assets/brand/tupies-mark.svg', 'image/svg+xml'],
  ['/public/assets/brand/favicon-32.png', 'image/png'],
  ['/public/assets/brand/favicon-64.png', 'image/png'],
]);

for (const variant of ['blue', 'coral', 'jade', 'honey']) {
  for (const presentation of ['portrait', 'mascot']) {
    for (const resolution of [64, 128, 256, 512]) {
      routes.set(`/public/assets/companions/companion-${variant}-${presentation}-${resolution}.webp`, 'image/webp');
    }
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const reject = (status, message) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : message);
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    reject(405, 'Method not allowed.');
    return;
  }
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) {
    reject(403, 'Local preview only.');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  } catch {
    reject(400, 'Invalid request.');
    return;
  }

  if (pathname === '/') {
    response.writeHead(302, { Location: '/prototypes/mission/index.html' });
    response.end();
    return;
  }

  const type = routes.get(pathname);
  if (!type) {
    reject(404, 'Not found.');
    return;
  }

  try {
    const content = await readFile(fileURLToPath(new URL(pathname.slice(1), root)));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error.code === 'ENOENT') reject(404, 'Not found.');
    else reject(500, 'Unable to read preview asset.');
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Choose another MISSION_PREVIEW_PORT.`
    : `Mission preview could not start: ${error.code || error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mission prototype: http://127.0.0.1:${port}/prototypes/mission/index.html`);
});
