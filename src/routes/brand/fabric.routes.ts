import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Fabric } from '../../domain/types.js';
import {
  createBrandMiddleware,
  registerScopedPreHandlers,
} from '../../infrastructure/auth.guard.js';
import { db } from '../../infrastructure/database.js';
import { NotFoundException, parseWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  CreateFabricInputSchema,
  FabricIdParamsSchema,
  UpdateFabricInputSchema,
} from './product.schemas.js';
import { requireTenantContext } from './profile.service.js';

const brandFabricReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandFabricWriteGuards = createBrandMiddleware(requirePermission('brand:products', 'write'));

export async function brandFabricRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, brandFabricReadGuards);

  // List Fabrics
  app.get('/api/v1/fabrics', { preHandler: brandFabricReadGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const fabrics = db.getFabricsByTenant(tenant.id);
    return { fabrics };
  });

  // Create Fabric
  app.post('/api/v1/fabrics', { preHandler: brandFabricWriteGuards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const body = parseWithSchema(CreateFabricInputSchema, request.body ?? {});

    const fabric: Fabric = {
      id: `fab_${Math.random().toString(36).substring(2, 9)}`,
      tenantId: tenant.id,
      name: body.name,
      composition: body.composition,
      color: body.color || 'Default',
      pattern: body.pattern || 'Solid',
      textureUrl: body.textureUrl,
      weightGsm: body.weightGsm !== undefined ? Number(body.weightGsm) : undefined,
      stretch: body.stretch || 'NONE',
      transparency: body.transparency || 'OPAQUE',
      thickness: body.thickness || 'MEDIUM',
      careInstructions: body.careInstructions || body.care || 'Dry clean recommended.',
      createdAt: Date.now(),
    };

    const created = db.createFabric(fabric);
    return reply.status(201).send({ message: 'Fabric created successfully', fabric: created });
  });

  // Update Fabric (whitelist allowed fields)
  app.put('/api/v1/fabrics/:id', { preHandler: brandFabricWriteGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(FabricIdParamsSchema, request.params ?? {});
    const body = parseWithSchema(UpdateFabricInputSchema, request.body ?? {});

    const safeUpdates: Partial<Fabric> = {};
    if (body.name !== undefined) safeUpdates.name = body.name;
    if (body.composition !== undefined) safeUpdates.composition = body.composition;
    if (body.color !== undefined) safeUpdates.color = body.color;
    if (body.pattern !== undefined) safeUpdates.pattern = body.pattern;
    if (body.textureUrl !== undefined) safeUpdates.textureUrl = body.textureUrl;
    if (body.weightGsm !== undefined) safeUpdates.weightGsm = Number(body.weightGsm);
    if (body.stretch !== undefined) safeUpdates.stretch = body.stretch;
    if (body.transparency !== undefined) safeUpdates.transparency = body.transparency;
    if (body.thickness !== undefined) safeUpdates.thickness = body.thickness;
    if (body.careInstructions !== undefined || body.care !== undefined) {
      safeUpdates.careInstructions = body.careInstructions ?? body.care;
    }

    const updated = db.updateFabric(id, tenant.id, safeUpdates);
    if (!updated) {
      throw new NotFoundException('Fabric not found in your tenant catalog.');
    }
    return { message: 'Fabric updated successfully', fabric: updated };
  });

  // Delete Fabric
  app.delete('/api/v1/fabrics/:id', { preHandler: brandFabricWriteGuards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = parseWithSchema(FabricIdParamsSchema, request.params ?? {});
    const deleted = db.deleteFabric(id, tenant.id);
    if (!deleted) {
      throw new NotFoundException('Fabric not found in your tenant catalog.');
    }
    return { message: 'Fabric deleted successfully' };
  });
}
