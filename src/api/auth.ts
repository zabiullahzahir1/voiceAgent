import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { UnauthorizedError } from '../lib/errors';

/**
 * Optional bearer-token guard for the mutating endpoints.
 *
 * If `API_TOKEN` is unset the guard is a no-op, which keeps local development
 * and the reviewer's first `curl` frictionless. When it *is* set, comparison is
 * timing-safe. This is deliberately minimal — a real deployment would use
 * per-client credentials; see "Known limitations" in the README.
 */
export async function requireApiToken(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!env.apiToken) return;

  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!provided || !timingSafeEqual(provided, env.apiToken)) {
    throw new UnauthorizedError('A valid Bearer token is required for this endpoint.');
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  // Compare hashes so differing lengths cannot short-circuit the comparison.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(bufferA).digest(),
    crypto.createHash('sha256').update(bufferB).digest(),
  );
}
