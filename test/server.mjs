// Test server for the IWER (WebXR emulator) runs in ForemanBox.
//   node test/server.mjs <siteRoot> <port> <driver.js> <iwer.module.js> <outDir>
// Serves the site; <slug>/xrtest.html = that build's index.html with the IWER driver injected first.
// POST */log (game ?test beacons + driver logs) -> stdout + outDir/log.txt; POST /upload?name=x -> outDir/x
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [root, port, driver, iwer, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'log.txt');
fs.writeFileSync(logFile, '');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.webp': 'image/webp' };
const body = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (req.method === 'POST') {
    const b = await body(req);
    if (p.endsWith('/log')) { const line = b.toString(); fs.appendFileSync(logFile, line + '\n'); if (!line.startsWith('INFO: status')) console.log(line); res.end('ok'); return; }
    if (p === '/upload') { const name = path.basename(u.searchParams.get('name') || 'upload.bin'); fs.writeFileSync(path.join(outDir, name), b); console.log('UPLOAD', name, b.length); res.end('ok'); return; }
    res.statusCode = 404; res.end(); return;
  }
  let file;
  if (p.endsWith('/__drv.js')) file = driver;
  else if (p.endsWith('/__iwer.js')) file = iwer;
  else if (p.endsWith('/xrtest.html')) {
    const html = fs.readFileSync(path.join(root, p.replace(/xrtest\.html$/, 'index.html')), 'utf8')
      .replace('<!-- recording build hooks -->', '<script type="module" src="__drv.js"></script>\n<!-- recording build hooks -->');
    res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store'); res.end(html); return;
  } else {
    file = path.join(root, p);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  }
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end('404'); return; }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(+port, '127.0.0.1', () => console.log('test server on', port));
