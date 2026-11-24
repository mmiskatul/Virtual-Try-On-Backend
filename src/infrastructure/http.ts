import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export function resolveCorrelationId(request: FastifyRequest): string {
  const incoming =
    request.headers['x-correlation-id'] ||
    request.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming.trim().length > 0 && incoming.length <= 128) {
    return incoming.trim();
  }
  return `req_${crypto.randomUUID()}`;
}

export function okResponse<T>(data: T, requestId: string, extraMeta?: Record<string, unknown>) {
  return {
    success: true as const,
    data,
    meta: {
      requestId,
      ...(extraMeta || {}),
    },
  };
}

export function paginatedResponse<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
  requestId: string
) {
  return {
    success: true as const,
    data,
    meta: {
      requestId,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
    },
  };
}

export function errorResponse(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  requestId: string
) {
  return reply.status(statusCode).send({
    success: false as const,
    error: {
      code,
      message,
    },
    meta: {
      requestId,
    },
  });
}


/**
 * Optional paging for list endpoints. Without ?limit the whole list is returned (older clients keep working);
 * with ?limit=50&offset=100 only that slice comes back, and `page` tells the caller how many exist in total.
 */
export function paginate<T>(items: T[], query: unknown): { items: T[]; page?: { total: number; limit: number; offset: number } } {
  const q = (query || {}) as { limit?: string | number; offset?: string | number };
  if (q.limit === undefined || q.limit === '') return { items };
  const limit = Math.min(500, Math.max(1, Math.floor(Number(q.limit)) || 50));
  const offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
  return { items: items.slice(offset, offset + limit), page: { total: items.length, limit, offset } };
}
