import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';

export async function adminAuthRoutes(app: FastifyInstance) {
  // Super Admin Login
  app.post('/api/v1/admin/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = (request.body as any) || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Email and password are required.' });
    }

    const user = db.getUserByEmail(email);
    if (!user || user.passwordHash !== db.hashPassword(password)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid super-admin credentials.' });
    }

    if (user.role !== 'SUPER_ADMIN') {
      return reply.status(403).send({ error: 'Forbidden', message: 'Access restricted to Platform Super Admins only.' });
    }

    const token = app.jwt.sign({ userId: user.id, role: user.role });

    db.recordAuditLog({
      actorId: user.id,
      actorRole: user.role,
      action: 'ADMIN_LOGIN',
      entity: 'Platform',
      details: { email: user.email }
    });

    return {
      message: 'Super Admin authentication successful',
      token,
      admin: { id: user.id, name: user.name, email: user.email, role: user.role }
    };
  });
}
