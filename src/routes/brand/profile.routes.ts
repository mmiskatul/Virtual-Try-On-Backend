import { FastifyInstance, FastifyRequest } from 'fastify';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { parseWithSchema, validateOutputWithSchema } from '../../infrastructure/errors.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import {
  BrandDetailsPatchInputSchema,
  BrandIdentityPatchInputSchema,
  BrandMediaMutationResponseSchema,
  BrandMediaSlotParamsSchema,
  BrandMediaSlotPutInputSchema,
  BrandSectionMutationResponseSchema,
  BrandVerificationResponseSchema,
} from './profile.schemas.js';
import {
  applyBrandDetailsUpdate,
  applyBrandIdentityUpdate,
  applyBrandMediaSlotUpdate,
  computeBrandVerificationSummary,
  normalizeTenantForOutput,
  requireTenantContext,
} from './profile.service.js';

const brandReadGuards = createBrandMiddleware(requirePermission('brand:products', 'read'));
const brandOwnerGuards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

function actorFromRequest(request: FastifyRequest) {
  return request.authUser ? { id: request.authUser.id, role: request.authUser.role } : undefined;
}

export async function brandProfileRoutes(app: FastifyInstance) {
  // Section 1: Core Brand Profile, Legal Details & Story
  app.patch(
    '/api/v1/brand/profile/details',
    { preHandler: brandOwnerGuards },
    async (request: FastifyRequest) => {
      const tenant = requireTenantContext(request.tenant);
      const input = parseWithSchema(BrandDetailsPatchInputSchema, request.body ?? {});
      const updated = applyBrandDetailsUpdate(tenant, input, actorFromRequest(request));
      const normalized = normalizeTenantForOutput(updated);
      return validateOutputWithSchema(
        BrandSectionMutationResponseSchema,
        {
          message: 'Brand profile details updated successfully.',
          section: 'profile',
          tenant: normalized,
          verification: computeBrandVerificationSummary(normalized),
        },
        'PATCH /api/v1/brand/profile/details'
      );
    }
  );

  // Section 1b: Brand Verification & Readiness Summary
  app.get(
    '/api/v1/brand/verification',
    { preHandler: brandReadGuards },
    async (request: FastifyRequest) => {
      const tenant = requireTenantContext(request.tenant);
      const summary = computeBrandVerificationSummary(normalizeTenantForOutput(tenant));
      return validateOutputWithSchema(
        BrandVerificationResponseSchema,
        summary,
        'GET /api/v1/brand/verification'
      );
    }
  );

  // Section 2: Storefront Theme Palette, Typography & Header Identity
  app.patch(
    '/api/v1/brand/identity',
    { preHandler: brandOwnerGuards },
    async (request: FastifyRequest) => {
      const tenant = requireTenantContext(request.tenant);
      const input = parseWithSchema(BrandIdentityPatchInputSchema, request.body ?? {});
      const updated = applyBrandIdentityUpdate(tenant, input, actorFromRequest(request));
      return validateOutputWithSchema(
        BrandSectionMutationResponseSchema,
        {
          message: 'Brand theme and visual identity updated successfully.',
          section: 'identity',
          tenant: normalizeTenantForOutput(updated),
        },
        'PATCH /api/v1/brand/identity'
      );
    }
  );

  // Section 3: Brand Media Assets Slot Upsert (logo, banner, lightLogo, socialImage)
  app.put(
    '/api/v1/brand/media/:slot',
    { preHandler: brandOwnerGuards },
    async (request: FastifyRequest) => {
      const tenant = requireTenantContext(request.tenant);
      const { slot } = parseWithSchema(BrandMediaSlotParamsSchema, request.params ?? {});
      const { url } = parseWithSchema(BrandMediaSlotPutInputSchema, request.body ?? {});
      const updated = applyBrandMediaSlotUpdate(tenant, slot, url, actorFromRequest(request));
      return validateOutputWithSchema(
        BrandMediaMutationResponseSchema,
        {
          message: `Updated ${slot} brand asset successfully.`,
          slot,
          url: url.trim(),
          tenant: normalizeTenantForOutput(updated),
        },
        'PUT /api/v1/brand/media/:slot'
      );
    }
  );

  // Section 3b: Brand Media Asset Slot Removal
  app.delete(
    '/api/v1/brand/media/:slot',
    { preHandler: brandOwnerGuards },
    async (request: FastifyRequest) => {
      const tenant = requireTenantContext(request.tenant);
      const { slot } = parseWithSchema(BrandMediaSlotParamsSchema, request.params ?? {});
      const updated = applyBrandMediaSlotUpdate(tenant, slot, '', actorFromRequest(request));
      return validateOutputWithSchema(
        BrandMediaMutationResponseSchema,
        {
          message: `Removed ${slot} brand asset successfully.`,
          slot,
          url: '',
          tenant: normalizeTenantForOutput(updated),
        },
        'DELETE /api/v1/brand/media/:slot'
      );
    }
  );
}

