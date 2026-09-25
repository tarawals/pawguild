/**
 * Role-based access control. Roles map to permissions here, in one place.
 * Server code checks permissions (never role names) so roles can later become
 * organization-configurable without touching every route.
 */
export const PERMISSIONS = [
  "customers:read",
  "customers:write",
  "pets:read",
  "pets:write",
  "reservations:read",
  "reservations:write",
  "reservations:override_capacity",
  "stays:check_in_out",
  "stays:override_vaccinations",
  "care:record",
  "incidents:record",
  "incidents:resolve",
  "services:manage",
  "resources:manage",
  "billing:read",
  "billing:write",
  "billing:refund",
  "employees:read",
  "employees:manage",
  "locations:manage",
  "settings:manage",
  "reports:read",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "owner",
  "administrator",
  "general_manager",
  "location_manager",
  "manager",
  "shift_lead",
  "front_desk",
  "groomer",
  "care_attendant",
  "employee",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  administrator: "Administrator",
  general_manager: "General Manager",
  location_manager: "Location Manager",
  manager: "Manager",
  shift_lead: "Shift Lead",
  front_desk: "Front Desk",
  groomer: "Groomer",
  care_attendant: "Care Attendant",
  employee: "Employee",
};

const ALL: readonly Permission[] = PERMISSIONS;

const FRONT_DESK: readonly Permission[] = [
  "customers:read",
  "customers:write",
  "pets:read",
  "pets:write",
  "reservations:read",
  "reservations:write",
  "stays:check_in_out",
  "care:record",
  "incidents:record",
  "billing:read",
  "billing:write",
  "employees:read",
];

const CARE: readonly Permission[] = [
  "customers:read",
  "pets:read",
  "reservations:read",
  "care:record",
  "incidents:record",
];

const MANAGER: readonly Permission[] = [
  ...FRONT_DESK,
  "reservations:override_capacity",
  "stays:override_vaccinations",
  "incidents:resolve",
  "services:manage",
  "resources:manage",
  "billing:refund",
  "reports:read",
  "audit:read",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  administrator: ALL,
  general_manager: [...MANAGER, "employees:manage", "locations:manage"],
  location_manager: [...MANAGER, "employees:manage"],
  manager: MANAGER,
  shift_lead: [...FRONT_DESK, "reports:read"],
  front_desk: FRONT_DESK,
  groomer: [...CARE, "reservations:write"],
  care_attendant: CARE,
  employee: ["customers:read", "pets:read", "reservations:read"],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
