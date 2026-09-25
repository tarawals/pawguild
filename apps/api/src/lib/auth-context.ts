import type { Permission, Role } from "@pawguild/shared";

/** Derived server-side from the session cookie. Never taken from client input. */
export interface AuthContext {
  sessionId: string;
  userId: string;
  orgId: string;
  membershipId: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
}
