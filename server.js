import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Load the API key before anything imports the modules that read it.
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const store = await import('./lib/db.js');
const { makeZip } = await import('./lib/zip.js');
const { JOBS, findJob, generateAvatar, hasApiKey } = await import('./lib/gemini.js');

const AVATAR_LIMIT = Number(process.env.AVATAR_LIMIT) || 3;
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 2 * 1024 * 1024; // JSON bodies are metadata only
const MAX_IMAGE = 12 * 1024 * 1024; // a 2160x2880 PNG, with headroom

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- SSE clients

const clients = new Set();

function broadcast(event, payload = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

// -------------------------------------------------------------------- helpers

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Reads a raw request body. Images arrive as binary rather than base64 inside
 * JSON: it is a third smaller on the wire and costs almost no CPU to handle,
 * which is what keeps this within a serverless CPU budget after the move.
 */
function readBinary(req, limit = MAX_IMAGE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('image too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function dataUrlToBuffer(dataUrl, expect = 'image/png') {
  if (typeof dataUrl !== 'string') return null;
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  if (expect && !match[1].startsWith(expect.split('/')[0])) return null;
  const buf = Buffer.from(match[2], 'base64');
  return buf.length ? buf : null;
}

function cleanLines(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => String(line ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Best-guess LAN address so the QR code points somewhere phones can reach. */
function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

function joinUrl(req) {
  const host = req?.headers?.host;
  // A request that already arrived over a tunnel/LAN host knows the reachable
  // origin better than we do; only fall back to sniffing interfaces locally.
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    return `http://${host}/`;
  }
  return `http://${lanAddress()}:${PORT}/`;
}

function safeFileName(name, studentId, index) {
  // Names stay in UTF-8 (the zip flags the encoding); only bytes a filesystem
  // would reject are dropped, and a leading/trailing dot never gets to eat the
  // extension.
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^[._]+|[._]+$/g, '');

  const base = [String(index).padStart(2, '0'), clean(studentId), clean(name)]
    .filter(Boolean)
    .join('-')
    .slice(0, 80);
  return `${base}.png`;
}

// --------------------------------------------------------------------- routes

async function serveStatic(req, res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.woff2' ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const PAGES = {
  '/': 'index.html',
  '/wall': 'wall.html',
  '/projector': 'projector.html',
  '/poster': 'poster.html',
};

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method;

  // ---- poster image. /p/<id>.png is the display copy every page renders;
  // /p/full/<id>.png is the full-resolution download.
  const imageMatch = /^\/p\/(?:(full)\/)?([\w-]+)\.png$/.exec(path);
  if (imageMatch && method === 'GET') {
    const buf = store.getPosterImage(imageMatch[2], imageMatch[1] ? 'full' : 'display');
    if (!buf) return res.writeHead(404).end('Not found');
    const body = Buffer.from(buf);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      // Poster bytes never change once written, so let phones cache them hard.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(body);
  }

  // ---- live updates
  if (path === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  // ---- state
  if (path === '/api/state' && method === 'GET') {
    const session = store.activeSession();
    return json(res, 200, {
      session: { id: session.id, title: session.title, createdAt: session.created_at },
      featuredId: session.featured_id ?? null,
      count: store.countPosters(session.id),
      joinUrl: joinUrl(req),
      avatar: {
        enabled: hasApiKey(),
        limit: AVATAR_LIMIT,
        jobs: JOBS.map(({ id, label, tagline, accent, card }) => ({ id, label, tagline, accent, card })),
      },
    });
  }

  // ---- AI avatars (key stays server-side; quota is per student per session)
  if (path === '/api/avatar/quota' && method === 'GET') {
    const session = store.activeSession();
    const studentId = (url.searchParams.get('studentId') ?? '').trim().slice(0, 24);
    const used = studentId ? store.avatarUsage(session.id, studentId) : 0;
    return json(res, 200, { used, limit: AVATAR_LIMIT, remaining: Math.max(0, AVATAR_LIMIT - used) });
  }

  if (path === '/api/avatar' && method === 'POST') {
    const body = await readBody(req);
    const studentId = String(body.studentId ?? '').trim().slice(0, 24);
    const job = findJob(body.job);
    // Kept as base64 the whole way through — the model wants base64 anyway, so
    // decoding it here just to re-encode it downstream burns CPU for nothing.
    const photoParts = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(body.photo ?? ''));
    const photo = photoParts?.[2] || null;

    if (!studentId) return json(res, 400, { error: 'studentId is required', code: 'bad_request' });
    if (!job) return json(res, 400, { error: 'unknown class', code: 'bad_job' });
    if (!photo) return json(res, 400, { error: 'photo missing or malformed', code: 'bad_photo' });
    if (!hasApiKey()) {
      return json(res, 501, { error: 'avatar generation is not configured', code: 'no_key' });
    }

    const session = store.activeSession();
    const used = store.avatarUsage(session.id, studentId);
    if (used >= AVATAR_LIMIT) {
      return json(res, 429, {
        error: `generation limit reached (${AVATAR_LIMIT} per student)`,
        code: 'quota',
        used,
        limit: AVATAR_LIMIT,
        remaining: 0,
      });
    }

    try {
      const image = await generateAvatar(photo, photoParts[1], job.id);
      // Only a delivered image costs the student one of their three tries.
      const nowUsed = store.bumpAvatarUsage(session.id, studentId);
      return json(res, 200, {
        // image.base64 is the model's own string — decoding and re-encoding a
        // ~2 MB image twice was pure wasted CPU.
        image: `data:${image.mimeType};base64,${image.base64}`,
        job: job.id,
        used: nowUsed,
        limit: AVATAR_LIMIT,
        remaining: Math.max(0, AVATAR_LIMIT - nowUsed),
      });
    } catch (err) {
      console.error('[warrior-wall] avatar generation failed:', err.message);
      return json(res, err.status ?? 502, {
        error: err.message,
        code: err.code ?? 'upstream',
        used,
        limit: AVATAR_LIMIT,
        remaining: Math.max(0, AVATAR_LIMIT - used),
      });
    }
  }

  if (path === '/api/session' && method === 'POST') {
    const body = await readBody(req);
    const session = store.newSession(body.title);
    broadcast('session', { id: session.id, title: session.title });
    return json(res, 200, { id: session.id, title: session.title });
  }

  if (path === '/api/session/title' && method === 'POST') {
    const body = await readBody(req);
    const session = store.activeSession();
    store.renameSession(session.id, body.title);
    broadcast('session', { id: session.id, title: body.title });
    return json(res, 200, { ok: true });
  }

  if (path === '/api/session/clear' && method === 'POST') {
    const session = store.activeSession();
    store.clearSession(session.id);
    broadcast('cleared', {});
    return json(res, 200, { ok: true });
  }

  // ---- posters
  if (path === '/api/posters' && method === 'GET') {
    const session = store.activeSession();
    return json(res, 200, { posters: store.listPosters(session.id) });
  }

  if (path === '/api/posters' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim().slice(0, 40);
    const studentId = String(body.studentId ?? '').trim().slice(0, 24);
    const takeaways = cleanLines(body.takeaways, 3);
    const actions = cleanLines(body.actions, 3);

    if (!name || !studentId) return json(res, 400, { error: 'name and studentId are required' });
    if (!takeaways.length) return json(res, 400, { error: 'at least 1 takeaway is required' });
    if (!actions.length) return json(res, 400, { error: 'at least 1 action is required' });

    const job = findJob(body.job)?.id ?? null;
    const session = store.activeSession();
    store.deleteIncomplete(session.id);
    const id = store.addPoster({
      sessionId: session.id,
      name,
      studentId,
      takeaways,
      actions,
      job,
    });
    // No broadcast yet — the card appears once its display image is uploaded.
    return json(res, 201, { id });
  }

  // ---- image upload: raw bytes, one variant per request
  const imageUpload = /^\/api\/posters\/([\w-]+)\/image\/(full|display|photo)$/.exec(path);
  if (imageUpload && method === 'PUT') {
    const [, id, variant] = imageUpload;
    const bytes = await readBinary(req);
    if (!bytes.length) return json(res, 400, { error: 'empty image' });
    if (!store.putPosterImage(id, variant, bytes)) {
      return json(res, 404, { error: 'poster not found' });
    }
    // The display copy is uploaded last, so its arrival means the card is whole.
    if (variant === 'display') {
      const poster = store.markPosterReady(id);
      if (poster) broadcast('poster', poster);
    }
    return json(res, 200, { ok: true });
  }

  const posterMatch = /^\/api\/posters\/([\w-]+)$/.exec(path);
  if (posterMatch) {
    if (method === 'GET') {
      const poster = store.getPoster(posterMatch[1]);
      return poster ? json(res, 200, poster) : json(res, 404, { error: 'not found' });
    }
    if (method === 'DELETE') {
      store.deletePoster(posterMatch[1]);
      broadcast('removed', { id: posterMatch[1] });
      return json(res, 200, { ok: true });
    }
  }

  // ---- projector
  if (path === '/api/featured' && method === 'POST') {
    const body = await readBody(req);
    const session = store.activeSession();
    const id = body.id ? String(body.id) : null;
    if (id && !store.getPoster(id)) return json(res, 404, { error: 'not found' });
    store.setFeatured(session.id, id);
    broadcast('featured', { id });
    return json(res, 200, { id });
  }

  // ---- QR code for the join link
  if ((path === '/api/qr.svg' || path === '/api/qr.png') && method === 'GET') {
    const wantsSvg = path.endsWith('.svg');
    const target = url.searchParams.get('url') || joinUrl(req);
    try {
      const { default: QRCode } = await import('qrcode');
      const options = {
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#12123aff', light: '#f6e7c1ff' },
      };
      if (wantsSvg) {
        // SVG is the portable form: it is a pure string, so the Workers build
        // can produce it without any Node image plumbing.
        const svg = await QRCode.toString(target, { ...options, type: 'svg' });
        const body = Buffer.from(svg, 'utf8');
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': body.length });
        return res.end(body);
      }
      const png = await QRCode.toBuffer(target, { ...options, type: 'png', width: 640 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    } catch {
      return json(res, 501, { error: 'qrcode package not installed — run: npm install' });
    }
  }

  // ---- bulk download
  if (path === '/api/download/all.zip' && method === 'GET') {
    const session = store.activeSession();
    const rows = store.allPosterImages(session.id);
    if (!rows.length) return json(res, 404, { error: 'no posters yet' });
    const zip = makeZip(
      rows.map((row, i) => ({
        name: safeFileName(row.name, row.student_id, i + 1),
        data: Buffer.from(row.poster),
        date: new Date(row.created_at),
      })),
    );
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': zip.length,
      'Content-Disposition': `attachment; filename="warrior-wall-${stamp}.zip"`,
    });
    return res.end(zip);
  }

  // ---- pages + static assets
  if (method === 'GET' || method === 'HEAD') {
    if (PAGES[path]) return serveStatic(req, res, PAGES[path]);
    return serveStatic(req, res, path);
  }

  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[warrior-wall]', err);
    if (!res.headersSent) json(res, status, { error: err.message ?? 'server error' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const lan = lanAddress();
  console.log(`
  ╔═══════════════════════════════════╗
  ║   A I   W A R R I O R   W A L L   ║
  ║       O F   P L E D G I N G       ║
  ╚═══════════════════════════════════╝

  Students   http://${lan}:${PORT}/
  Wall       http://localhost:${PORT}/wall
  Projector  http://localhost:${PORT}/projector

  (localhost gives you the in-browser camera; on the LAN address phones
   fall back to their native camera app — both work.)
`);
});
