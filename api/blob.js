'use strict';
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') throw new L.HttpError(405, 'GET only', 'method');
    await L.authed(req);
    const u = new URL(req.url, 'http://x');
    const id = (req.query && req.query.id) || u.searchParams.get('id') || '';
    if (!/^[a-f0-9]{24}$/.test(id)) throw new L.HttpError(404, 'Not found', 'not_found');
    const v = await L.redis('GET', 'blob:' + id);
    if (!v) throw new L.HttpError(404, 'Not found', 'not_found');
    const f = JSON.parse(v);
    res.setHeader('content-type', f.type);
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    if (!f.type.startsWith('image/')) {
      res.setHeader('content-disposition', 'inline; filename="' + String(f.name || 'file').replace(/[^\w.-]/g, '_') + '"');
    }
    res.status(200).send(Buffer.from(f.data, 'base64'));
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server.' });
  }
};
