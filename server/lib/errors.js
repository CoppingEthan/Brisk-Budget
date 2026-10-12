// Errors that map straight onto HTTP responses. Anything else thrown is reported as a 500.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = 'Please sign in') => new HttpError(401, message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);
export const tooLarge = (message = 'That upload is too large') => new HttpError(413, message);
export const tooManyRequests = (message = 'Too many attempts, please wait a few minutes') => new HttpError(429, message);
