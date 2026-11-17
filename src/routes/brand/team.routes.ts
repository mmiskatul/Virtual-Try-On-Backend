import crypto from 'node:crypto';
import { z } from 'zod';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { config } from '../../infrastructure/config.js';
import { createBrandMiddleware, requireRole } from '../../infrastructure/auth.guard.js';
import { parseWithSchema } from '../../infrastructure/errors.js';
import { emailService } from '../../infrastructure/email.service.js';
import { recordAudit } from '../../modules/audit/audit.service.js';
import { ROLE_DEFINITIONS } from '../../modules/rbac/rbac.catalog.js';
import { revokeAllUserSessions } from '../../modules/auth/jwt.verifier.js';
import { validateStrongPassword } from '../auth/auth.service.js';
import { requireTenantContext } from './profile.service.js';
import type { Tenant, TeamInviteRecord, User, UserRole } from '../../domain/types.js';

const guards = createBrandMiddleware(requireRole('BRAND_OWNER', 'BRAND_ADMIN'));

/** Roles an owner can hand out. The owner role is never assignable. */
export const INVITABLE_ROLES: UserRole[] = [
  'BRAND_ADMIN', 'CATALOG_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'SUPPORT_AGENT', 'ANALYTICS_VIEWER',
];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_SETTLED_MS = 30 * 24 * 60 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const InviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(255).regex(EMAIL, 'Enter a valid email address.'),
  role: z.enum(INVITABLE_ROLES as [UserRole, ...UserRole[]]),
}).strict();
const RoleSchema = z.object({ role: z.enum(INVITABLE_ROLES as [UserRole, ...UserRole[]]) }).strict();
const AcceptSchema = z.object({
  token: z.string().trim().min(20).max(200),
  name: z.string().trim().min(2).max(120),
  password: z.string().max(128),
}).strict();

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const roleName = (code: string) => ROLE_DEFINITIONS.find((r) => r.code === code)?.name || code;

function saveInvites(tenant: Tenant, teamInvites: TeamInviteRecord[]) {
  const now = Date.now();
  const kept = teamInvites.filter((i) => i.status === 'PENDING' || now - (i.settledAt || i.invitedAt) < KEEP_SETTLED_MS);
  return db.updateTenant(tenant.id, { storefrontSettings: { ...(tenant.storefrontSettings || {}), teamInvites: kept } });
}

function publicInvite(i: TeamInviteRecord) {
  const expired = i.status === 'PENDING' && Date.now() > i.expiresAt;
  const { tokenHash: _omit, ...rest } = i;
  return { ...rest, status: expired ? 'EXPIRED' : i.status, roleName: roleName(i.role) };
}

function member(u: User, ownerId?: string) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleName: roleName(u.role),
    isOwner: u.role === 'BRAND_OWNER',
    emailVerified: Boolean(u.emailVerified),
    joinedAt: u.createdAt,
  };
}

const staffOf = (tenantId: string) => db.getUsersByTenant(tenantId).filter((u) => u.role !== 'CUSTOMER');

export async function brandTeamRoutes(app: FastifyInstance) {
  app.get('/api/v1/brand/team', { preHandler: guards }, async (request: FastifyRequest) => {
    const tenant = requireTenantContext(request.tenant);
    return {
      members: staffOf(tenant.id).map((u) => member(u)).sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.joinedAt - b.joinedAt),
      invites: (tenant.storefrontSettings?.teamInvites || []).filter((i) => i.status === 'PENDING').map(publicInvite),
      roles: ROLE_DEFINITIONS.filter((r) => r.code === 'BRAND_OWNER' || INVITABLE_ROLES.includes(r.code as UserRole)).map((r) => ({
        code: r.code, name: r.name, description: r.description, permissions: r.permissions.filter((p) => p.startsWith('brand:')),
      })),
    };
  });

  app.post('/api/v1/brand/team/invites', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const input = parseWithSchema(InviteSchema, request.body ?? {});
    if (db.getUserByEmail(input.email)) {
      return reply.status(409).send({
        error: 'EmailInUse',
        message: 'That email already has an account. Ask them to use a different email address for the team.',
      });
    }
    const token = `${Buffer.from(tenant.id).toString('base64url')}.${crypto.randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    const invite: TeamInviteRecord = {
      id: `inv_${crypto.randomBytes(6).toString('hex')}`,
      email: input.email,
      role: input.role,
      tokenHash: hash(token),
      invitedBy: request.authUser!.id,
      invitedAt: now,
      expiresAt: now + INVITE_TTL_MS,
      status: 'PENDING',
    };
    // Re-inviting the same email replaces the earlier pending invite.
    const others = (tenant.storefrontSettings?.teamInvites || []).map((i) =>
      i.email === input.email && i.status === 'PENDING' ? { ...i, status: 'REVOKED' as const, settledAt: now } : i,
    );
    saveInvites(tenant, [...others, invite]);

    const inviteUrl = `${config.brandDashboardUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
    const sent = await emailService.sendTeamInviteEmail({
      to: input.email, inviterName: request.authUser!.name, brandName: tenant.name, roleName: roleName(input.role), inviteUrl,
    });
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'TEAM_INVITE_SENT', entity: 'TeamInvite', entityId: invite.id, correlationId: request.correlationId,
      details: { email: input.email, role: input.role },
    });
    // The link is shown once to the person inviting, so it can be copied if the email is slow.
    return reply.status(201).send({ invite: publicInvite(invite), inviteUrl, emailDelivered: Boolean(sent.delivered) });
  });

  app.delete('/api/v1/brand/team/invites/:id', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { id } = request.params as { id: string };
    const invites = tenant.storefrontSettings?.teamInvites || [];
    if (!invites.some((i) => i.id === id && i.status === 'PENDING')) {
      return reply.status(404).send({ error: 'NotFound', message: 'Invitation not found.' });
    }
    saveInvites(tenant, invites.map((i) => (i.id === id ? { ...i, status: 'REVOKED' as const, settledAt: Date.now() } : i)));
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'TEAM_INVITE_REVOKED', entity: 'TeamInvite', entityId: id, correlationId: request.correlationId,
    });
    return { revoked: true };
  });

  app.patch('/api/v1/brand/team/members/:userId', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { userId } = request.params as { userId: string };
    const { role } = parseWithSchema(RoleSchema, request.body ?? {});
    const target = db.getUserById(userId);
    if (!target || target.tenantId !== tenant.id || target.role === 'CUSTOMER') {
      return reply.status(404).send({ error: 'NotFound', message: 'Team member not found.' });
    }
    if (target.role === 'BRAND_OWNER') return reply.status(403).send({ error: 'Forbidden', message: 'The owner role cannot be changed.' });
    if (target.id === request.authUser!.id) return reply.status(403).send({ error: 'Forbidden', message: 'You cannot change your own role.' });
    db.updateUser(target.id, { role });
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'TEAM_MEMBER_ROLE_CHANGED', entity: 'User', entityId: target.id, correlationId: request.correlationId,
      details: { from: target.role, to: role },
    });
    return { member: member(db.getUserById(target.id)!) };
  });

  app.delete('/api/v1/brand/team/members/:userId', { preHandler: guards }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = requireTenantContext(request.tenant);
    const { userId } = request.params as { userId: string };
    const target = db.getUserById(userId);
    if (!target || target.tenantId !== tenant.id || target.role === 'CUSTOMER') {
      return reply.status(404).send({ error: 'NotFound', message: 'Team member not found.' });
    }
    if (target.role === 'BRAND_OWNER') return reply.status(403).send({ error: 'Forbidden', message: 'The owner cannot be removed.' });
    if (target.id === request.authUser!.id) return reply.status(403).send({ error: 'Forbidden', message: 'You cannot remove yourself.' });
    await revokeAllUserSessions(target.id);
    db.deleteUser(target.id);
    await recordAudit({
      actorId: request.authUser!.id, actorRole: request.authUser!.role, tenantId: tenant.id,
      action: 'TEAM_MEMBER_REMOVED', entity: 'User', entityId: target.id, correlationId: request.correlationId,
      details: { email: target.email, role: target.role },
    });
    return { removed: true };
  });

  // Public: the invited person sets their name and password. The token is the proof of the invitation.
  app.post('/api/v1/auth/accept-invite', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseWithSchema(AcceptSchema, request.body ?? {});
    const bad = () => reply.status(400).send({ error: 'InvalidInvite', message: 'This invitation is not valid. Ask for a new one.' });

    const [tenantPart] = input.token.split('.');
    let tenantId = '';
    try {
      tenantId = Buffer.from(tenantPart, 'base64url').toString('utf8');
    } catch {
      return bad();
    }
    const tenant = db.getTenantById(tenantId);
    const invite = (tenant?.storefrontSettings?.teamInvites || []).find((i) => i.tokenHash === hash(input.token));
    if (!tenant || tenant.status !== 'ACTIVE' || !invite || invite.status !== 'PENDING' || Date.now() > invite.expiresAt) return bad();

    const policy = validateStrongPassword(input.password);
    if (policy) return reply.status(400).send({ error: 'WeakPassword', message: policy });
    if (db.getUserByEmail(invite.email)) {
      return reply.status(409).send({ error: 'EmailInUse', message: 'An account with this email already exists.' });
    }

    const now = Date.now();
    const user: User = {
      id: `user_${crypto.randomBytes(5).toString('hex')}`,
      tenantId: tenant.id,
      name: input.name,
      email: invite.email,
      passwordHash: db.hashPassword(input.password),
      role: invite.role,
      emailVerified: true, // the invitation email itself proved they own this address
      emailVerifiedAt: now,
      createdAt: now,
    };
    db.createUser(user);
    saveInvites(tenant, (tenant.storefrontSettings?.teamInvites || []).map((i) =>
      i.id === invite.id ? { ...i, status: 'ACCEPTED' as const, settledAt: now } : i,
    ));
    await recordAudit({
      actorId: user.id, actorRole: user.role, tenantId: tenant.id,
      action: 'TEAM_INVITE_ACCEPTED', entity: 'TeamInvite', entityId: invite.id, correlationId: request.correlationId,
    });
    return reply.status(201).send({ accepted: true, email: user.email, brandName: tenant.name });
  });
}
