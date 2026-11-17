import { EventEmitter } from 'node:events';

/**
 * Tiny in-process event bus. The data layer announces what happened (an order was placed, stock ran low)
 * and other modules (webhooks) react, without the data layer knowing about them.
 */
export interface DomainEventMap {
  'order.created': [order: any];
  'order.status_changed': [payload: { order: any; previousStatus: string }];
  'inventory.low_stock': [payload: { tenantId: string; productId: string; productName: string; variantSku: string; stock: number }];
}

class DomainEvents extends EventEmitter {
  emitSafe<K extends keyof DomainEventMap>(event: K, ...args: DomainEventMap[K]): void {
    try {
      this.emit(event, ...args);
    } catch {
      // a subscriber must never break the business operation that triggered it
    }
  }
}

export const domainEvents = new DomainEvents();
domainEvents.setMaxListeners(20);
