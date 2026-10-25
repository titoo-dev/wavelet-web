import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import { withExplicitSslMode } from "@/lib/db-url";

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined;
};

function createPrismaClient() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	const pool = new Pool({ connectionString: withExplicitSslMode(connectionString) });
	// Fluid compute reuses instances between requests: let Vercel drain idle
	// connections before an instance is suspended so they don't leak on the
	// Postgres side. No-op outside Vercel.
	attachDatabasePool(pool);
	// @prisma/adapter-pg pins an older @types/pg; the runtime `pg` is the same
	// package, only the declaration files differ.
	const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
	return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma;
}
