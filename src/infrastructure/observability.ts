export interface SystemMetrics {
  uptimeSeconds: number;
  memoryUsageMb: number;
  totalRequests: number;
  activeRequests: number;
  statusCodes: Record<string, number>;
}

class ObservabilityManager {
  private startTime: number = Date.now();
  private totalRequests: number = 0;
  private activeRequests: number = 0;
  private statusCodes: Record<string, number> = {};

  public trackRequestStart(): void {
    this.totalRequests++;
    this.activeRequests++;
  }

  public trackRequestEnd(statusCode: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const codeKey = `${Math.floor(statusCode / 100)}xx`;
    this.statusCodes[codeKey] = (this.statusCodes[codeKey] || 0) + 1;
  }

  public getMetrics(): SystemMetrics {
    const memory = process.memoryUsage();
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      memoryUsageMb: Number((memory.heapUsed / 1024 / 1024).toFixed(2)),
      totalRequests: this.totalRequests,
      activeRequests: this.activeRequests,
      statusCodes: { ...this.statusCodes }
    };
  }
}

export const observability = new ObservabilityManager();
