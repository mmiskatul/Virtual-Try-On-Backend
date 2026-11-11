import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { recordAudit } from '../audit/audit.service.js';
import { adminControlPlaneService } from '../admin/control_plane.service.js';

export interface CartEntryDto {
  productId: string;
  tenantId: string;
  sku: string;
  name: string;
  size: string;
  color: string;
  unitPrice: number;
  quantity: number;
  image?: string;
}

export interface ReviewDto {
  id: string;
  tenantId: string;
  productId: string;
  userId: string;
  authorName: string;
  rating: number;
  comment: string;
  verifiedBuy: boolean;
  brandReply?: string;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  userId?: string;
  tenantId?: string;
  channel: 'IN_APP' | 'EMAIL';
  title: string;
  body: string;
  readAt?: string;
  createdAt: string;
}

const memoryCarts = new Map<string, CartEntryDto[]>();
const memoryFavorites = new Map<string, Set<string>>();
const memoryReviews = new Map<string, ReviewDto[]>();
const memoryNotifications = new Map<string, NotificationDto[]>();

export class CommerceEngagementService {
  // --- Server-Side Cart ---
  public getCart(userId: string) {
    const items = memoryCarts.get(userId) || [];
    const groupedByTenant: Record<string, { tenantId: string; items: CartEntryDto[]; subtotal: number }> = {};
    for (const item of items) {
      if (!groupedByTenant[item.tenantId]) {
        groupedByTenant[item.tenantId] = { tenantId: item.tenantId, items: [], subtotal: 0 };
      }
      groupedByTenant[item.tenantId].items.push(item);
      groupedByTenant[item.tenantId].subtotal += item.unitPrice * item.quantity;
    }
    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    return { items, sellerGroups: Object.values(groupedByTenant), subtotal };
  }

  public addToCart(userId: string, input: { productId: string; sku?: string; quantity: number }) {
    const product = db.getProducts().find((p) => p.id === input.productId);
    if (!product || !product.marketplacePublished) {
      return { ok: false as const, status: 404, error: 'NotFound', message: 'Published marketplace product not found.' };
    }
    const variant = product.variants?.find((v) => !input.sku || v.sku === input.sku) || product.variants?.[0];
    const sku = variant?.sku || product.sku;
    const list = [...(memoryCarts.get(userId) || [])];
    const existing = list.find((i) => i.productId === product.id && i.sku === sku);
    if (existing) {
      existing.quantity += input.quantity;
    } else {
      list.push({
        productId: product.id,
        tenantId: product.tenantId,
        sku,
        name: product.name,
        size: variant?.size || 'M',
        color: variant?.color || 'Default',
        unitPrice: product.price,
        quantity: input.quantity,
        image: product.images?.[0],
      });
    }
    memoryCarts.set(userId, list);
    return { ok: true as const, cart: this.getCart(userId) };
  }

  public removeFromCart(userId: string, sku: string) {
    const next = (memoryCarts.get(userId) || []).filter((i) => i.sku !== sku);
    memoryCarts.set(userId, next);
    return this.getCart(userId);
  }

  // --- Favorites ---
  public listFavorites(userId: string): string[] {
    return Array.from(memoryFavorites.get(userId) || []);
  }

  public async addFavorite(userId: string, productId: string): Promise<boolean> {
    const product = db.getProducts().find((p) => p.id === productId);
    if (!product) return false;
    const set = memoryFavorites.get(userId) || new Set<string>();
    set.add(productId);
    memoryFavorites.set(userId, set);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const profile = await prisma.userProfile.findUnique({ where: { userId } });
        if (profile) {
          await prisma.favorite.upsert({
            where: { userProfileId_productId: { userProfileId: profile.id, productId } },
            update: {},
            create: { userProfileId: profile.id, productId },
          });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'commerce.favorite_add_prisma_warning');
      }
    }
    return true;
  }

  public async removeFavorite(userId: string, productId: string): Promise<string[]> {
    const set = memoryFavorites.get(userId) || new Set<string>();
    set.delete(productId);
    memoryFavorites.set(userId, set);
    return Array.from(set);
  }

  // --- Reviews ---
  public listProductReviews(productId: string) {
    const list = memoryReviews.get(productId) || [];
    const avg = list.length > 0 ? Number((list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(2)) : 0;
    return { reviews: list, averageRating: avg, totalCount: list.length };
  }

  public async createReview(input: {
    productId: string;
    userId: string;
    userEmail: string;
    userName: string;
    rating: number;
    comment: string;
  }) {
    const product = db.getProducts().find((p) => p.id === input.productId);
    if (!product) {
      return { ok: false as const, status: 404, error: 'NotFound', message: 'Product not found.' };
    }

    const userOrders = db.getOrders().filter(
      (o) =>
        (o.customerId === input.userId || o.customerEmail.toLowerCase() === input.userEmail.toLowerCase()) &&
        o.paymentStatus === 'PAID'
    );
    const verifiedBuy = userOrders.some((o) => o.items?.some((item) => item.productId === product.id));

    const review: ReviewDto = {
      id: crypto.randomUUID(),
      tenantId: product.tenantId,
      productId: product.id,
      userId: input.userId,
      authorName: input.userName,
      rating: input.rating,
      comment: input.comment.trim(),
      verifiedBuy,
      createdAt: new Date().toISOString(),
    };

    const existing = memoryReviews.get(product.id) || [];
    memoryReviews.set(product.id, [review, ...existing]);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        const userRecord = db.getUserById(input.userId);
        const profile = await prisma.userProfile.upsert({
          where: { userId: input.userId },
          update: {},
          create: { userId: input.userId, displayName: userRecord?.name || input.userName },
        });
        await prisma.review.create({
          data: {
            id: review.id,
            tenantId: review.tenantId,
            productId: review.productId,
            userProfileId: profile.id,
            rating: review.rating,
            comment: review.comment,
            verifiedBuy: review.verifiedBuy,
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'commerce.create_review_prisma_warning');
      }
    }

    return { ok: true as const, review };
  }

  public async replyToReview(reviewId: string, tenantId: string, replyText: string, actorId: string) {
    for (const [productId, reviews] of memoryReviews.entries()) {
      const target = reviews.find((r) => r.id === reviewId);
      if (target) {
        if (target.tenantId !== tenantId) {
          return { ok: false as const, status: 403, error: 'Forbidden', message: 'Cannot reply to reviews outside your brand tenant.' };
        }
        target.brandReply = replyText.trim();
        memoryReviews.set(productId, [...reviews]);

        const prisma = getGlobalPrisma();
        if (prisma) {
          try {
            await prisma.review.update({
              where: { id: reviewId },
              data: { brandReply: target.brandReply },
            });
          } catch {
            // ignore
          }
        }

        await recordAudit({
          actorId,
          actorRole: 'BRAND_OWNER',
          tenantId,
          action: 'BRAND_REVIEW_REPLIED',
          entity: 'Review',
          entityId: reviewId,
        });

        return { ok: true as const, review: target };
      }
    }
    return { ok: false as const, status: 404, error: 'NotFound', message: 'Review not found.' };
  }

  // --- Notifications ---
  public notifyUser(userId: string, title: string, body: string, tenantId?: string) {
    const list = memoryNotifications.get(userId) || [];
    const item: NotificationDto = {
      id: crypto.randomUUID(),
      userId,
      tenantId,
      channel: 'IN_APP',
      title,
      body,
      createdAt: new Date().toISOString(),
    };
    memoryNotifications.set(userId, [item, ...list]);
    return item;
  }

  public listNotifications(userId: string) {
    return memoryNotifications.get(userId) || [];
  }

  public markNotificationRead(userId: string, notificationId: string) {
    const list = memoryNotifications.get(userId) || [];
    const target = list.find((n) => n.id === notificationId);
    if (!target) return null;
    target.readAt = new Date().toISOString();
    return target;
  }

  // --- Customer Orders ---
  public listOrdersForUser(userId: string, email: string, tenantId?: string) {
    const all = db.getOrders();
    if (tenantId) return all.filter((o) => o.tenantId === tenantId);
    const eLower = email.toLowerCase();
    return all.filter((o) => o.customerId === userId || o.customerEmail.toLowerCase() === eLower);
  }

  // --- GDPR Export & Delete Request ---
  public exportAccountData(userId: string) {
    const user = db.getUserById(userId);
    if (!user) return null;
    const orders = this.listOrdersForUser(userId, user.email, user.tenantId);
    const favorites = this.listFavorites(userId);
    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        emailVerified: user.emailVerified,
        createdAt: new Date(user.createdAt).toISOString(),
      },
      favorites,
      orders,
      notifications: this.listNotifications(userId),
    };
  }

  public async submitDeletionRequest(userId: string, email: string, tenantId?: string) {
    const effectiveTenantId = tenantId || db.getTenants()[0]?.id || 'tenant_aura';
    const req = await adminControlPlaneService.createGovernanceRequest({
      tenantId: effectiveTenantId,
      type: 'DELETE',
      requester: email,
    });
    await recordAudit({
      actorId: userId,
      actorRole: 'CUSTOMER',
      tenantId,
      action: 'GDPR_DELETE_REQUESTED',
      entity: 'DataGovernanceRequest',
      entityId: req.id,
    });
    return req;
  }
}

export const commerceEngagementService = new CommerceEngagementService();

