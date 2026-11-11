import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: {
    service: 'vton-fastify-backend',
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.secretHash',
      '*.apiKey',
      '*.serviceRoleKey',
      '*.token',
      '*.pass',
      'databaseUrl',
    ],
    censor: '[REDACTED]',
  },
});

export function childLogger(correlationId: string, extras?: Record<string, unknown>) {
  return logger.child({ correlationId, ...(extras || {}) });
}

