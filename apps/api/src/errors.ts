import type { ApiProblem } from './types.js';

/** A controlled API error that maps 1:1 to an HTTP status + typed envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly expose: boolean;

  constructor(problem: ApiProblem, opts: { expose?: boolean } = {}) {
    super(problem.message);
    this.name = 'ApiError';
    this.code = problem.code;
    this.statusCode = problem.statusCode;
    this.retryable = problem.retryable;
    this.detail = problem.detail;
    this.expose = opts.expose ?? true;
  }
}

export const Errors = {
  notFound: (what: string) =>
    new ApiError({ code: 'NOT_FOUND', message: `${what} not found`, statusCode: 404, retryable: false }),
  unauthorized: (code: string, message: string, detail?: string) =>
    new ApiError({ code, message, statusCode: 401, retryable: false, detail }),
  forbidden: (code: string, message: string) =>
    new ApiError({ code, message, statusCode: 403, retryable: false }),
  conflict: (code: string, message: string) =>
    new ApiError({ code, message, statusCode: 409, retryable: false }),
  invalid: (code: string, message: string, detail?: string) =>
    new ApiError({ code, message, statusCode: 422, retryable: false, detail }),
  rateLimited: (message: string) =>
    new ApiError({ code: 'RATE_LIMITED', message, statusCode: 429, retryable: true }),
  unavailable: (code: string, message: string) =>
    new ApiError({ code, message, statusCode: 503, retryable: true }),
};