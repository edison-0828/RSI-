import crypto from 'crypto';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

export function defaultAllowedOrigins(port) {
  const ports = new Set(['5173', String(port || 8787)]);
  const origins = [];
  for (const p of ports) {
    origins.push(`http://127.0.0.1:${p}`, `http://localhost:${p}`);
  }
  return origins;
}

export function createLocalAccess({ port = 8787, extraOrigins = [], token } = {}) {
  const sessionToken = String(token || crypto.randomBytes(32).toString('base64url'));
  const allowedOrigins = new Set(
    [...defaultAllowedOrigins(port), ...extraOrigins]
      .map(normalizeOrigin)
      .filter(Boolean)
  );

  function originMiddleware(req, res, next) {
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site' || (origin && !allowedOrigins.has(normalizeOrigin(origin)))) {
      return res.status(403).json({ error: '拒绝非本机界面的跨域请求' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin));
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RSI-Session');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  }

  function sameToken(candidate) {
    const a = Buffer.from(String(candidate || ''));
    const b = Buffer.from(sessionToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function mutationAuthMiddleware(req, res, next) {
    if (!req.path.startsWith('/api') || !MUTATION_METHODS.has(req.method)) return next();
    if (!sameToken(req.get('x-rsi-session'))) {
      return res.status(401).json({ error: '本地会话已失效，请刷新页面后重试' });
    }
    next();
  }

  function sessionHandler(_req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.json({ token: sessionToken });
  }

  return { originMiddleware, mutationAuthMiddleware, sessionHandler, allowedOrigins };
}
