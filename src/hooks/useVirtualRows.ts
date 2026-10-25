"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useVirtualizer, useWindowVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { VIRTUAL_OVERSCAN, listOffset, listPadding, shouldVirtualize } from "@/lib/virtual-rows";

/** A stable row key (a track id, an entry id…). */
export type Key = string | number;

export interface VirtualRowsOptions {
	count: number;
	/** Estimated row height in px; real heights are measured once rendered. */
	estimateSize: (index: number) => number;
	/** Stable key per row so measurements survive reorders. */
	getItemKey?: (index: number) => Key;
	/** Space between rows in px — must match the container's CSS gap / space-y. */
	gap?: number;
	/** Row count from which the list virtualizes (default VIRTUALIZE_MIN). */
	min?: number;
}

export interface VirtualRows {
	/** Callback ref for the list container (the element that holds the rows). */
	listRef: (el: HTMLElement | null) => void;
	/** Rows to render, in order. Every row when the list is short. */
	rows: Array<{ index: number; key: Key }>;
	/** Attach to each row, alongside `data-index={index}`. Undefined when not virtualized. */
	measureRef?: (el: Element | null) => void;
	/** Padding for the container that stands in for the unrendered rows. */
	style?: CSSProperties;
}

/**
 * Where the list starts inside its scroller. Re-measured whenever the list,
 * the page or the scroller content resizes (a hero image loading above the
 * list moves it down) and on window resize.
 */
function useScrollMargin(list: HTMLElement | null, scroller: Element | null, isWindow: boolean, enabled: boolean): number {
	const [margin, setMargin] = useState(0);

	useEffect(() => {
		if (!enabled || !list || (!isWindow && !scroller) || typeof ResizeObserver === "undefined") return;
		const update = () => {
			const top = list.getBoundingClientRect().top;
			const next = scroller ? listOffset(top, scroller.getBoundingClientRect().top, scroller.scrollTop) : listOffset(top, 0, window.scrollY);
			setMargin((prev) => (prev === next ? prev : next));
		};
		// ResizeObserver reports once on observe, so this also takes the first measurement.
		const observer = new ResizeObserver(update);
		observer.observe(list);
		observer.observe(scroller?.firstElementChild ?? scroller ?? document.body);
		window.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [enabled, list, scroller, isWindow]);

	return margin;
}

function toRows(
	virtualizer: Virtualizer<Element | Window, Element>,
	enabled: boolean,
	count: number,
	scrollMargin: number,
	getItemKey: ((index: number) => Key) | undefined,
	listRef: (el: HTMLElement | null) => void
): VirtualRows {
	if (!enabled) {
		return { listRef, rows: Array.from({ length: count }, (_, index) => ({ index, key: getItemKey ? getItemKey(index) : index })) };
	}
	const items = virtualizer.getVirtualItems();
	const { paddingTop, paddingBottom } = listPadding(items, virtualizer.getTotalSize(), scrollMargin);
	return {
		listRef,
		rows: items.map((item) => ({ index: item.index, key: item.key as Key })),
		measureRef: virtualizer.measureElement,
		style: { paddingTop, paddingBottom },
	};
}

/** Virtualized rows for a list that scrolls with the page. */
export function useWindowRows({ count, estimateSize, getItemKey, gap = 0, min }: VirtualRowsOptions): VirtualRows {
	const enabled = shouldVirtualize(count, min);
	const [list, setList] = useState<HTMLElement | null>(null);
	const scrollMargin = useScrollMargin(list, null, true, enabled);

	const virtualizer = useWindowVirtualizer<Element>({
		count,
		enabled,
		estimateSize,
		getItemKey,
		gap,
		scrollMargin,
		overscan: VIRTUAL_OVERSCAN,
		useFlushSync: false,
	});

	return toRows(virtualizer as Virtualizer<Element | Window, Element>, enabled, count, scrollMargin, getItemKey, setList);
}

/** Virtualized rows for a list inside a scrolling element (panel, sheet). */
export function useScrollerRows({
	scroller,
	count,
	estimateSize,
	getItemKey,
	gap = 0,
	min,
}: VirtualRowsOptions & { scroller: (list: HTMLElement) => Element | null }): VirtualRows {
	const enabled = shouldVirtualize(count, min);
	const [list, setList] = useState<HTMLElement | null>(null);
	const scrollEl = list ? scroller(list) : null;
	const scrollMargin = useScrollMargin(list, scrollEl, false, enabled);

	// TanStack Virtual hands out new functions every render: the compiler skips this hook, which is fine.
	// eslint-disable-next-line react-hooks/incompatible-library
	const virtualizer = useVirtualizer<Element, Element>({
		count,
		enabled,
		getScrollElement: () => scrollEl,
		estimateSize,
		getItemKey,
		gap,
		scrollMargin,
		overscan: VIRTUAL_OVERSCAN,
		useFlushSync: false,
	});

	return toRows(virtualizer as Virtualizer<Element | Window, Element>, enabled, count, scrollMargin, getItemKey, setList);
}
