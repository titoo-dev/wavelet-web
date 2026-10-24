import type { NextConfig } from "next";

const REMOTE_API = process.env.REMOTE_API_URL; // e.g. https://music.titosy.dev

const nextConfig: NextConfig = {
	images: {
		unoptimized: true,
	},
	// The share OG image reads its font from disk (src/app/share/t/[shareId]/og-font.ts).
	outputFileTracingIncludes: {
		"/share/t/**": ["./assets/fonts/**/*"],
		// Lyrics Stories draw with these fonts (src/lib/story/fonts.ts).
		"/api/v1/stories/**": ["./assets/fonts/story/**/*"],
	},
	// Native canvas (prebuilt binaries per platform): loaded from node_modules, never bundled.
	serverExternalPackages: ["@napi-rs/canvas"],
	...(REMOTE_API
		? {
				rewrites: async () => [
					{
						source: "/api/:path*",
						destination: `${REMOTE_API}/api/:path*`,
					},
				],
			}
		: {}),
};

export default nextConfig;
