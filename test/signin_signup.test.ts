import './setup_env.js';
import { seedTestUsers } from './helpers.js';
import { createApp } from '../src/server.js';
import { db } from '../src/infrastructure/database.js';

const app = createApp('all');
let passed = 0, failed = 0;
const assert = (c: boolean, n: string, d?: string) => { c ? (console.log(`  ✅ PASS: ${n}`), passed++) : (console.error(`  ❌ FAIL: ${n} ${d ?? ''}`), failed++); };
const post = (url: string, payload: any) => app.inject({ method: 'POST', url, payload });
const json = (r: any) => { try { return JSON.parse(r.body); } catch { return {}; } };
const STRONG = 'Str0ng-Passw0rd!';

async function run() {
  db.reset(); seedTestUsers();

  console.log('--- Brand sign up (no slug field) ---');
  const reg = (name: string, email: string, password = STRONG) =>
    post('/api/v1/auth/register', { brandName: name, ownerName: 'Test Owner', email, password });
  let r = await reg('Lumiere Couture', 'owner1@lumiere.test');
  assert(r.statusCode === 201, 'registers without a slug');
  assert(json(r).tenant?.slug === 'lumiere-couture', 'slug generated from brand name', json(r).tenant?.slug);
  r = await reg('Lumiere Couture', 'owner2@lumiere.test');
  assert(r.statusCode === 201 && json(r).tenant?.slug === 'lumiere-couture-2', 'same brand name gets unique slug', json(r).tenant?.slug);
  r = await reg('  !!  ', 'owner3@lumiere.test');
  assert(r.statusCode === 201 && /^[a-z0-9-]{2,}$/.test(json(r).tenant?.slug || ''), 'odd brand name still gets a valid slug', json(r).tenant?.slug);
  assert((await reg('Dup Email', 'owner1@lumiere.test')).statusCode === 409, 'duplicate email rejected');
  assert((await reg('Weak Pass', 'weak@lumiere.test', 'abc')).statusCode === 400, 'weak password rejected');
  assert((await reg('Bad Email', 'not-an-email')).statusCode === 400, 'invalid email rejected');
  assert((await post('/api/v1/auth/register', { brandName: '', ownerName: 'x', email: 'a@b.co', password: STRONG })).statusCode === 400, 'missing brand name rejected');

  console.log('--- Brand sign in ---');
  r = await post('/api/v1/auth/login', { email: 'owner1@lumiere.test', password: STRONG });
  assert(r.statusCode === 403 && json(r).error !== undefined, 'unverified brand blocked from sign in', String(r.statusCode));
  r = await post('/api/v1/auth/login', { email: 'elena@auraatelier.com', password: 'wrong-password' });
  assert(r.statusCode === 401, 'wrong password rejected');
  r = await post('/api/v1/auth/login', { email: 'nobody@nowhere.test', password: STRONG });
  assert(r.statusCode === 401, 'unknown email rejected');
  r = await post('/api/v1/auth/login', { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' });
  assert(r.statusCode === 200 && !!json(r).token, 'valid brand sign in returns token');
  r = await post('/api/v1/auth/login', { email: 'ELENA@AuraAtelier.com ', password: 'Test-Brand-Pass-1' });
  assert(r.statusCode === 200, 'email is case/space insensitive');
  const token = json(r).token;
  r = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert(r.statusCode === 200, 'token works on /auth/me');
  r = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer garbage' } });
  assert(r.statusCode === 401, 'bad token rejected');

  console.log('--- Customer sign up / sign in (marketplace) ---');
  r = await post('/api/v1/marketplace/auth/register', { name: 'New Shopper', email: 'shopper@test.dev', password: STRONG });
  assert(r.statusCode === 201 && json(r).requiresEmailVerification === true, 'customer registers');
  assert((await post('/api/v1/marketplace/auth/register', { name: 'Again', email: 'shopper@test.dev', password: STRONG })).statusCode === 409, 'duplicate customer email rejected');
  assert((await post('/api/v1/marketplace/auth/register', { name: 'Weak', email: 'weak@test.dev', password: '123' })).statusCode === 400, 'weak customer password rejected');
  assert((await post('/api/v1/marketplace/auth/login', { email: 'shopper@test.dev', password: STRONG })).statusCode === 403, 'unverified customer blocked');
  assert((await post('/api/v1/marketplace/auth/login', { email: 'sarah.miller@example.com', password: 'nope' })).statusCode === 401, 'wrong customer password rejected');
  r = await post('/api/v1/marketplace/auth/login', { email: 'sarah.miller@example.com', password: 'Test-Customer-Pass-1' });
  assert(r.statusCode === 200 && !!json(r).token, 'verified customer signs in');

  console.log('--- Super admin sign in ---');
  assert((await post('/api/v1/admin/auth/login', { email: 'admin@vton-platform.io', password: 'wrong' })).statusCode === 401, 'admin wrong password rejected');
  r = await post('/api/v1/admin/auth/login', { email: 'admin@vton-platform.io', password: 'Test-Admin-Pass-1' });
  assert(r.statusCode === 200 && !!json(r).token, 'admin signs in with seeded .env password');
  assert((await post('/api/v1/admin/auth/login', { email: 'elena@auraatelier.com', password: 'Test-Brand-Pass-1' })).statusCode !== 200, 'brand owner cannot sign in to admin');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
