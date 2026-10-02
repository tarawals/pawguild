-- Packages at checkout: an invoice drafted from a reservation uses the customer's packages by
-- default, and staff can turn that off (or back on) while it's a draft. invoice_lines.stay_line
-- marks the lines priced from the stay, which are rebuilt when the choice changes; lines added
-- by hand are left alone. Invoices drafted before this migration have no stay lines marked, so
-- the choice can't be changed on them (recreate the invoice instead).
ALTER TABLE invoices ADD COLUMN use_packages boolean NOT NULL DEFAULT true;
ALTER TABLE invoice_lines ADD COLUMN stay_line boolean NOT NULL DEFAULT false;
GRANT UPDATE (use_packages) ON invoices TO {{app_role}};
