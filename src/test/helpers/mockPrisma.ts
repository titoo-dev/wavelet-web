import { mockDeep, mockReset } from "vitest-mock-extended";

/**
 * Deep-mocked Prisma client shared across tests.
 *
 * Typed as `any` on purpose: deep-mocking the real `PrismaClient` from the
 * Prisma 7 generated client triggers TS2615 "circular reference" errors in
 * `tsc --noEmit` because of Prisma's recursive `*WhereWithAggregatesInput`
 * generics. We don't need the precise surface inside tests — every call is
 * a stub like `prismaMock.savedTrack.findMany.mockResolvedValue(...)`, which
 * works fine without the generated types.
 *
 * Usage:
 *
 *   import { vi, beforeEach } from "vitest";
 *   import { prismaMock, resetPrismaMock } from "@/test/helpers/mockPrisma";
 *
 *   vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
 *
 *   beforeEach(() => resetPrismaMock());
 *
 *   it("...", async () => {
 *     prismaMock.storedTrack.findFirst.mockResolvedValue({ ... });
 *   });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped on purpose, see above (TS2615 on the real PrismaClient)
export const prismaMock: any = mockDeep<any>();

export function resetPrismaMock() {
	mockReset(prismaMock);
}
