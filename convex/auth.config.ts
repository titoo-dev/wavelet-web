// Convex trusts the short-lived JWTs minted by our better-auth (`jwt` plugin, src/lib/auth.ts),
// not its own Better Auth component (docs/adr/0002). Set BETTER_AUTH_URL on the deployment:
// `npx convex env set BETTER_AUTH_URL https://wavelet.titosy.dev`.
const issuer = process.env.BETTER_AUTH_URL!;

const authConfig = {
	providers: [
		{
			type: "customJwt",
			applicationID: "convex",
			issuer,
			jwks: `${issuer}/api/auth/jwks`,
			algorithm: "RS256",
		},
	],
};

export default authConfig;
