-- Business settings: owners and administrators can edit the organization's name, contact details
-- and time zone. Currency and slug stay fixed (changing currency would mislabel past invoices).
-- The original policy covered every command; reads stay as they were (members may see their own
-- organizations), and updates are limited to the organization of the current request.
DROP POLICY tenant ON organizations;
CREATE POLICY tenant_select ON organizations FOR SELECT
  USING (id = current_org_id()
         OR EXISTS (SELECT 1 FROM memberships m
                    WHERE m.organization_id = organizations.id AND m.user_id = current_app_user_id()));
CREATE POLICY tenant_update ON organizations FOR UPDATE
  USING (id = current_org_id()) WITH CHECK (id = current_org_id());
GRANT UPDATE (name, email, phone, timezone) ON organizations TO {{app_role}};
