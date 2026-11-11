import './setup_env.js';
import { seedTestUsers } from './helpers.js';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';

/**
 * Tenant scoping + quota reservation + job ownership tests.
 * The AI service is mocked via a fetch stub so the run is repeatable and free.
 */
const app = createApp('all');
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { console.log(`  ✅ PASS: ${name}`); passed++; }
  else { console.error(`  ❌ FAIL: ${name} ${detail ? `(${detail})` : ''}`); failed++; }
}

let providerCounter = 0;
let providerStatus = 'completed';
let providerDown = false;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  if (!u.includes('localhost:8000')) return realFetch(url, init);
  if (providerDown) throw new Error('connect ECONNREFUSED');
  if (u.endsWith('/api/v1/try-on/jobs') && init?.method === 'POST') {
    return new Response(JSON.stringify({ jobId: `mock-job-${++providerCounter}`, status: 'QUEUED' }), { status: 201 });
  }
  if (u.includes('/api/v1/try-on/jobs/')) {
    return new Response(JSON.stringify({ status: providerStatus, resultUrl: providerStatus === 'completed' ? 'https://example.com/r.png' : undefined }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const IMG = 'data:image/png;base64,iVBORw0KGgo=';
const submit = (productId: string | undefined, extra: any = {}, headers: any = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/try-on/submit', headers, payload: { personImage: IMG, garmentImage: IMG, productId, ...extra } });
const status = (jobId: string, token?: string) =>
  app.inject({ method: 'GET', url: `/api/v1/try-on/status/${jobId}`, headers: token ? { 'x-try-on-token': token } : {} });

function setQuota(tenantId: string, quota: number, used: number) {
  const sub = db.getSubscription(tenantId)!;
  sub.tryOnMonthlyQuota = quota;
  sub.tryOnUsed = used;
}

async function run() {
  db.reset();
  seedTestUsers();
  const auraProduct = db.getProductsByTenant('tenant_aura').find(p => p.marketplacePublished && p.isTryOnEligible)!;
  const vogueProduct = db.getProductsByTenant('tenant_vogue').find(p => p.marketplacePublished && p.isTryOnEligible)!;

  console.log('--- Tenant derived server-side ---');
  setQuota('tenant_aura', 100, 0);
  setQuota('tenant_vogue', 100, 0);
  let res = await submit(undefined);
  assert(res.statusCode === 400, 'missing productId rejected');
  res = await submit('does_not_exist');
  assert(res.statusCode === 404, 'unknown product rejected');
  res = await submit(auraProduct.id, { tenantId: 'tenant_vogue' });
  assert(res.statusCode === 201, 'submit with product succeeds');
  const first = JSON.parse(res.body);
  assert(db.getGenerationsByTenant('tenant_aura').length === 1, 'job stored under product\'s tenant');
  assert(db.getGenerationsByTenant('tenant_vogue').length === 0, 'client-supplied tenantId is ignored');
  assert(db.getSubscription('tenant_vogue')!.tryOnUsed === 0, 'other tenant quota untouched');

  console.log('--- Job ownership ---');
  assert(typeof first.accessToken === 'string' && first.generationId, 'access token + generation id returned');
  assert((await status(first.jobId)).statusCode === 404, 'status without token rejected');
  assert((await status(first.jobId, 'wrong-token')).statusCode === 404, 'status with wrong token rejected');
  res = await status(first.jobId, first.accessToken);
  assert(res.statusCode === 200, 'status with correct token ok');
  const ledger = db.getUsageLedger('tenant_aura');
  assert(ledger.length === 1 && ledger[0].status === 'CONSUMED' && ledger[0].finalUnits === 1, 'completed job consumes unit');
  const usedAfter = db.getSubscription('tenant_aura')!.tryOnUsed;
  await status(first.jobId, first.accessToken);
  await status(first.jobId, first.accessToken);
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === usedAfter && db.getUsageLedger('tenant_aura').length === 1, 'repeated polls never double-charge');

  console.log('--- Quota ---');
  setQuota('tenant_aura', 3, 2);
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => submit(auraProduct.id)));
  const ok = burst.filter(r => r.statusCode === 201).length;
  const limited = burst.filter(r => r.statusCode === 429).length;
  assert(ok === 1 && limited === 4, 'concurrent burst cannot exceed quota', `ok=${ok} limited=${limited}`);
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === 3, 'usage equals quota exactly');
  res = await submit(auraProduct.id);
  assert(res.statusCode === 429 && JSON.parse(res.body).error === 'QuotaExhausted', 'exhausted quota returns QuotaExhausted');
  res = await submit(vogueProduct.id);
  assert(res.statusCode === 201, 'other shop unaffected by exhausted quota');

  console.log('--- Failure releases quota ---');
  setQuota('tenant_aura', 10, 5);
  providerDown = true;
  res = await submit(auraProduct.id);
  assert(res.statusCode === 503, 'provider down returns 503');
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === 5, 'quota released when provider unavailable');
  providerDown = false;
  providerStatus = 'failed';
  res = await submit(auraProduct.id);
  const failedJob = JSON.parse(res.body);
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === 6, 'unit reserved while processing');
  await status(failedJob.jobId, failedJob.accessToken);
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === 5, 'failed generation releases unit');
  providerStatus = 'completed';

  console.log('--- Idempotency ---');
  setQuota('tenant_aura', 10, 0);
  const a = await submit(auraProduct.id, {}, { 'idempotency-key': 'k-1' });
  const b = await submit(auraProduct.id, {}, { 'idempotency-key': 'k-1' });
  assert(a.statusCode === 201 && b.statusCode === 200 && JSON.parse(b.body).duplicate === true, 'duplicate delivery detected');
  assert(db.getSubscription('tenant_aura')!.tryOnUsed === 1, 'duplicate key charged once');

  console.log('--- Super admin usage & plan ---');
  const login = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' } });
  assert(login.statusCode === 200, 'admin login with seed password from env');
  const adminAuth = { authorization: `Bearer ${JSON.parse(login.body).token}` };
  const brandLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' } });
  const brandAuth = { authorization: `Bearer ${JSON.parse(brandLogin.body).token}` };
  assert((await app.inject({ method: 'GET', url: '/api/v1/admin/usage', headers: brandAuth })).statusCode === 403, 'brand owner cannot read admin usage');
  assert((await app.inject({ method: 'PATCH', url: '/api/v1/admin/tenants/tenant_aura/plan', headers: brandAuth, payload: { tryOnMonthlyQuota: 999999 } })).statusCode === 403, 'brand owner cannot change plan');
  const usage = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/admin/usage', headers: adminAuth })).body);
  const aura = usage.find((u: any) => u.tenantId === 'tenant_aura');
  assert(aura && aura.generations.total > 0 && aura.ledger.consumed >= 1, 'usage summary reports generations and ledger');
  const gens = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/admin/generations?tenantId=tenant_aura', headers: adminAuth })).body);
  assert(gens.length > 0 && !('accessTokenHash' in gens[0]), 'generations list hides access token hash');
  const bad = await app.inject({ method: 'PATCH', url: '/api/v1/admin/tenants/tenant_aura/plan', headers: adminAuth, payload: { tryOnMonthlyQuota: -5 } });
  assert(bad.statusCode === 400, 'invalid quota rejected');
  const ok2 = await app.inject({ method: 'PATCH', url: '/api/v1/admin/tenants/tenant_aura/plan', headers: adminAuth, payload: { plan: 'ENTERPRISE', tryOnMonthlyQuota: 4321 } });
  assert(ok2.statusCode === 200 && db.getSubscription('tenant_aura')!.tryOnMonthlyQuota === 4321, 'plan and quota updated');
  assert(db.getAuditLogs('tenant_aura').some(l => l.action === 'PLAN_CHANGED'), 'plan change written to audit log');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  (globalThis as any).fetch = realFetch;
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
