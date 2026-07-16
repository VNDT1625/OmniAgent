#!/usr/bin/env node

/**
 * Serve electron-builder update artifacts for LAN update testing.
 *
 * Usage:
 *   node scripts/serve-update-feed.js [artifactDir=out] [port=5077]
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.argv[2] || process.env.AIONUI_UPDATE_ARTIFACT_DIR || 'out');
const port = Number(process.argv[3] || process.env.AIONUI_UPDATE_FEED_PORT || 5077);

const contentTypes = new Map([
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.yaml', 'text/yaml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.msi', 'application/x-msi'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.zip', 'application/zip'],
  ['.deb', 'application/vnd.debian.binary-package'],
  ['.rpm', 'application/x-rpm'],
  ['.blockmap', 'application/octet-stream'],
]);

const listLanAddresses = () => {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  res.end(body);
};

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid port: ${port}`);
  process.exit(1);
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Artifact directory does not exist: ${root}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (!req.url || req.method !== 'GET') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const decoded = decodeURIComponent(url.pathname);
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relativePath);

  if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
    send(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    send(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const stat = fs.statSync(target);
  const headers = {
    'access-control-allow-origin': '*',
    'accept-ranges': 'bytes',
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
  };
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      send(res, 416, 'Invalid range', {
        ...headers,
        'content-range': `bytes */${stat.size}`,
      });
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : stat.size - 1;
    const end = Math.min(requestedEnd, stat.size - 1);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
      send(res, 416, 'Range not satisfiable', {
        ...headers,
        'content-range': `bytes */${stat.size}`,
      });
      return;
    }

    res.writeHead(206, {
      ...headers,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
    });
    fs.createReadStream(target, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    'content-length': stat.size,
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Serving update artifacts from: ${root}`);
  console.log(`Local: http://127.0.0.1:${port}/`);
  for (const address of listLanAddresses()) {
    console.log(`LAN:   http://${address}:${port}/`);
  }
  console.log('');
  console.log('Point the old app at this feed with:');
  console.log(`AIONUI_UPDATE_FEED_URL=http://<this-machine-ip>:${port}/`);
});
