import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackFilter } from "./TrackFilter";

function Harness() {
	const [value, setValue] = useState("");
	return (
		<>
			<TrackFilter value={value} onChange={setValue} placeholder="Search in album" />
			<output>{value}</output>
		</>
	);
}

const field = () => screen.getByRole("searchbox", { name: "Search in album" });

describe("TrackFilter", () => {
	it("opens from the magnifier and reports what is typed", async () => {
		render(<Harness />);
		await userEvent.click(screen.getByRole("button", { name: "Search in album" }));
		expect(field()).toHaveFocus();
		await userEvent.keyboard("halo");
		expect(screen.getByRole("status")).toHaveTextContent("halo");
	});

	it("clears with the X and keeps the focus", async () => {
		render(<Harness />);
		await userEvent.type(field(), "halo");
		await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
		expect(field()).toHaveValue("");
		expect(field()).toHaveFocus();
	});

	it("clears and leaves on Escape", async () => {
		render(<Harness />);
		await userEvent.type(field(), "halo{Escape}");
		expect(field()).toHaveValue("");
		expect(field()).not.toHaveFocus();
	});

	it("opens on Ctrl+F instead of the browser's find", () => {
		render(<Harness />);
		const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(field()).toHaveFocus();
	});

	it("leaves Ctrl+F to the browser while a dialog is open", () => {
		render(
			<>
				<Harness />
				<div role="dialog" />
			</>
		);
		expect(fireEvent.keyDown(window, { key: "f", ctrlKey: true })).toBe(true);
		expect(field()).not.toHaveFocus();
	});
});
