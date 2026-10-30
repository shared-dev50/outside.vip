import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { sanitizeErrorMessage } from '../modules/finance/stripeError.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  // Handle AppError (custom operational errors)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        message: sanitizeErrorMessage(err.message),
        statusCode: err.statusCode,
        code: err.code || (err.statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST'),
      },
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    res.status(400).json({
      success: false,
      error: {
        message: 'Validation failed',
        statusCode: 400,
        details: formattedErrors,
      },
    });
    return;
  }

  // Handle Prisma unique constraint violation (P2002)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[])?.join(', ') || 'field';
      res.status(409).json({
        success: false,
        error: {
          message: `A record with this ${target} already exists.`,
          statusCode: 409,
        },
      });
      return;
    }

    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        error: {
          message: 'Requested record was not found.',
          statusCode: 404,
        },
      });
      return;
    }
  }

  console.error('Unhandled Server Error:', err);

  res.status(500).json({
    success: false,
    error: {
      message: 'Internal server error',
      statusCode: 500,
    },
  });
}
