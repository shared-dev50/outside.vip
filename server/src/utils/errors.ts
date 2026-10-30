export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;

  constructor(message: string, statusCode = 500, isOperational = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(message, 404, true, code);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST') {
    super(message, 400, true, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(message, 401, true, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Permission denied', code = 'FORBIDDEN') {
    super(message, 403, true, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict detected', code = 'CONFLICT') {
    super(message, 409, true, code);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', code = 'TOO_MANY_REQUESTS') {
    super(message, 429, true, code);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(message, 503, true, code);
  }
}

