import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { idempotencyManager } from '../../infrastructure/idempotency.js';

export async function brandInventoryRoutes(app: FastifyInstance) {
  // Adjust Stock Atomically
  app.post('/api/v1/inventory/adjust', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { productId, variantSku, change, reason } = (request.body as any) || {};
    if (!productId || !variantSku || typeof change !== 'number') {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'productId, variantSku, and change (number) are required.'
      });
    }

    const tenantId = request.tenant!.id;
    const idempotencyKey = (request.headers['idempotency-key'] || request.headers['x-idempotency-key']) as string | undefined;
    let compositeKey: string | undefined;

    if (idempotencyKey) {
      compositeKey = idempotencyManager.getCompositeKey(idempotencyKey, tenantId);
      const existing = idempotencyManager.getRecord(compositeKey);
      if (existing) {
        if (existing.status === 'PROCESSING') {
          return reply.status(409).send({
            error: 'ConflictError',
            code: 'CONCURRENT_REQUEST_IN_FLIGHT',
            message: 'A request with this Idempotency-Key is currently being processed.'
          });
        }
        if (existing.status === 'COMPLETED') {
          const currentHash = idempotencyManager.computeHash(request.body);
          if (existing.requestHash !== currentHash) {
            return reply.status(422).send({
              error: 'UnprocessableEntity',
              code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
              message: 'Idempotency key was previously used with a different request payload.'
            });
          }
          reply.header('idempotency-replay', 'true');
          return reply.status(existing.statusCode || 200).send(existing.responsePayload);
        }
      }

      idempotencyManager.startOperation(
        compositeKey,
        idempotencyKey,
        tenantId,
        idempotencyManager.computeHash(request.body)
      );
    }

    try {
      const result = await db.runTransaction(() => {
        return db.adjustInventory(tenantId, productId, variantSku, change, reason || 'Manual stock adjustment');
      });

      if (!result.success) {
        if (compositeKey) {
          idempotencyManager.failOperation(compositeKey);
        }
        return reply.status(400).send({
          error: 'InventoryError',
          message: result.error
        });
      }

      const responsePayload = {
        message: 'Inventory adjusted successfully',
        newStock: result.newStock
      };

      if (compositeKey) {
        idempotencyManager.completeOperation(compositeKey, 200, responsePayload);
      }

      return reply.status(200).send(responsePayload);
    } catch (err: any) {
      if (compositeKey) {
        idempotencyManager.failOperation(compositeKey);
      }
      throw err;
    }
  });

  // Inventory Audit Logs
  app.get('/api/v1/inventory/logs', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const { productId } = request.query as { productId?: string };
    const logs = db.getInventoryLogs(request.tenant!.id, productId);
    return { logs };
  });
}
