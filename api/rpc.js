'use strict';
const L = require('./_lib');
const { HttpError, redis, can } = L;

const REG = /^JO0\d{5}$/;
const ROLES = ['admin', 'manager', 'store', 'user'];
const FUNCS = ['site', 'driver', 'fitting', 'viewer'];
const MATCH = {
  all: 'All received as per list',
  partial: 'Partly received',
  damaged: 'Damaged material received',
  both: 'Partly received and damaged',
};
const BLOB_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv', 'text/plain'];
const MAX_BLOB = 700 * 1024;

const clip = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const mobOk = (v) => /^\d{10}$/.test(v);
const pinOk = (v) => /^\d{4,6}$/.test(String(v || ''));
const iso = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString();
};
const idOk = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
const ids = (a, max = 24) => (Array.isArray(a) ? a : []).filter(idOk).slice(0, max);
const bad = (msg) => {
  throw new HttpError(400, msg, 'invalid');
};
const forbid = () => {
  throw new HttpError(403, 'Your account is not allowed to do this.', 'forbidden');
};
const mobile10 = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
};

async function loadJob(no) {
  const v = await redis('HGET', 'jobs', no);
  if (!v) throw new HttpError(404, 'Job not found.', 'not_found');
  return JSON.parse(v);
}
const saveJob = (no, job) => redis('HSET', 'jobs', no, JSON.stringify(job));
const logAdd = (job, by, text) => {
  job.log = [...(job.log || []), { at: new Date().toISOString(), by, text }].slice(-60);
};

async function startSession(mobile, u) {
  return { token: L.signToken(mobile), user: L.publicUser(mobile, u) };
}

const OPS = {
  async status() {
    const n = await redis('HLEN', 'users');
    return { needSetup: Number(n) === 0 };
  },

  async setup(_c, b) {
    const name = clip(b.name, 80);
    const m = mobile10(b.mobile);
    if (!name) bad('Enter your name.');
    if (!mobOk(m)) bad('Enter a 10-digit mobile number.');
    if (!pinOk(b.pin)) bad('PIN must be 4 to 6 digits.');
    if (Number(await redis('HLEN', 'users')) > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.', 'done');
    const u = { name, role: 'admin', func: 'viewer', active: true, ...L.newCred(b.pin) };
    const ok = await redis('HSETNX', 'users', m, JSON.stringify(u));
    if (!Number(ok)) throw new HttpError(409, 'Setup is already done. Sign in instead.', 'done');
    return startSession(m, u);
  },

  async login(_c, b) {
    const m = mobile10(b.mobile);
    if (!mobOk(m) || !pinOk(b.pin)) throw new HttpError(401, 'Mobile number or PIN is not correct.', 'auth');
    const fails = Number((await redis('GET', 'lf:' + m)) || 0);
    if (fails >= 8) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes.', 'locked');
    const u = await L.getUser(m);
    if (!u || !L.checkPin(u, b.pin)) {
      const n = Number(await redis('INCR', 'lf:' + m));
      if (n === 1) await redis('EXPIRE', 'lf:' + m, 900);
      throw new HttpError(401, 'Mobile number or PIN is not correct.', 'auth');
    }
    if (u.active === false) throw new HttpError(401, 'This account is turned off. Ask your admin.', 'auth');
    await redis('DEL', 'lf:' + m);
    return startSession(m, u);
  },

  async state(ctx) {
    const flat = (await redis('HGETALL', 'jobs')) || [];
    const jobs = [];
    for (let i = 0; i < flat.length; i += 2) {
      try {
        jobs.push({ ...JSON.parse(flat[i + 1]), jobNo: flat[i] });
      } catch (e) {}
    }
    const out = { me: L.publicUser(ctx.m, ctx.u), jobs };
    if (can.admin(ctx.u)) {
      const uf = (await redis('HGETALL', 'users')) || [];
      out.users = [];
      for (let i = 0; i < uf.length; i += 2) out.users.push(L.publicUser(uf[i], JSON.parse(uf[i + 1])));
    }
    return out;
  },

  async 'job.create'(ctx, b) {
    if (!can.dispatch(ctx.u)) forbid();
    const no = clip(b.jobNo, 8).toUpperCase();
    if (!REG.test(no)) bad('Job number must be in the format JO0XXXXX, for example JO012345.');
    const j = b.job || {};
    const d = j.dispatch || {};
    const sample = !!j.sample && can.admin(ctx.u);
    const items = (Array.isArray(j.items) ? j.items : [])
      .slice(0, 400)
      .map((i) => ({ desc: clip(i.desc), spec: clip(i.spec), qty: clip(i.qty, 20), unit: clip(i.unit, 12) || 'Nos' }))
      .filter((i) => i.desc);
    if (!items.length) bad('Add at least one material item.');
    if (items.some((i) => !i.qty)) bad('Every item needs a quantity.');
    if (!clip(j.client) || !clip(j.site)) bad('Client and site are required.');
    if (!clip(d.driver)) bad('Enter the driver name.');
    const dm = mobile10(d.driverMobile);
    if (!mobOk(dm)) bad('Driver mobile must be 10 digits.');
    const cm = mobile10(j.contactMobile);
    if (cm && !mobOk(cm)) bad('Site contact mobile must be 10 digits.');
    const photos = ids(d.photos);
    if (!photos.length && !sample) bad('Add at least one photo of the material loaded.');
    const at = iso(d.at);
    if (!at) bad('Enter the dispatch date and time.');
    const lf = j.listFile && idOk(j.listFile.id) ? { id: j.listFile.id, name: clip(j.listFile.name, 120) } : null;
    const now = new Date().toISOString();
    const job = {
      client: clip(j.client),
      site: clip(j.site),
      address: clip(j.address, 300),
      contact: clip(j.contact),
      contactMobile: cm,
      items,
      listFile: lf,
      dispatch: {
        at,
        expected: iso(d.expected),
        driver: clip(d.driver),
        driverMobile: dm,
        vehicle: clip(d.vehicle, 20).toUpperCase(),
        by: ctx.u.name,
        byMobile: ctx.m,
        remarks: clip(d.remarks, 500),
        photos,
      },
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.u.name,
      log: [
        {
          at: now,
          by: ctx.u.name,
          text: sample
            ? 'Sample job added'
            : `Booked from factory. Driver ${clip(d.driver)}, ${items.length} item${items.length === 1 ? '' : 's'}, ${photos.length} photo${photos.length === 1 ? '' : 's'}`,
        },
      ],
    };
    if (sample) job.sample = true;
    const ok = await redis('HSETNX', 'jobs', no, JSON.stringify(job));
    if (!Number(ok)) throw new HttpError(409, `${no} already exists. Open it from the Jobs page.`, 'exists');
    return { ok: true };
  },

  async 'job.receipt'(ctx, b) {
    if (!can.receive(ctx.u)) forbid();
    const no = clip(b.jobNo, 8).toUpperCase();
    const job = await loadJob(no);
    if (job.receipt) throw new HttpError(409, 'Receipt is already recorded for this job.', 'exists');
    const r = b.receipt || {};
    const mode = r.mode === 'driver' ? 'driver' : 'site';
    if (ctx.u.role === 'user' && ((ctx.u.func === 'site' && mode !== 'site') || (ctx.u.func === 'driver' && mode !== 'driver'))) forbid();
    const dm = mode === 'driver';
    const at = iso(r.at);
    if (!at) bad('Enter when the material was delivered.');
    if (!clip(r.receiver)) bad('Enter the name of who received the material.');
    const rm = mobile10(r.receiverMobile);
    if (!mobOk(rm)) bad('Mobile number must be 10 digits.');
    if (!idOk(r.photo)) bad('Add a photo of the person who received the material.');
    if (dm && (!clip(r.reason) || !clip(r.leftAt))) bad('Say why no site person was available and where the material was left.');
    if (!clip(r.teamName)) bad('Enter the unloading team name.');
    const teamCount = parseInt(r.teamCount, 10);
    if (!(teamCount > 0 && teamCount < 100)) bad('Enter how many people were in the unloading team.');
    if (!r.confirmed) bad('The unloading team must confirm.');
    const photos = ids(r.photos);
    if (!photos.length) bad('Add at least one photo of the material at site.');
    const match = Object.prototype.hasOwnProperty.call(MATCH, r.match) ? r.match : 'all';
    const problems = (Array.isArray(r.problems) ? r.problems : [])
      .map((p) => ({ i: parseInt(p.i, 10), note: clip(p.note, 200) }))
      .filter((p) => p.i >= 0 && p.i < job.items.length);
    if (match !== 'all') {
      if (!problems.length) bad('Tick the items that are missing or damaged.');
      if (!clip(r.remarks)) bad('Add a remark that explains what is missing or damaged.');
    }
    job.receipt = {
      mode, at, receiver: clip(r.receiver), receiverMobile: rm, photo: r.photo,
      reason: dm ? clip(r.reason, 300) : '', leftAt: dm ? clip(r.leftAt, 300) : '',
      teamName: clip(r.teamName), teamCount, teamLead: clip(r.teamLead), confirmed: true,
      match, problems: match === 'all' ? [] : problems, remarks: clip(r.remarks, 500), photos,
      by: ctx.u.name, byMobile: ctx.m,
    };
    job.updatedAt = new Date().toISOString();
    logAdd(job, ctx.u.name,
      `${dm ? 'Delivered by driver ' + job.receipt.receiver + ', site person not available' : 'Received at site by ' + job.receipt.receiver}. Unloaded by ${job.receipt.teamName}${match === 'all' ? '' : '. ' + MATCH[match] + ': ' + job.receipt.problems.length + ' item' + (job.receipt.problems.length === 1 ? '' : 's') + ' ticked'}`);
    await saveJob(no, job);
    return { ok: true };
  },

  async 'job.verify'(ctx, b) {
    if (!can.verify(ctx.u)) forbid();
    const no = clip(b.jobNo, 8).toUpperCase();
    const job = await loadJob(no);
    if (!job.receipt) throw new HttpError(409, 'Record the receipt at site first.', 'order');
    if (job.verification) throw new HttpError(409, 'Verification is already recorded for this job.', 'exists');
    const v = b.verification || {};
    if (!clip(v.team)) bad('Enter the fitting team name.');
    if (!clip(v.lead)) bad('Enter the team lead name.');
    const lm = mobile10(v.leadMobile);
    if (lm && !mobOk(lm)) bad('Lead mobile must be 10 digits.');
    const items = Array.isArray(v.items) ? v.items : [];
    if (items.length !== job.items.length) bad('Check every item before saving.');
    const checked = items.map((i) => {
      if (!['ok', 'damaged', 'short'].includes(i.r)) bad('Choose OK, Damaged or Short for every item.');
      return { r: i.r, note: clip(i.note, 200) };
    });
    const photos = ids(v.photos);
    if (!photos.length) bad('Add at least one photo of the material as verified.');
    const packing = v.packing === 'damaged' ? 'damaged' : 'intact';
    const issues = packing !== 'intact' || checked.some((i) => i.r !== 'ok');
    job.verification = {
      at: new Date().toISOString(), team: clip(v.team), lead: clip(v.lead), leadMobile: lm, packing,
      items: checked, outcome: issues ? 'issues' : 'ok', remarks: clip(v.remarks, 500), photos,
      by: ctx.u.name, byMobile: ctx.m,
    };
    job.updatedAt = job.verification.at;
    logAdd(job, ctx.u.name, `Verified by ${job.verification.team}. ${issues ? 'Issues found' : 'All items OK'}`);
    await saveJob(no, job);
    return { ok: true };
  },

  async 'job.delete'(ctx, b) {
    if (!can.admin(ctx.u)) forbid();
    const no = clip(b.jobNo, 8).toUpperCase();
    const job = await loadJob(no);
    const keys = new Set();
    (job.dispatch.photos || []).forEach((i) => keys.add(i));
    if (job.receipt) {
      (job.receipt.photos || []).forEach((i) => keys.add(i));
      if (job.receipt.photo) keys.add(job.receipt.photo);
    }
    if (job.verification) (job.verification.photos || []).forEach((i) => keys.add(i));
    if (job.listFile) keys.add(job.listFile.id);
    await redis('HDEL', 'jobs', no);
    const del = [...keys].filter(idOk).map((i) => 'blob:' + i);
    if (del.length) await redis('DEL', ...del);
    return { ok: true };
  },

  async 'user.add'(ctx, b) {
    if (!can.admin(ctx.u)) forbid();
    const name = clip(b.name, 80);
    const m = mobile10(b.mobile);
    const role = ROLES.includes(b.role) ? b.role : 'user';
    const func = role === 'user' && FUNCS.includes(b.func) ? b.func : 'viewer';
    if (!name) bad('Enter a name.');
    if (!mobOk(m)) bad('Enter a 10-digit mobile number.');
    if (!pinOk(b.pin)) bad('PIN must be 4 to 6 digits.');
    const u = { name, role, func, active: true, ...L.newCred(b.pin) };
    const ok = await redis('HSETNX', 'users', m, JSON.stringify(u));
    if (!Number(ok)) throw new HttpError(409, 'That mobile number is already registered.', 'exists');
    return { ok: true };
  },

  async 'user.pin'(ctx, b) {
    if (!can.admin(ctx.u)) forbid();
    const m = mobile10(b.mobile);
    if (!pinOk(b.pin)) bad('PIN must be 4 to 6 digits.');
    const u = await L.getUser(m);
    if (!u) throw new HttpError(404, 'Person not found.', 'not_found');
    await redis('HSET', 'users', m, JSON.stringify({ ...u, ...L.newCred(b.pin) }));
    await redis('DEL', 'lf:' + m);
    return { ok: true };
  },

  async 'user.toggle'(ctx, b) {
    if (!can.admin(ctx.u)) forbid();
    const m = mobile10(b.mobile);
    if (m === ctx.m) bad('You cannot turn off your own account.');
    const u = await L.getUser(m);
    if (!u) throw new HttpError(404, 'Person not found.', 'not_found');
    if (u.role === 'admin' && u.active !== false) {
      const uf = (await redis('HGETALL', 'users')) || [];
      let admins = 0;
      for (let i = 0; i < uf.length; i += 2) {
        const x = JSON.parse(uf[i + 1]);
        if (x.role === 'admin' && x.active !== false) admins++;
      }
      if (admins < 2) bad('Keep at least one active admin.');
    }
    await redis('HSET', 'users', m, JSON.stringify({ ...u, active: u.active === false }));
    return { ok: true };
  },

  async 'blob.put'(_ctx, b) {
    const mt = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!mt) bad('That file could not be read.');
    const type = mt[1];
    if (!BLOB_TYPES.includes(type)) bad('That file type is not allowed.');
    const size = Math.floor((mt[2].length * 3) / 4);
    if (size > MAX_BLOB) bad('That file is over 700 KB.');
    const id = require('crypto').randomBytes(12).toString('hex');
    await redis('SET', 'blob:' + id, JSON.stringify({ type, name: clip(b.name, 120), data: mt[2] }));
    return { id };
  },
};

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (e) {
      return {};
    }
  }
  return {};
}

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only', 'method');
    const b = parseBody(req);
    const op = String(b.op || '');
    const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
    if (!fn) throw new HttpError(404, 'Unknown operation', 'op');
    const open = op === 'status' || op === 'setup' || op === 'login';
    const ctx = open ? null : await L.authed(req);
    res.status(200).json(await fn(ctx, b));
  } catch (e) {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server.', code: e.code || '' });
  }
};
module.exports.OPS = OPS;
