import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { User } from '../../domain/types.js';

export async function customerAuthRoutes(app: FastifyInstance) {
  // Customer Registration
  app.post('/api/v1/marketplace/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name, email, password } = (request.body as any) || {};
    if (!name || !email || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Name, email, and password are required.' });
    }

    if (db.getUserByEmail(email)) {
      return reply.status(409).send({ error: 'ConflictError', message: 'Email is already registered.' });
    }

    const newUser: User = {
      id: `user_cust_${Math.random().toString(36).substring(2, 9)}`,
      name,
      email,
      passwordHash: db.hashPassword(password),
      role: 'CUSTOMER',
      createdAt: Date.now()
    };
    db.createUser(newUser);

    const token = app.jwt.sign({ userId: newUser.id, role: newUser.role, email: newUser.email });
    return reply.status(201).send({
      message: 'Customer registered successfully',
      token,
      user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role }
    });
  });

  // Customer Login
  app.post('/api/v1/marketplace/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = (request.body as any) || {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Email and password are required.' });
    }

    const user = db.getUserByEmail(email);
    if (!user || user.passwordHash !== db.hashPassword(password)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid email or password.' });
    }

    const token = app.jwt.sign({ userId: user.id, role: user.role, email: user.email });
    return {
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    };
  });
}
