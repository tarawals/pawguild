-- Location administration: weekly hours and closure dates become editable.
-- Hours and closures are configuration, not business records: staff replace a week's hours and
-- remove closures that were added by mistake. Every change is written to the audit log.
-- Non-destructive.
GRANT DELETE ON location_hours, location_closures TO {{app_role}};
