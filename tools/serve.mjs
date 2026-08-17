// ============================================================
// DEV SERVER
// ============================================================
//
// A zero-dependency static file server. It exists for one reason:
// the project is authored in ES modules, and browsers refuse to
// load `import` graphs over the file:// protocol (CORS). Rather
// than take on a dependency for that, we serve the tree ourselves.
//
//   node tools/serve.mjs [port]
//
// It is deliberately minimal: no watching, no live reload, no
// caching headers beyond `no-cache` (so a plain refresh always
// picks up your edits).

import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2] || process.env.PORT || 8123);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.md': 'text/markdown; charset=utf-8',
};

/**
 * Resolve a request path to a file inside ROOT, or null if it escapes.
 * The containment check is what stops `GET /../../secrets` from working.
 */
function resolveSafe(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0]);
    const rel = decoded === '/' ? '/index.html' : decoded;
    const abs = normalize(join(ROOT, rel));
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
    return abs;
}

/**
 * Dev-only capture sink.
 *
 * `POST /__shot/<name>.png` with a PNG body writes it to
 * `.captures/`. It exists so the rendering can be inspected as an
 * actual image during development — including from a headless or
 * backgrounded tab, where requestAnimationFrame never fires and
 * there is nothing to screenshot by ordinary means.
 *
 * Nothing in `src/` uses this. It is a development affordance of
 * the dev server, and the dev server never ships.
 */
async function handleCapture(req, res, urlPath) {
    const name = (urlPath.slice('/__shot/'.length) || 'frame.png').replace(/[^\w.-]/g, '_');
    const dir = join(ROOT, '.captures');

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body);
    console.log(`captured  .captures/${name}  (${body.length} bytes)`);

    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(name);
}

const server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'POST' && urlPath.startsWith('/__shot/')) {
        try {
            await handleCapture(req, res, urlPath);
        } catch (err) {
            res.writeHead(500).end(String(err));
        }
        return;
    }

    const abs = resolveSafe(req.url || '/');
    if (!abs) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    try {
        const info = await stat(abs);
        // Directory requests get their index.html, so /docs/ works.
        const file = info.isDirectory() ? join(abs, 'index.html') : abs;
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        }).end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`rts-life  →  http://localhost:${PORT}`);
    console.log(`serving   ${ROOT}`);
    console.log('');
    console.log('  ?seed=<n>   reproduce a specific run');
    console.log('  ?debug=1    perf + state overlay');
});
