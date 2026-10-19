import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { authenticateToken } from '../../infrastructure/auth.guard.js';
import { Fabric } from '../../domain/types.js';

export async function brandFabricRoutes(app: FastifyInstance) {
  // List Fabrics
  app.get('/api/v1/fabrics', { preHandler: [authenticateToken] }, async (request: FastifyRequest) => {
    const fabrics = db.getFabricsByTenant(request.tenant!.id);
    return { fabrics };
  });

  // Create Fabric
  app.post('/api/v1/fabrics', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const { name, composition, color, pattern } = body || {};
    if (!name || !composition) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Fabric name and composition are required.'
      });
    }

    const fabric: Fabric = {
      id: `fab_${Math.random().toString(36).substring(2, 9)}`,
      tenantId: request.tenant!.id,
      name,
      composition,
      color: color || 'Default',
      pattern: pattern || 'Solid',
      textureUrl: body.textureUrl,
      weightGsm: body.weightGsm ? Number(body.weightGsm) : undefined,
      stretch: body.stretch || 'NONE',
      transparency: body.transparency || 'OPAQUE',
      thickness: body.thickness || 'MEDIUM',
      careInstructions: body.careInstructions || 'Dry clean recommended.',
      createdAt: Date.now()
    };

    const created = db.createFabric(fabric);
    return reply.status(201).send({ message: 'Fabric created successfully', fabric: created });
  });

  // Update Fabric
  app.put('/api/v1/fabrics/:id', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<Fabric>;
    const updated = db.updateFabric(id, request.tenant!.id, body);
    if (!updated) {
      return reply.status(404).send({ error: 'NotFound', message: 'Fabric not found in your tenant catalog.' });
    }
    return { message: 'Fabric updated successfully', fabric: updated };
  });

  // Delete Fabric
  app.delete('/api/v1/fabrics/:id', { preHandler: [authenticateToken] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const deleted = db.deleteFabric(id, request.tenant!.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'NotFound', message: 'Fabric not found in your tenant catalog.' });
    }
    return { message: 'Fabric deleted successfully' };
  });
}
