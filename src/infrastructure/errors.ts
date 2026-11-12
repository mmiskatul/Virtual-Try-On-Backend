import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface ApiErrorPayload {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  issues?: ValidationIssue[];
  details?: Record<string, unknown>;
  correlationId?: string;
  timestamp: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorName: string;
  public readonly code: string;
  public readonly issues?: ValidationIssue[];
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(params: {
    statusCode: number;
    errorName: string;
    code: string;
    message: string;
    issues?: ValidationIssue[];
    details?: Record<string, unknown>;
    isOperational?: boolean;
  }) {
    super(params.message);
    this.name = params.errorName;
    this.statusCode = params.statusCode;
    this.errorName = params.errorName;
    this.code = params.code;
    this.issues = params.issues;
    this.details = params.details;
    this.isOperational = params.isOperational ?? true;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationException extends AppError {
  constructor(message = 'Request validation failed.', issues?: ValidationIssue[]) {
    super({
      statusCode: 400,
      errorName: 'ValidationError',
      code: 'VALIDATION_ERROR',
      message,
      issues,
    });
  }
}

export class UnauthorizedException extends AppError {
  constructor(message = 'Authentication is required.', code = 'UNAUTHORIZED') {
    super({ statusCode: 401, errorName: 'Unauthorized', code, message });
  }
}

export class ForbiddenException extends AppError {
  constructor(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    super({ statusCode: 403, errorName: 'Forbidden', code, message });
  }
}

export class NotFoundException extends AppError {
  constructor(message = 'Requested resource was not found.', code = 'NOT_FOUND') {
    super({ statusCode: 404, errorName: 'NotFound', code, message });
  }
}

export class ConflictException extends AppError {
  constructor(message = 'Resource conflict detected.', code = 'CONFLICT', details?: Record<string, unknown>) {
    super({ statusCode: 409, errorName: 'Conflict', code, message, details });
  }
}

export class PayloadTooLargeException extends AppError {
  constructor(message = 'Uploaded payload exceeds the maximum allowed size.', code = 'PAYLOAD_TOO_LARGE') {
    super({ statusCode: 413, errorName: 'PayloadTooLarge', code, message });
  }
}

export class UnprocessableEntityException extends AppError {
  constructor(message = 'Unable to process request entity.', issues?: ValidationIssue[]) {
    super({
      statusCode: 422,
      errorName: 'UnprocessableEntity',
      code: 'UNPROCESSABLE_ENTITY',
      message,
      issues,
    });
  }
}

export class InternalServerException extends AppError {
  constructor(message = 'An internal server error occurred.', code = 'INTERNAL_ERROR') {
    super({ statusCode: 500, errorName: 'InternalError', code, message, isOperational: false });
  }
}

export function zodIssuesToValidationIssues(zodError: z.ZodError): ValidationIssue[] {
  return zodError.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown, fallbackMessage?: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = zodIssuesToValidationIssues(parsed.error);
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new ValidationException(summary || fallbackMessage || 'Validation failed.', issues);
  }
  return parsed.data;
}

export function validateOutputWithSchema<T>(schema: z.ZodType<T>, payload: unknown, routeLabel: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    console.error(`[ContractError] Output validation failed on ${routeLabel}: ${details}`);
    throw new InternalServerException('Response contract validation failed.', 'RESPONSE_CONTRACT_ERROR');
  }
  return parsed.data;
}

export function prismaErrorToAppError(error: unknown): AppError | null {
  const err = error as { code?: string; meta?: { target?: string[] | string } } | null;
  if (!err || typeof err.code !== 'string' || !err.code.startsWith('P')) {
    return null;
  }

  switch (err.code) {
    case 'P2002': {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
      return new ConflictException(
        target ? `A record with this ${target} already exists.` : 'Duplicate record violates a unique constraint.',
        'UNIQUE_CONSTRAINT_VIOLATION',
        target ? { target } : undefined
      );
    }
    case 'P2025':
      return new NotFoundException('Requested database record does not exist.', 'RECORD_NOT_FOUND');
    case 'P2003':
      return new ConflictException('Operation violates a related record reference.', 'FOREIGN_KEY_VIOLATION');
    case 'P2000':
    case 'P2023':
      return new ValidationException('Provided field value exceeds limits or has an invalid format.');
    default:
      return new InternalServerException('Database operation failed.', 'DATABASE_ERROR');
  }
}

function buildErrorPayload(
  appErr: AppError,
  correlationId?: string
): ApiErrorPayload {
  return {
    statusCode: appErr.statusCode,
    error: appErr.errorName,
    code: appErr.code,
    message: appErr.message,
    ...(appErr.issues && appErr.issues.length > 0 ? { issues: appErr.issues } : {}),
    ...(appErr.details ? { details: appErr.details } : {}),
    ...(correlationId ? { correlationId } : {}),
    timestamp: new Date().toISOString(),
  };
}

export function globalErrorHandler(error: any, request: FastifyRequest, reply: FastifyReply) {
  const correlationId = request.correlationId;

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send(buildErrorPayload(error, correlationId));
  }

  if (error instanceof z.ZodError || (error?.name === 'ZodError' && Array.isArray(error?.issues))) {
    const issues = zodIssuesToValidationIssues(error as z.ZodError);
    const appErr = new ValidationException(
      issues.map((i) => `${i.path}: ${i.message}`).join('; ') || 'Request validation failed.',
      issues
    );
    return reply.status(400).send(buildErrorPayload(appErr, correlationId));
  }

  const prismaAppErr = prismaErrorToAppError(error);
  if (prismaAppErr) {
    return reply.status(prismaAppErr.statusCode).send(buildErrorPayload(prismaAppErr, correlationId));
  }

  // Fastify multipart / payload / schema validation errors
  if (error?.code === 'FST_REQ_FILE_TOO_LARGE' || error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error?.statusCode === 413) {
    const appErr = new PayloadTooLargeException(error?.message || 'Payload exceeds maximum limit.');
    return reply.status(413).send(buildErrorPayload(appErr, correlationId));
  }

  if (Array.isArray(error?.validation)) {
    const issues: ValidationIssue[] = error.validation.map((v: any) => ({
      path: v.instancePath || v.params?.missingProperty || 'body',
      message: v.message || 'Invalid parameter',
      code: v.keyword,
    }));
    const appErr = new ValidationException(error.message || 'Request schema validation failed.', issues);
    return reply.status(400).send(buildErrorPayload(appErr, correlationId));
  }

  if (error?.statusCode && typeof error.statusCode === 'number' && error.statusCode < 500) {
    const appErr = new AppError({
      statusCode: error.statusCode,
      errorName: error.name || 'BadRequest',
      code: typeof error.code === 'string' ? error.code : 'REQUEST_ERROR',
      message: error.message || 'Bad request',
    });
    return reply.status(appErr.statusCode).send(buildErrorPayload(appErr, correlationId));
  }

  // Never leak stack traces or internal DB details on 500 errors
  console.error(`[UnhandledError][${correlationId || 'no-cid'}]`, error);
  const safeInternal = new InternalServerException('Internal Server Error');
  return reply.status(500).send(buildErrorPayload(safeInternal, correlationId));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  const err = new NotFoundException(`Route ${request.method} ${request.url} not found.`, 'ROUTE_NOT_FOUND');
  return reply.status(404).send(buildErrorPayload(err, request.correlationId));
}

