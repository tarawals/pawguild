import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, ROLE_RANK, hasPermission } from "./permissions";

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
  it("only lets managers and above book over capacity", () => {
    for (const role of ["front_desk", "shift_lead", "groomer", "care_attendant", "employee"] as const)
      expect(hasPermission(role, "reservations:override_capacity")).toBe(false);
    for (const role of ["owner", "administrator", "general_manager", "location_manager", "manager"] as const)
      expect(hasPermission(role, "reservations:override_capacity")).toBe(true);
  });
  it("only lets managers and above book outside business hours", () => {
    for (const role of ["front_desk", "shift_lead", "groomer", "care_attendant", "employee"] as const)
      expect(hasPermission(role, "reservations:override_hours")).toBe(false);
    for (const role of ["owner", "administrator", "general_manager", "location_manager", "manager"] as const)
      expect(hasPermission(role, "reservations:override_hours")).toBe(true);
  });
  it("only lets managers and above check in without required vaccinations", () => {
    for (const role of ["front_desk", "shift_lead", "groomer", "care_attendant", "employee"] as const)
      expect(hasPermission(role, "stays:override_vaccinations")).toBe(false);
    for (const role of ["owner", "administrator", "general_manager", "location_manager", "manager"] as const)
      expect(hasPermission(role, "stays:override_vaccinations")).toBe(true);
  });
  it("only lets managers and above resolve incidents; care staff can report them", () => {
    expect(hasPermission("care_attendant", "incidents:record")).toBe(true);
    for (const role of ["front_desk", "shift_lead", "groomer", "care_attendant", "employee"] as const)
      expect(hasPermission(role, "incidents:resolve")).toBe(false);
    expect(hasPermission("manager", "incidents:resolve")).toBe(true);
  });
  it("defines only known permissions for every role", () => {
    for (const role of ROLES)
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});

import { canAssignRole, canManageStaffMember } from "./permissions";
describe("staff management seniority", () => {
  it("never lets anyone grant a role at or above their own (except owners)", () => {
    for (const actor of ROLES) for (const role of ROLES) {
      if (actor !== "owner" && canAssignRole(actor, role)) expect(ROLE_RANK[role]).toBeLessThan(ROLE_RANK[actor]);
    }
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("administrator", "owner")).toBe(false);
    expect(canAssignRole("administrator", "administrator")).toBe(false);
    expect(canAssignRole("general_manager", "location_manager")).toBe(true);
    expect(canAssignRole("location_manager", "general_manager")).toBe(false);
    expect(canAssignRole("location_manager", "front_desk")).toBe(true);
  });
  it("only roles with employees:manage can manage staff, and only juniors", () => {
    expect(canManageStaffMember("manager", "front_desk")).toBe(false); // managers lack employees:manage
    expect(canManageStaffMember("front_desk", "employee")).toBe(false);
    expect(canManageStaffMember("general_manager", "general_manager")).toBe(false);
    expect(canManageStaffMember("administrator", "owner")).toBe(false);
    expect(canManageStaffMember("owner", "owner")).toBe(true);
  });
});
