import type { FieldIssue } from '../lib/errors';

/**
 * Every response from this API — success or failure — uses one envelope:
 *
 *   { "data": <payload|null>, "error": <object|null> }
 *
 * A consumer can therefore always branch on `error === null` without having to
 * know the endpoint. This is the shape the assessment specifies.
 */

export type ApiEnvelope<T> = {
  data: T | null;
  error: { code: string; message: string; issues?: FieldIssue[] } | null;
};

export function ok<T>(data: T): ApiEnvelope<T> {
  return { data, error: null };
}

export function fail(code: string, message: string, issues?: FieldIssue[]): ApiEnvelope<never> {
  return {
    data: null,
    error: issues && issues.length > 0 ? { code, message, issues } : { code, message },
  };
}
