import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
};

createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relativePath = relative(root, requested);
    const file = !relativePath.startsWith('..') && !isAbsolute(relativePath)
      ? requested
      : join(root, 'index.html');
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    response.setHeader('Content-Type', mime[extname(target)] ?? 'application/octet-stream');
    createReadStream(target).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Sarafy web preview: http://127.0.0.1:${port}`);
});
