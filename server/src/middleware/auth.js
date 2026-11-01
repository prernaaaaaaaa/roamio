import jwt from 'jsonwebtoken';

export function signToken(user, secret) {
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: '7d', algorithm: 'HS256' });
}

/** Attach req.user when a valid Bearer token is present; never fails the request. */
export function optionalAuth(secret) {
  return (req, _res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m) {
      try {
        const p = jwt.verify(m[1], secret, { algorithms: ['HS256'] });
        req.user = { id: String(p.sub), email: p.email };
      } catch {
        /* treat as anonymous */
      }
    }
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Please sign in.' } });
  next();
}
