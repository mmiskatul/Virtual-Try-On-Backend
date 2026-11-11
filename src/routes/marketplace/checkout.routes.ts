import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { resolveOptionalAuthUser } from '../../infrastructure/auth.guard.js';
import { Order, OrderItem } from '../../domain/types.js';

interface CheckoutItemInput {
  productId: string;
  variantSku: string;
  quantity: number;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCartItems(items: any[]): {
  ok: true;
  tenantId: string;
  brandName: string;
  subtotal: number;
  shippingFee: number;
  total: number;
  resolvedItems: OrderItem[];
} | { ok: false; status: number; error: string; message: string } {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'Cart cannot be empty.' };
  }
  if (items.length > 50) {
    return { ok: false, status: 400, error: 'ValidationError', message: 'Cart exceeds maximum 50 line items.' };
  }

  const tenantIds = new Set<string>();
  let subtotal = 0;
  const resolvedItems: OrderItem[] = [];

  for (const item of items) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      typeof item.variantSku !== 'string' ||
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > 100
    ) {
      return {
        ok: false,
        status: 400,
        error: 'ValidationError',
        message: 'Each item must have a valid productId, variantSku, and positive integer quantity (1-100).',
      };
    }

    const product = db.getProductById(item.productId);
    if (!product) {
      return {
        ok: false,
        status: 404,
        error: 'NotFound',
        message: `Product '${item.productId}' not found.`,
      };
    }

    if (!product.marketplacePublished && !product.brandStorefrontPublished) {
      return {
        ok: false,
        status: 400,
        error: 'ProductUnavailable',
        message: `Product '${product.name}' is not currently published for sale.`,
      };
    }

    tenantIds.add(product.tenantId);

    if (tenantIds.size > 1) {
      return {
        ok: false,
        status: 400,
        error: 'MultiSellerError',
        message:
          'Your cart contains items from multiple brands. Virtual Try-On orders must be fulfilled by a single brand seller per order.',
      };
    }

    const variant = product.variants.find((v) => v.sku === item.variantSku);
    if (!variant) {
      return {
        ok: false,
        status: 404,
        error: 'VariantNotFound',
        message: `Variant '${item.variantSku}' not found on product '${product.name}'.`,
      };
    }

    if (variant.stockQuantity < item.quantity) {
      return {
        ok: false,
        status: 400,
        error: 'InsufficientStock',
        message: `Insufficient stock for '${product.name}' (${variant.size}/${variant.color}). Requested: ${item.quantity}, available: ${variant.stockQuantity}`,
      };
    }

    const lineTotal = Number((product.price * item.quantity).toFixed(2));
    subtotal = Number((subtotal + lineTotal).toFixed(2));
    resolvedItems.push({
      productId: product.id,
      variantSku: variant.sku,
      productName: product.name,
      size: variant.size,
      color: variant.color,
      quantity: item.quantity,
      unitPrice: product.price,
      lineTotal,
      imageUrl: product.images[0],
    });
  }

  const singleTenantId = Array.from(tenantIds)[0];
  const tenant = db.getTenantById(singleTenantId);
  if (!tenant || tenant.status !== 'ACTIVE') {
    return {
      ok: false,
      status: 403,
      error: 'SellerInactive',
      message: 'The seller for these products is currently inactive.',
    };
  }

  const shippingFee = subtotal >= 150 ? 0 : 15.0;
  const total = Number((subtotal + shippingFee).toFixed(2));

  return {
    ok: true,
    tenantId: singleTenantId,
    brandName: tenant.name,
    subtotal,
    shippingFee,
    total,
    resolvedItems,
  };
}

export async function marketplaceCheckoutRoutes(app: FastifyInstance) {
  // Validate Checkout Basket (Enforces Single-Seller Policy)
  app.post('/api/v1/checkout/validate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { items } = (request.body as { items: CheckoutItemInput[] }) || {};
    const validation = validateCartItems(items);

    if (!validation.ok) {
      return reply.status(validation.status).send({
        valid: false,
        error: validation.error,
        message: validation.message,
      });
    }

    return {
      valid: true,
      singleTenantId: validation.tenantId,
      brandName: validation.brandName,
      subtotal: validation.subtotal,
      shippingFee: validation.shippingFee,
      total: validation.total,
      items: validation.resolvedItems,
    };
  });

  // Execute Checkout & Order Creation
  const handleCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const { items, shippingAddress, customerEmail } = body;

    if (
      typeof customerEmail !== 'string' ||
      !EMAIL_REGEX.test(customerEmail.trim()) ||
      !shippingAddress ||
      typeof shippingAddress.fullName !== 'string' ||
      !shippingAddress.fullName.trim() ||
      typeof shippingAddress.street !== 'string' ||
      !shippingAddress.street.trim() ||
      typeof shippingAddress.city !== 'string' ||
      !shippingAddress.city.trim()
    ) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Valid customerEmail and complete shippingAddress (fullName, street, city, zipCode, country) are required.',
      });
    }

    const validation = validateCartItems(items);
    if (!validation.ok) {
      return reply.status(validation.status).send({
        error: validation.error,
        message: validation.message,
      });
    }

    // Optional customer association if a valid HttpOnly cookie or Bearer JWT is present
    const { user: optionalUser } = await resolveOptionalAuthUser(request);
    const customerId = optionalUser?.id;

    try {
      const order = await db.runTransaction(() => {
        for (const item of validation.resolvedItems) {
          const adj = db.adjustInventory(
            validation.tenantId,
            item.productId,
            item.variantSku,
            -item.quantity,
            'Order Checkout'
          );
          if (!adj.success) {
            throw new Error(`Inventory deduction failed: ${adj.error}`);
          }
        }

        const now = Date.now();
        const newOrder: Order = {
          id: `ord_${Math.random().toString(36).substring(2, 9)}`,
          tenantId: validation.tenantId,
          customerId,
          customerEmail: customerEmail.trim().toLowerCase(),
          shippingAddress,
          items: validation.resolvedItems,
          subtotal: validation.subtotal,
          shippingFee: validation.shippingFee,
          totalAmount: validation.total,
          status: 'PROCESSING',
          paymentStatus: 'PAID',
          createdAt: now,
          updatedAt: now,
        };

        db.createOrder(newOrder);
        return newOrder;
      });

      return reply.status(201).send({
        message: 'Order placed successfully',
        orderId: order.id,
        status: order.status,
        subtotal: order.subtotal,
        shippingFee: order.shippingFee,
        total: order.totalAmount,
        order,
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'OrderPlacementFailed',
        message: err.message,
      });
    }
  };

  app.post('/api/v1/checkout', handleCheckout);
  app.post('/api/v1/orders/checkout', handleCheckout);
}
