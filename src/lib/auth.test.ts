// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from "vitest";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, jwtVerify } from "jose";

// Real better-auth instance on an in-memory DB, so the bearer plugin's
// header → session conversion is exercised end to end.
const db: Record<string, unknown[]> = {
	user: [],
	session: [],
	account: [],
	verification: [],
	jwks: [],
};

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("better-auth/adapters/prisma", () => ({
	prismaAdapter: () => memoryAdapter(db),
}));

type Auth = typeof import("./auth").auth;
const CONVEX_JWT_AUDIENCE = "convex";
let auth: Auth;
let sessionToken: string;

beforeAll(async () => {
	vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-123");
	vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
	vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
	vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
	({ auth } = await import("./auth"));

	const ctx = await auth.$context;
	const user = await ctx.internalAdapter.createUser({
		name: "Flutter User",
		email: "flutter@example.com",
		emailVerified: true,
	});
	const session = await ctx.internalAdapter.createSession(user.id);
	sessionToken = session.token;
});

describe("auth bearer plugin", () => {
	it("resolves the session from an Authorization: Bearer header (was: native clients without cookies got NOT_AUTHENTICATED)", async () => {
		const session = await auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
		});
		expect(session?.user.email).toBe("flutter@example.com");
	});

	it("returns no session for an unknown bearer token", async () => {
		const session = await auth.api.getSession({
			headers: new Headers({ authorization: "Bearer not-a-real-token" }),
		});
		expect(session).toBeNull();
	});

	it("returns no session without any credentials", async () => {
		const session = await auth.api.getSession({ headers: new Headers() });
		expect(session).toBeNull();
	});
});

describe("auth error page (NAV-11)", () => {
	it("sends browser errors to /login (was: Better Auth's raw error page, outside the app)", async () => {
		const ctx = await auth.$context;
		expect(ctx.options.onAPIError?.errorURL).toBe("/login");
	});
});

describe("auth jwt plugin (Convex, docs/adr/0002)", () => {
	it("mints a JWT for a bearer session whose subject is the user id", async () => {
		const ctx = await auth.$context;
		const { token } = await auth.api.getToken({
			headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
		});
		const { keys } = await auth.api.getJwks();
		const jwks = createLocalJWKSet({ keys });
		const { payload, protectedHeader } = await jwtVerify(token, jwks, {
			issuer: "http://localhost:3000",
			audience: CONVEX_JWT_AUDIENCE,
		});
		const session = await ctx.internalAdapter.findSession(sessionToken);
		expect(payload.sub).toBe(session?.user.id);
		expect(protectedHeader.alg).toBe("RS256");
		expect(payload.exp! - payload.iat!).toBe(15 * 60);
	});

	it("refuses to mint a JWT without a session", async () => {
		await expect(auth.api.getToken({ headers: new Headers() })).rejects.toThrow();
	});

	it("does not sign a JWT on every getSession (was: a signature per API call)", async () => {
		const res = await auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${sessionToken}` }),
			asResponse: true,
		});
		expect(res.headers.get("set-auth-jwt")).toBeNull();
	});
});
