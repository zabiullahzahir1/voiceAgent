import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors';
import { fail } from './envelope';

/**
 * Translate anything thrown inside a route into the standard envelope with a
 * correct status code. Registered once, so no route needs its own try/catch.
 *
 * Status codes used: 400 malformed, 401 unauthenticated, 404 missing,
 * 409 conflict, 422 failed field validation, 500 everything else.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawError: unknown, request, reply) => {
    // Fastify types this as `unknown`; anything can be thrown in JavaScript, so
    // normalise to a shape we can inspect before branching.
    const error = rawError as Error & { statusCode?: number };

    // Our own domain errors already carry the right status and code.
    if (error instanceof AppError) {
      request.log.warn(
        { err: error.code, path: request.url, issues: error.issues },
        'Request rejected',
      );
      return reply.status(error.statusCode).send(fail(error.code, error.message, error.issues));
    }

    // Fastify raises this for a body that is not parseable JSON.
    if (error.statusCode === 400) {
      return reply.status(400).send(fail('BAD_REQUEST', error.message));
    }

    /**
     * Postgres integrity errors that got past Zod. Reaching here means the two
     * layers disagree, which is a bug worth logging loudly — but the offending
     * value still came from the client, so the honest answer is 4xx not 500.
     *
     * 23505 unique_violation · 23514 check_violation
     * 23502 not_null_violation · 23503 foreign_key_violation
     * 22P02 invalid_text_representation (e.g. a malformed UUID)
     */
    const pgCode = (error as unknown as { code?: string }).code;

    if (pgCode === '23505') {
      request.log.warn({ err: error, path: request.url }, 'Unique constraint violated');
      return reply.status(409).send(fail('CONFLICT', 'That record already exists.'));
    }

    if (pgCode && ['23514', '23502', '23503', '22P02'].includes(pgCode)) {
      request.log.error({ err: error, pgCode, path: request.url }, 'Database constraint violated');
      return reply
        .status(422)
        .send(fail('CONSTRAINT_VIOLATION', 'The record violates a database constraint.'));
    }

    // Unknown failure: log the detail, but never leak internals to the client.
    request.log.error({ err: error, path: request.url }, 'Unhandled error');
    return reply
      .status(500)
      .send(fail('INTERNAL_ERROR', 'Something went wrong on our end. Please try again.'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(fail('NOT_FOUND', `No route for ${request.method} ${request.url}.`)),
  );
}
