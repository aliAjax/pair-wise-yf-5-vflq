'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, ApiError, TEMP_MIN, TEMP_MAX } = require('./store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) {
        reject(new ApiError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(p, res) {
  const rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

function createServer(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, Object.assign({}, store.state, { constants: { TEMP_MIN, TEMP_MAX } }));
      }
      if (p === '/api/orders' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 201, store.createOrder(body));
      }
      let m;
      if ((m = p.match(/^\/api\/orders\/([\w-]+)\/issue$/)) && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, store.issueOrder(m[1], body.boxId, body.actor));
      }
      if ((m = p.match(/^\/api\/orders\/([\w-]+)\/return$/)) && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, store.returnOrder(m[1], body, body.actor));
      }
      if ((m = p.match(/^\/api\/orders\/([\w-]+)\/cancel$/)) && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, store.cancelOrder(m[1], body.actor));
      }
      if ((m = p.match(/^\/api\/boxes\/([\w-]+)\/review$/)) && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, store.reviewBox(m[1], body, body.actor));
      }
      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(p, res);
      sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, { code: err.code, message: err.message, extra: err.extra || null });
      } else {
        console.error(err);
        sendJson(res, 500, { code: 'INTERNAL', message: '服务器内部错误' });
      }
    }
  });
}

if (require.main === module) {
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  const port = Number(process.env.PORT || 3000);
  const store = new Store(dataFile);
  createServer(store).listen(port, () => {
    console.log(`冷藏疫苗箱借还调度系统已启动: http://localhost:${port}`);
  });
}

module.exports = { createServer };
