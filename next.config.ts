import type { NextConfig } from "next";

const REMOTE_API = process.env.REMOTE_API_URL; // e.g. https://music.titosy.dev

const nextConfig: NextConfig = {
	images: {
		unoptimized: true,
	},
	// The share OG image reads its font from disk (src/app/share/t/[shareId]/og-font.ts).
	outputFileTracingIncludes: {
		"/share/t/**": ["./assets/fonts/**/*"],
		// Lyrics Stories draw with these fonts (src/lib/story/fonts.ts) and encode with ffmpeg (render.ts).
		"/api/v1/stories/**": ["./assets/fonts/story/**/*", "./node_modules/ffmpeg-static/ffmpeg"],
	},
	// Native canvas (prebuilt binaries per platform) and ffmpeg-static (finds its binary from its own
	// folder): loaded from node_modules, never bundled.
	serverExternalPackages: ["@napi-rs/canvas", "ffmpeg-static"],
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
