import { describe, expect, it } from "vitest";
import {
  RESERVATION_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from "./reservation-status";

describe("reservation status transitions", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransition("pending", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "checked_in")).toBe(true);
    expect(canTransition("checked_in", "completed")).toBe(true);
  });
  it("rejects invalid transitions", () => {
    expect(canTransition("pending", "checked_in")).toBe(false);
    expect(canTransition("checked_in", "cancelled")).toBe(false);
    expect(canTransition("completed", "checked_in")).toBe(false);
    expect(() => assertTransition("cancelled", "confirmed")).toThrow(/cannot be changed/);
  });
  it("treats completed, cancelled and no-show as terminal", () => {
    const terminal = RESERVATION_STATUSES.filter(isTerminal);
    expect(terminal.sort()).toEqual(["cancelled", "completed", "no_show"]);
  });
});
