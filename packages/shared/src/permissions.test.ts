import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, hasPermission } from "./permissions";

describe("permissions", () => {
  it("gives owners every permission", () => {
    for (const p of PERMISSIONS) expect(hasPermission("owner", p)).toBe(true);
  });
  it("restricts care attendants", () => {
    expect(hasPermission("care_attendant", "care:record")).toBe(true);
    expect(hasPermission("care_attendant", "billing:refund")).toBe(false);
    expect(hasPermission("care_attendant", "customers:write")).toBe(false);
  });
  it("only lets managers and above refund", () => {
    expect(hasPermission("front_desk", "billing:refund")).toBe(false);
    expect(hasPermission("manager", "billing:refund")).toBe(true);
  });
  it("defines only known permissions for every role", () => {
    for (const role of ROLES)
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
