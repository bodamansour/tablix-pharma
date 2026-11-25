import http from 'k6/http';
import { check, sleep } from 'k6';
import { safeBase } from './target.js';

const base = safeBase(__ENV.BASE_URL);
export const thresholds = { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'], checks: ['rate>0.99'] };
const headers = { 'Content-Type': 'application/json', 'X-Saydaliti': '1', 'X-Want-Token': '1' };
const opts = { redirects: 0, timeout: '10s' };
export function setup() {
  if (!__ENV.TEST_EMAIL || !__ENV.TEST_PASSWORD || !__ENV.TEST_PHARMACY_ID) throw new Error('Set TEST_EMAIL, TEST_PASSWORD and TEST_PHARMACY_ID for a synthetic test account.');
  const r = http.post(`${base}/api/auth/signin`, JSON.stringify({ email: __ENV.TEST_EMAIL, password: __ENV.TEST_PASSWORD }), { ...opts, headers });
  if (r.status !== 200) throw new Error('Test sign-in failed (response body withheld).');
  const data = r.json();
  if (data.error || !data.data?.access_token) throw new Error('Test account requires a valid non-MFA test session.');
  return { token: data.data.access_token, pharmacy: __ENV.TEST_PHARMACY_ID };
}
export function journey(data) {
  check(http.get(`${base}/api/config`, opts), { 'config OK': r => r.status === 200 });
  const r = http.post(`${base}/api/db`, JSON.stringify({ op: 'select', table: 'catalog_items', cols: 'id, code, name, price', filters: [['pharmacy_id', 'eq', data.pharmacy]], limit: 100 }), { ...opts, headers: { ...headers, Authorization: `Bearer ${data.token}` } });
  check(r, { 'data OK': r => r.status === 200 && r.json().error === null && Array.isArray(r.json().data) });
  check(http.get(`${base}/`, opts), { 'read-only page OK': r => r.status === 200 });
  sleep(1);
}
export function teardown(data) {
  if (data?.token) http.post(`${base}/api/auth/signout`, '{}', { ...opts, headers: { ...headers, Authorization: `Bearer ${data.token}` } });
}
