/**
 * Errors that are safe to show to salon staff. Anything else is logged server-side
 * and replaced with a generic friendly message — stack traces never reach the browser.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public userMessage: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(userMessage);
  }
}

export const notFound = (what = 'That record') => new AppError(404, `${what} could not be found.`, 'not_found');
export const forbidden = (msg = "You don't have access to that. Ask an administrator if you need it.") => new AppError(403, msg, 'forbidden');
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, 'bad_request', details);

/** Thrown by integration adapters; carries a friendly message and whether a retry may help. */
export class IntegrationError extends Error {
  constructor(
    public provider: 'square' | 'highlevel' | 'sms' | 'ai' | 'email' | 'shopify' | 'gmail',
    public userMessage: string,
    public retryable: boolean,
    public authProblem = false,
    public technical?: string,
  ) {
    super(technical ?? userMessage);
  }
}
