'use strict';
// Tiny in-memory stand-in for the Upstash Redis REST API, used only by test/run.js
const http = require('http');
function start() {
  const strs = new Map(), hashes = new Map();
  const h = (k) => (hashes.has(k) ? hashes.get(k) : hashes.set(k, new Map()).get(k));
  const run = ([cmd, ...a]) => {
    switch (String(cmd).toUpperCase()) {
      case 'HLEN': return h(a[0]).size;
      case 'HSETNX': if (h(a[0]).has(a[1])) return 0; h(a[0]).set(a[1], a[2]); return 1;
      case 'HSET': h(a[0]).set(a[1], a[2]); return 1;
      case 'HGET': return h(a[0]).has(a[1]) ? h(a[0]).get(a[1]) : null;
      case 'HDEL': return h(a[0]).delete(a[1]) ? 1 : 0;
      case 'HGETALL': return [...h(a[0])].flat();
      case 'SET': strs.set(a[0], a[1]); return 'OK';
      case 'GET': return strs.has(a[0]) ? strs.get(a[0]) : null;
      case 'DEL': return a.reduce((n, k) => n + (strs.delete(k) ? 1 : 0), 0);
      case 'INCR': { const n = Number(strs.get(a[0]) || 0) + 1; strs.set(a[0], String(n)); return n; }
      case 'EXPIRE': return 1;
      default: throw new Error('unsupported ' + cmd);
    }
  };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer testtoken') { res.statusCode = 401; return res.end('{"error":"bad token"}'); }
        try { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: run(JSON.parse(body)) })); }
        catch (e) { res.end(JSON.stringify({ error: e.message })); }
      });
    }).listen(0, () => resolve(srv));
  });
}
module.exports = { start };
