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

    // A constraint we did not anticipate is a bug, not a client mistake — but
    // it is still the client's field that broke, so answer 422 rather than 500.
    if (typeof error.message === 'string' && error.message.includes('SQLITE_CONSTRAINT')) {
      request.log.error({ err: error, path: request.url }, 'Database constraint violated');
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
