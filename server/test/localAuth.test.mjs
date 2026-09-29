import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAccess, defaultAllowedOrigins } from '../localAuth.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

function request({ method = 'GET', path = '/api/health', origin, token, fetchSite } = {}) {
  return {
    method,
    path,
    get(name) {
      const key = name.toLowerCase();
      if (key === 'origin') return origin;
      if (key === 'x-rsi-session') return token;
      if (key === 'sec-fetch-site') return fetchSite;
      return undefined;
    },
  };
}

test('只允许本机 UI Origin，拒绝任意网页跨域', () => {
  const access = createLocalAccess({ port: 8787, token: 'test-token' });
  const okRes = response();
  let next = false;
  access.originMiddleware(request({ origin: 'http://127.0.0.1:5173' }), okRes, () => { next = true; });
  assert.equal(next, true);
  assert.equal(okRes.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5173');

  const badRes = response();
  access.originMiddleware(request({ origin: 'https://evil.example' }), badRes, () => assert.fail('不应放行'));
  assert.equal(badRes.statusCode, 403);

  const crossSiteRes = response();
  access.originMiddleware(request({ fetchSite: 'cross-site' }), crossSiteRes, () => assert.fail('不应放行'));
  assert.equal(crossSiteRes.statusCode, 403);
});

test('所有写 API 必须携带正确会话令牌', () => {
  const access = createLocalAccess({ token: 'known-token' });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const denied = response();
    access.mutationAuthMiddleware(request({ method, path: '/api/scan/start' }), denied, () => assert.fail('不应放行'));
    assert.equal(denied.statusCode, 401);

    let next = false;
    access.mutationAuthMiddleware(request({ method, path: '/api/scan/start', token: 'known-token' }), response(), () => { next = true; });
    assert.equal(next, true);
  }
});

test('默认允许开发与生产使用的本机地址', () => {
  assert.deepEqual(defaultAllowedOrigins(8787), [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]);
});
