import type { RequestHandler } from 'express';

/**
 * Headers for a JSON-only API. Written by hand instead of pulling in helmet so it is obvious
 * which ZAP baseline rules each line answers (see zap/rules.tsv).
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=()',
    'cache-control': 'no-store',
  });
  next();
};
