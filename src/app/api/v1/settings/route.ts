import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { ok, fail, handleError, requireApp, requireUser } from "../_lib/helpers";

// GET /api/v1/settings — Get settings (per-user if authenticated, defaults otherwise)
export async function GET(request: NextRequest) {
	try {
		const { app, error: appError } = await requireApp();
		if (appError) return appError;

		const globalSettings = app.getSettings();

		// Try to get per-user settings if authenticated
		const userResult = await requireUser(request);
		if (!userResult.error) {
			const userSettings = await prisma.userSettings.findUnique({
				where: { userId: userResult.userId },
			});
			if (userSettings?.settings) {
				return ok({
					settings: {
						...globalSettings.settings,
						...(userSettings.settings as Record<string, unknown>),
					},
					defaultSettings: globalSettings.defaultSettings,
				});
			}
		}

		return ok(globalSettings);
	} catch (e) {
		return handleError(e);
	}
}

// POST /api/v1/settings — Save the signed-in user's settings. Body: { settings }
// Server-wide settings are never written here (the quality has its own admin
// route). A `spotifySettings` field is ignored: nothing reads it since the
// Spotify plugin was removed, and the old global save dropped it anyway.
export async function POST(request: NextRequest) {
	try {
		const userResult = await requireUser(request);
		if (userResult.error) return userResult.error;
		const { app, error: appError } = await requireApp();
		if (appError) return appError;

		let body: { settings?: Prisma.InputJsonObject | null };
		try {
			body = await request.json();
		} catch {
			return fail("INVALID_BODY", "Expected a JSON body.", 400);
		}
		// A body without `settings` would wipe the stored ones: refuse it.
		// `settings: null` stays an explicit reset.
		if (!body || typeof body !== "object" || !("settings" in body)) {
			return fail("INVALID_BODY", "settings is required.", 400);
		}
		const settings = body.settings;

		await prisma.userSettings.upsert({
			where: { userId: userResult.userId },
			update: { settings: settings ?? {} },
			create: { userId: userResult.userId, settings: settings ?? {} },
		});

		// Return the merged settings
		const globalSettings = app.getSettings();
		return ok({
			settings: settings ?? globalSettings.settings,
			defaultSettings: globalSettings.defaultSettings,
		});
	} catch (e) {
		return handleError(e);
	}
}
