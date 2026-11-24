/** Suspension flags kept in memory so the check also works when no Prisma database is connected. */
export type AccountStatus = 'ACTIVE' | 'SUSPENDED';

export const memoryUserStatus = new Map<string, AccountStatus>();

export function isUserSuspendedInMemory(userId: string): boolean {
  return memoryUserStatus.get(userId) === 'SUSPENDED';
}
