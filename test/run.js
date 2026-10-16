'use strict';
// End-to-end check of the API handlers against an in-memory Redis stand-in.  Run: node test/run.js
const assert = require('assert');
(async () => {
  const srv = await require('./fake-redis').start();
  process.env.KV_REST_API_URL = 'http://127.0.0.1:' + srv.address().port;
  process.env.KV_REST_API_TOKEN = 'testtoken';
  const rpc = require('../api/rpc.js');
  const blob = require('../api/blob.js');
  const call = (handler, req) => new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o }); }, send(b) { resolve({ code: this.code, body: b, headers: this.headers }); } };
    handler({ headers: {}, query: {}, url: '/', ...req }, res);
  });
  const api = (op, body, token) => call(rpc, { method: 'POST', body: { op, ...body }, headers: token ? { authorization: 'Bearer ' + token } : {} });
  const ok = async (p) => { const r = await p; assert.strictEqual(r.code, 200, JSON.stringify(r.body)); return r.body; };
  const fail = async (p, code) => { const r = await p; assert.strictEqual(r.code, code, JSON.stringify(r.body)); return r.body; };

  assert.strictEqual((await ok(api('status', {}))).needSetup, true);
  await fail(api('state', {}), 401);
  const admin = await ok(api('setup', { name: 'Admin', mobile: '9876500001', pin: '1234' }));
  await fail(api('setup', { name: 'X', mobile: '9876500002', pin: '1234' }), 409);
  assert.strictEqual((await ok(api('status', {}))).needSetup, false);
  await fail(api('login', { mobile: '9876500001', pin: '9999' }), 401);
  const A = (await ok(api('login', { mobile: '9876500001', pin: '1234' }))).token;

  for (const [n, m, role, func] of [['Store', '9876500003', 'store', ''], ['Site', '9876500004', 'user', 'site'], ['Driver', '9876500005', 'user', 'driver'], ['Fitter', '9876500006', 'user', 'fitting'], ['Viewer', '9876500007', 'user', 'viewer']])
    await ok(api('user.add', { name: n, mobile: m, role, func, pin: '4321' }, A));
  await fail(api('user.add', { name: 'Dup', mobile: '9876500003', role: 'user', pin: '4321' }, A), 409);
  const tok = {};
  for (const m of ['3', '4', '5', '6', '7']) tok[m] = (await ok(api('login', { mobile: '987650000' + m, pin: '4321' }))).token;
  await fail(api('user.add', { name: 'No', mobile: '9876500009', role: 'admin', pin: '4321' }, tok[3]), 403);

  const png = 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64');
  const ph = async (t) => (await ok(api('blob.put', { name: 'p.jpg', type: 'image/jpeg', data: png }, t))).id;
  const job = (photos) => ({ client: 'Test client', site: 'Tower B', address: 'Jaipur', items: [{ desc: 'Sliding window', spec: '1500x1200', qty: '6', unit: 'Nos' }, { desc: 'Casement door', qty: '2', unit: 'Nos' }],
    dispatch: { at: new Date().toISOString(), driver: 'Ramesh', driverMobile: '9876511111', vehicle: 'rj14ga1234', photos } });
  await fail(api('job.create', { jobNo: 'JO012345', job: job([await ph(tok[3])]) }, tok[4]), 403);
  await fail(api('job.create', { jobNo: 'JO12345', job: job([await ph(tok[3])]) }, tok[3]), 400);
  await fail(api('job.create', { jobNo: 'JO012345', job: job([]) }, tok[3]), 400);
  await ok(api('job.create', { jobNo: 'JO012345', job: job([await ph(tok[3])]) }, tok[3]));
  await fail(api('job.create', { jobNo: 'JO012345', job: job([await ph(tok[3])]) }, tok[3]), 409);

  let st = await ok(api('state', {}, tok[7]));
  assert.strictEqual(st.jobs.length, 1);
  assert.strictEqual(st.users, undefined);
  assert.strictEqual((await ok(api('state', {}, A))).users.length, 6);

  const rcpt = async () => ({ mode: 'site', at: new Date().toISOString(), receiver: 'Anil', receiverMobile: '9876522222', photo: await ph(tok[4]), teamName: 'Unload A', teamCount: 3, confirmed: true, match: 'damaged', problems: [{ i: 1, note: 'Glass cracked' }], remarks: 'Door damaged', photos: [await ph(tok[4])] });
  await fail(api('job.verify', { jobNo: 'JO012345', verification: {} }, tok[6]), 409);
  await fail(api('job.receipt', { jobNo: 'JO012345', receipt: await rcpt() }, tok[6]), 403);
  await fail(api('job.receipt', { jobNo: 'JO012345', receipt: { ...(await rcpt()), mode: 'driver', reason: 'x', leftAt: 'y' } }, tok[4]), 403);
  await fail(api('job.receipt', { jobNo: 'JO012345', receipt: { ...(await rcpt()), problems: [] } }, tok[4]), 400);
  await ok(api('job.receipt', { jobNo: 'JO012345', receipt: await rcpt() }, tok[4]));
  await fail(api('job.receipt', { jobNo: 'JO012345', receipt: await rcpt() }, tok[4]), 409);

  const ver = async (r2) => ({ team: 'Fit A', lead: 'Mohan', leadMobile: '9876533333', packing: 'intact', items: [{ r: 'ok' }, { r: r2, note: 'bent' }], remarks: '', photos: [await ph(tok[6])], outcome: 'ok' });
  await fail(api('job.verify', { jobNo: 'JO012345', verification: await ver('ok') }, tok[4]), 403);
  await fail(api('job.verify', { jobNo: 'JO012345', verification: { ...(await ver('ok')), items: [{ r: 'ok' }] } }, tok[6]), 400);
  await ok(api('job.verify', { jobNo: 'JO012345', verification: await ver('damaged') }, tok[6]));
  const j = (await ok(api('state', {}, A))).jobs[0];
  assert.strictEqual(j.verification.outcome, 'issues');
  assert.strictEqual(j.receipt.problems[0].i, 1);
  assert.strictEqual(j.log.length, 3);

  // driver delivery path on a second job
  await ok(api('job.create', { jobNo: 'JO054321', job: job([await ph(tok[3])]) }, A));
  await ok(api('job.receipt', { jobNo: 'JO054321', receipt: { ...(await rcpt()), mode: 'driver', match: 'all', problems: [], reason: 'Site closed', leftAt: 'Security cabin', receiver: 'Ramesh' } }, tok[5]));

  // photos need a login and serve bytes
  const id = await ph(tok[3]);
  await fail(Promise.resolve(call(blob, { method: 'GET', query: { id } })), 401);
  const g = await call(blob, { method: 'GET', query: { id, t: tok[7] } });
  assert.strictEqual(g.code, 200); assert.strictEqual(g.body.toString(), 'fakejpegbytes'); assert.strictEqual(g.headers['content-type'], 'image/jpeg');
  await fail(api('blob.put', { name: 'x', data: 'data:text/html;base64,PGI+' }, A), 400);

  // admin rules
  await fail(api('user.toggle', { mobile: '9876500001' }, A), 400);
  await ok(api('user.toggle', { mobile: '9876500007' }, A));
  await fail(api('login', { mobile: '9876500007', pin: '4321' }), 401);
  await ok(api('user.pin', { mobile: '9876500004', pin: '777777' }, A));
  await ok(api('login', { mobile: '9876500004', pin: '777777' }));
  await fail(api('job.delete', { jobNo: 'JO054321' }, tok[3]), 403);
  await ok(api('job.delete', { jobNo: 'JO054321' }, A));
  assert.strictEqual((await ok(api('state', {}, A))).jobs.length, 1);
  for (let i = 0; i < 8; i++) await api('login', { mobile: '9876500006', pin: '0000' });
  await fail(api('login', { mobile: '9876500006', pin: '4321' }), 429);
  console.log('All API checks passed');
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
