/**
 * Application error types.
 *
 * The service layer throws these; the HTTP layer (`src/api/error-handler.ts`)
 * and the voice tool layer (`src/voice/tools.ts`) each translate them into the
 * shape their consumer expects — an HTTP envelope, or a spoken-language hint
 * for the LLM. Business logic never knows about HTTP.
 */

export type FieldIssue = {
  /** Snake_case field name, matching the data model and the voice tool schema. */
  field: string;
  /** Human-readable and safe to speak aloud to the caller. */
  message: string;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly issues: FieldIssue[];

  constructor(message: string, statusCode: number, code: string, issues: FieldIssue[] = []) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.issues = issues;
  }
}

/** 422 — the request was well-formed but individual fields failed validation. */
export class ValidationError extends AppError {
  constructor(issues: FieldIssue[], message = 'One or more fields are invalid.') {
    super(message, 422, 'VALIDATION_ERROR', issues);
  }
}

/** 404 — no such patient, or it has been soft-deleted. */
export class NotFoundError extends AppError {
  constructor(message = 'Patient not found.') {
    super(message, 404, 'NOT_FOUND');
  }
}

/** 409 — an active patient already exists with this phone number. */
export class ConflictError extends AppError {
  readonly existingPatientId?: string;

  constructor(message: string, existingPatientId?: string) {
    super(message, 409, 'CONFLICT');
    this.existingPatientId = existingPatientId;
  }
}

/** 400 — malformed request (bad JSON body, unusable query parameter, etc.). */
export class BadRequestError extends AppError {
  constructor(message = 'Malformed request.', issues: FieldIssue[] = []) {
    super(message, 400, 'BAD_REQUEST', issues);
  }
}

/** 401 — missing or wrong credentials. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials.') {
    super(message, 401, 'UNAUTHORIZED');
  }
}
