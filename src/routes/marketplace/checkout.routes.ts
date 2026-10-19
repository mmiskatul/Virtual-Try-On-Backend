import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../infrastructure/database.js';
import { Order, OrderItem } from '../../domain/types.js';

interface CheckoutItemInput {
  productId: string;
  variantSku: string;
  quantity: number;
}

export async function marketplaceCheckoutRoutes(app: FastifyInstance) {
  // Validate Checkout Basket (Enforces Single-Seller Policy)
  app.post('/api/v1/checkout/validate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { items } = (request.body as { items: CheckoutItemInput[] }) || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        valid: false,
        error: 'ValidationError',
        message: 'Cart cannot be empty.'
      });
    }

    const tenantIds = new Set<string>();
    let subtotal = 0;
    const resolvedItems: OrderItem[] = [];

    for (const item of items) {
      if (!item.productId || !item.variantSku || typeof item.quantity !== 'number' || item.quantity <= 0) {
        return reply.status(400).send({
          valid: false,
          error: 'ValidationError',
          message: 'Invalid item data in cart.'
        });
      }

      const product = db.getProductById(item.productId);
      if (!product) {
        return reply.status(404).send({
          valid: false,
          error: 'NotFound',
          message: `Product '${item.productId}' not found.`
        });
      }

      tenantIds.add(product.tenantId);

      // Single-seller policy check
      if (tenantIds.size > 1) {
        return reply.status(400).send({
          valid: false,
          error: 'MultiSellerError',
          message: 'Your cart contains items from multiple brands. Virtual Try-On orders must be fulfilled by a single brand seller per order.'
        });
      }

      const variant = product.variants.find(v => v.sku === item.variantSku);
      if (!variant) {
        return reply.status(404).send({
          valid: false,
          error: 'VariantNotFound',
          message: `Variant '${item.variantSku}' not found on product '${product.name}'.`
        });
      }

      if (variant.stockQuantity < item.quantity) {
        return reply.status(400).send({
          valid: false,
          error: 'InsufficientStock',
          message: `Insufficient stock for '${product.name}' (${variant.size}/${variant.color}). Requested: ${item.quantity}, available: ${variant.stockQuantity}`
        });
      }

      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      resolvedItems.push({
        productId: product.id,
        variantSku: variant.sku,
        productName: product.name,
        size: variant.size,
        color: variant.color,
        quantity: item.quantity,
        unitPrice: product.price,
        lineTotal,
        imageUrl: product.images[0]
      });
    }

    const singleTenantId = Array.from(tenantIds)[0];
    const tenant = db.getTenantById(singleTenantId);

    if (!tenant || tenant.status !== 'ACTIVE') {
      return reply.status(403).send({
        valid: false,
        error: 'SellerInactive',
        message: 'The seller for these products is currently inactive.'
      });
    }

    return {
      valid: true,
      singleTenantId,
      brandName: tenant.name,
      subtotal,
      shippingFee: subtotal >= 150 ? 0 : 15.0,
      total: subtotal + (subtotal >= 150 ? 0 : 15.0),
      items: resolvedItems
    };
  });

  // Execute Checkout & Order Creation
  const handleCheckout = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as any) || {};
    const { items, shippingAddress, customerEmail } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'ValidationError', message: 'Cart cannot be empty.' });
    }

    if (!customerEmail || !shippingAddress || !shippingAddress.fullName || !shippingAddress.street || !shippingAddress.city) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'customerEmail and complete shippingAddress (fullName, street, city, zipCode, country) are required.'
      });
    }

    const tenantIds = new Set<string>();
    let subtotal = 0;
    const resolvedItems: OrderItem[] = [];

    for (const item of items) {
      const product = db.getProductById(item.productId);
      if (!product) {
        return reply.status(404).send({ error: 'NotFound', message: `Product '${item.productId}' not found.` });
      }
      tenantIds.add(product.tenantId);
      if (tenantIds.size > 1) {
        return reply.status(400).send({
          error: 'MultiSellerError',
          message: 'Single-seller policy violated: Items must be from the same brand.'
        });
      }

      const variant = product.variants.find(v => v.sku === item.variantSku);
      if (!variant || variant.stockQuantity < item.quantity) {
        return reply.status(400).send({
          error: 'InsufficientStock',
          message: `Item '${product.name}' is out of stock.`
        });
      }

      const lineTotal = product.price * item.quantity;
      subtotal += lineTotal;
      resolvedItems.push({
        productId: product.id,
        variantSku: variant.sku,
        productName: product.name,
        size: variant.size,
        color: variant.color,
        quantity: item.quantity,
        unitPrice: product.price,
        lineTotal,
        imageUrl: product.images[0]
      });
    }

    const tenantId = Array.from(tenantIds)[0];
    const shippingFee = subtotal >= 150 ? 0 : 15.0;
    const totalAmount = subtotal + shippingFee;

    try {
      const order = await db.runTransaction(() => {
        // Atomic stock adjustment
        for (const item of resolvedItems) {
          const adj = db.adjustInventory(
            tenantId,
            item.productId,
            item.variantSku,
            -item.quantity,
            `Order Checkout`
          );
          if (!adj.success) {
            throw new Error(`Inventory deduction failed: ${adj.error}`);
          }
        }

        const now = Date.now();
        const newOrder: Order = {
          id: `ord_${Math.random().toString(36).substring(2, 9)}`,
          tenantId,
          customerEmail,
          shippingAddress,
          items: resolvedItems,
          subtotal,
          shippingFee,
          totalAmount,
          status: 'PROCESSING',
          paymentStatus: 'PAID',
          createdAt: now,
          updatedAt: now
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
        order
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'OrderPlacementFailed',
        message: err.message
      });
    }
  };

  app.post('/api/v1/checkout', handleCheckout);
  app.post('/api/v1/orders/checkout', handleCheckout);
}
