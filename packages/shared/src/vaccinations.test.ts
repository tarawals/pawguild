import { describe, expect, it } from "vitest";
import { checkVaccinations, vaccinationsOk } from "./vaccinations";

const req = ["Rabies", "DHPP", "Bordetella"];

describe("vaccination requirements", () => {
  it("passes when every required vaccine is valid through the last day", () => {
    const r = checkVaccinations(req, [
      { vaccine: "rabies", expiresOn: "2027-01-01" },
      { vaccine: " DHPP ", expiresOn: "2026-07-04" },
      { vaccine: "Bordetella", expiresOn: "2026-12-31" },
    ], "2026-07-01", "2026-07-04");
    expect(vaccinationsOk(r)).toBe(true);
  });

  it("reports missing, expired and expiring-mid-stay separately", () => {
    const r = checkVaccinations(req, [
      { vaccine: "Rabies", expiresOn: "2026-06-30" },
      { vaccine: "Bordetella", expiresOn: "2026-07-02" },
    ], "2026-07-01", "2026-07-04");
    expect(r.map((c) => c.state)).toEqual(["expired", "missing", "expires_during_stay"]);
    expect(vaccinationsOk(r)).toBe(false);
  });

  it("uses the latest record when a vaccine was renewed", () => {
    const r = checkVaccinations(["Rabies"], [
      { vaccine: "Rabies", expiresOn: "2025-01-01" },
      { vaccine: "Rabies", expiresOn: "2028-01-01" },
    ], "2026-07-01", "2026-07-01");
    expect(r[0]).toEqual({ vaccine: "Rabies", state: "current", expiresOn: "2028-01-01" });
  });

  it("is trivially ok when nothing is required", () => {
    expect(vaccinationsOk(checkVaccinations([], [], "2026-07-01", "2026-07-01"))).toBe(true);
  });
});
