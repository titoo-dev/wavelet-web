"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, ArrowLeft, AudioLines, Headphones, MicVocal, RefreshCw, X, type LucideIcon } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { loginHref, safeNext } from "@/lib/login-redirect";
import { useDiscover } from "@/hooks/useDiscover";
import { LogoMark, Spinner } from "@/components/motion/icons";
import { ArtworkWall, Aurora, DUR, EASE, entrance } from "@/components/expressive";

/** Fixed night behind the artwork wall (the hero copy is white on it). */
const NIGHT = "#0a0a12";

/** Drifting wall of new-release artwork, dimmed into the night with a brand glow. */
function Backdrop({ covers }: { covers: string[] }) {
	return (
		<div aria-hidden className="pointer-events-none fixed inset-0">
			<Aurora palette={{ base: NIGHT, lights: ["#38bdf8", "#818cf8", "#f472b6"] }} />
			<AnimatePresence>
				{covers.length >= 8 && (
					<motion.div key="wall" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.9 }} className="absolute inset-0">
						<ArtworkWall urls={covers} columns={7} tilt={-12} period={80} />
					</motion.div>
				)}
			</AnimatePresence>
			{/* Night falls towards the copy and the sheet (phones: downwards; wide: towards the left copy too). */}
			<div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${NIGHT}80 0%, ${NIGHT}c0 35%, ${NIGHT} 78%)` }} />
			<div className="absolute inset-0 hidden lg:block" style={{ background: `linear-gradient(to right, ${NIGHT}e6 0%, ${NIGHT}80 55%, ${NIGHT}a6 100%)` }} />
			{/* Brand light leak behind the copy. */}
			<div className="absolute -bottom-40 -left-40 size-[640px] rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(closest-side, #818cf8, transparent)" }} />
		</div>
	);
}

function Perk({ icon: Icon, label, index }: { icon: LucideIcon; label: string; index: number }) {
	return (
		<motion.span {...entrance(index, 10)} className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.18] bg-white/[0.12] py-[7px] pl-2.5 pr-3.5 text-sm font-semibold text-white backdrop-blur-md">
			<Icon className="size-4" />
			{label}
		</motion.span>
	);
}

/** The Google "G", on a white disc so it reads on any button colour. */
function GoogleMark() {
	return (
		<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white">
			<svg className="size-4" viewBox="0 0 24 24" aria-hidden>
				<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
				<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
				<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
				<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
			</svg>
		</span>
	);
}

const noop = () => () => {};
const param = (name: string) => new URLSearchParams(window.location.search).get(name);
/** The page that sent the user here (`/login?next=…`), in-app paths only. */
const readNext = () => safeNext(param("next"));

/** `?error=` set by Better Auth when the Google round trip fails. */
function oauthErrorMessage(code: string | null) {
	if (!code) return "";
	if (code === "access_denied") return "Google sign-in was cancelled. Try again when you're ready.";
	return "Google sign-in didn't finish. Please try again.";
}

export default function LoginPage() {
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [oauthErrorDismissed, setOauthErrorDismissed] = useState(false);
	const { showcase } = useDiscover();
	const next = useSyncExternalStore(noop, readNext, () => "/");
	const oauthError = useSyncExternalStore(noop, () => oauthErrorMessage(param("error")), () => "");
	const shownError = error || (oauthErrorDismissed ? "" : oauthError);

	// Already signed in (Back into /login, a stale tab): go on to where the user was headed.
	useEffect(() => {
		let live = true;
		authClient
			.getSession()
			.then((res) => {
				if (live && res?.data?.user) router.replace(readNext());
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [router]);

	const dismissError = () => {
		setError("");
		setOauthErrorDismissed(true);
	};

	const handleGoogleSignIn = async () => {
		setLoading(true);
		dismissError();
		try {
			const result = await authClient.signIn.social({
				provider: "google",
				callbackURL: readNext(),
				// A cancelled or failed Google round trip comes back here (with `?error=`), not to Better Auth's error page.
				errorCallbackURL: loginHref(readNext()),
			});
			// The redirect answer of better-auth's social sign-in (the fetch wrapper's or the plain one).
			const data = result as { error?: { message?: string }; url?: string; data?: { url?: string } } | null;
			if (data?.error) {
				setError(data.error.message || "Sign in failed. Please try again.");
				setLoading(false);
				return;
			}
			const url = data?.url || data?.data?.url;
			if (url) {
				// OAuth leaves the app for the provider: a full navigation is the point. `replace` keeps
				// /login out of the history, so Back after signing in doesn't land on the form again.
				// eslint-disable-next-line no-restricted-syntax
				window.location.replace(url);
			} else {
				setError("No redirect URL received. Check your Google OAuth configuration.");
				setLoading(false);
			}
		} catch (e) {
			setError((e as Error)?.message || "Sign in failed. Please try again.");
			setLoading(false);
		}
	};

	return (
		<div className="relative min-h-dvh text-white">
			<Backdrop covers={showcase} />

			<Link
				href={next}
				aria-label="Back"
				className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] z-10 flex size-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md transition-[transform,background-color] hover:bg-white/25 active:scale-90 sm:left-6 sm:top-6"
			>
				<ArrowLeft className="size-5" />
			</Link>

			<div className="relative mx-auto flex min-h-dvh max-w-7xl flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:items-center lg:gap-16 lg:px-16 xl:px-20">
				{/* Hero copy — bottom-anchored on phones, centred on the left when wide. */}
				<div className="flex flex-1 flex-col justify-end px-7 pb-7 pt-24 sm:mx-auto sm:w-full sm:max-w-[560px] sm:px-8 lg:mx-0 lg:max-w-none lg:justify-center lg:px-0 lg:py-16">
					<motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
						<LogoMark animated className="size-16 drop-shadow-[0_12px_28px_rgb(129_140_248/0.45)] lg:size-20" />
					</motion.div>
					<motion.h1 {...entrance(1, 16)} className="type-display mt-7 text-[2.8rem] leading-[1] tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl xl:text-[5.5rem]">
						<span className="block">Music that</span>
						<span className="brand-text block pb-[0.08em]">moves you.</span>
					</motion.h1>
					<motion.p {...entrance(2, 10)} className="mt-4 max-w-md text-base text-white/[0.78] sm:text-lg">
						Full tracks in lossless, lyrics as you listen, and your whole library in one place.
					</motion.p>
					<div className="mt-5 flex flex-wrap gap-2">
						<Perk icon={AudioLines} label="Lossless" index={3} />
						<Perk icon={MicVocal} label="Synced lyrics" index={4} />
						<Perk icon={RefreshCw} label="Library sync" index={5} />
					</div>
				</div>

				{/* Sign-in card: a bottom sheet on phones, a floating card from sm up. */}
				<motion.section
					initial={{ opacity: 0, y: 48 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.18, ease: EASE.decelerate }}
					aria-labelledby="signin-title"
					className="w-full rounded-t-[28px] bg-surface-low px-6 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 text-foreground shadow-[0_-8px_32px_rgb(0_0_0/0.35)] sm:mx-auto sm:mb-8 sm:max-w-[480px] sm:rounded-[28px] sm:px-8 sm:pb-6 sm:pt-8 sm:shadow-[0_24px_64px_-12px_rgb(0_0_0/0.6)] lg:mb-0"
				>
					<div className="mx-auto mb-5 h-1 w-8 rounded-full bg-muted-foreground/40 sm:hidden" />
					<h2 id="signin-title" className="text-2xl font-semibold tracking-[-0.02em]">
						Sign in to wavelet
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">Keep your liked songs, albums and playlists in sync on every device.</p>

					<motion.button
						type="button"
						onClick={handleGoogleSignIn}
						disabled={loading}
						whileTap={{ scale: 0.97 }}
						className="mt-5 flex h-14 w-full items-center justify-center gap-3 rounded-full bg-primary px-6 text-base font-semibold text-primary-foreground shadow-[0_6px_18px_-4px_color-mix(in_srgb,var(--primary)_45%,transparent)] outline-none transition-[background-color,opacity] hover:bg-primary/90 focus-visible:ring-4 focus-visible:ring-ring/40 disabled:opacity-70"
					>
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.span key={loading ? "busy" : "idle"} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: DUR.short }} className="flex items-center gap-3">
								{loading ? <Spinner size={20} /> : <GoogleMark />}
								{loading ? "Signing in…" : "Continue with Google"}
							</motion.span>
						</AnimatePresence>
					</motion.button>

					<AnimatePresence initial={false}>
						{shownError && (
							<motion.div key="error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: DUR.medium, ease: EASE.emphasized }} className="overflow-hidden">
								<div role="alert" className="mt-3 flex items-start gap-3 rounded-2xl bg-destructive/15 py-3 pl-4 pr-2 text-sm text-destructive">
									<AlertCircle className="mt-px size-5 shrink-0" />
									<span className="min-w-0 flex-1 leading-snug">{shownError}</span>
									<button type="button" aria-label="Dismiss" onClick={dismissError} className="-my-1 flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-destructive/10">
										<X className="size-4" />
									</button>
								</div>
							</motion.div>
						)}
					</AnimatePresence>

					<motion.div whileTap={{ scale: 0.97 }} className="mt-3">
						<Link
							href="/"
							className="flex h-14 w-full items-center justify-center gap-2.5 rounded-full bg-secondary px-6 text-base font-semibold text-secondary-foreground no-underline transition-colors hover:bg-secondary/80"
						>
							<Headphones className="size-5" />
							Continue as guest
						</Link>
					</motion.div>

					<p className="mt-5 text-center text-xs text-outline">wavelet is not affiliated with Deezer.</p>
				</motion.section>
			</div>
		</div>
	);
}
