"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Search, SearchX, X } from "lucide-react";
import { Medallion } from "@/components/expressive";
import { cn } from "@/lib/utils";
import { trackMatcher } from "@/lib/track-filter";

/**
 * Query state of a collection's search. `match` follows `searched`, which
 * lags typing a little so long lists stay smooth: quote `searched`, not
 * `query`, next to its results.
 */
export function useTrackFilter() {
	const [query, setQuery] = useState("");
	const searched = useDeferredValue(query);
	const match = useMemo(() => trackMatcher(searched), [searched]);
	return { query, setQuery, searched, match, active: searched.trim() !== "" };
}

/**
 * Spotify's "Find in playlist": a magnifier that opens into a pill field.
 * Ctrl / ⌘ + F opens it; Escape clears and closes it; it closes on blur
 * while empty.
 */
export function TrackFilter({
	value,
	onChange,
	placeholder = "Search in playlist",
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const expanded = open || value !== "";

	const focus = () => {
		setOpen(true);
		inputRef.current?.focus();
		inputRef.current?.select();
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
			// Leave the browser's find alone while a dialog or Now Playing covers the page.
			const input = inputRef.current;
			if (!input || input.closest("[inert]") || document.querySelector("[role=dialog]")) return;
			e.preventDefault();
			setOpen(true);
			input.focus();
			input.select();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div
			role="search"
			className={cn(
				"flex h-9 shrink-0 items-center overflow-hidden rounded-full transition-[width,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.2,0,0,1)] focus-within:ring-2 focus-within:ring-ring/40",
				expanded ? "w-full bg-surface-high sm:w-72" : "w-9 hover:bg-surface-high",
				className
			)}
		>
			<button
				type="button"
				aria-label={placeholder}
				title={`${placeholder} (Ctrl+F)`}
				tabIndex={expanded ? -1 : 0}
				onClick={focus}
				className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/40 active:scale-90"
			>
				<Search className="size-[18px]" />
			</button>
			<input
				ref={inputRef}
				type="search"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onFocus={() => setOpen(true)}
				onBlur={() => {
					if (!value) setOpen(false);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Escape") return;
					e.preventDefault();
					e.stopPropagation();
					onChange("");
					setOpen(false);
					e.currentTarget.blur();
				}}
				placeholder={placeholder}
				aria-label={placeholder}
				tabIndex={expanded ? 0 : -1}
				autoComplete="off"
				spellCheck={false}
				className="h-full min-w-0 flex-1 bg-transparent pr-1 text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
			/>
			<AnimatePresence initial={false}>
				{value && (
					<motion.button
						type="button"
						aria-label="Clear search"
						initial={{ scale: 0.4, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.4, opacity: 0 }}
						transition={{ duration: 0.18 }}
						onClick={() => {
							onChange("");
							inputRef.current?.focus();
						}}
						className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-surface-highest hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<X className="size-4" />
					</motion.button>
				)}
			</AnimatePresence>
		</div>
	);
}

/** Empty state when the search leaves no track. */
export function NoMatches({ query }: { query: string }) {
	return <Medallion icon={SearchX} title={`No results for “${query.trim()}”`} message="Check the spelling, or try fewer words." className="mt-6" />;
}
