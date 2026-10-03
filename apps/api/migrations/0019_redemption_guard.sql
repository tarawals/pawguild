-- Defense in depth for prepaid days: a redemption must take the day from the invoice customer's
-- own package or membership month, for a date the package or month covers. The app already does
-- this; the trigger makes sure a bug can never spend another customer's days or an expired package.
CREATE FUNCTION package_redemptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice_customer uuid; v_owner uuid; v_from date; v_to date;
BEGIN
  SELECT customer_id INTO v_invoice_customer FROM invoices WHERE id = NEW.invoice_id;
  IF NEW.customer_package_id IS NOT NULL THEN
    SELECT customer_id, NULL, expires_on INTO v_owner, v_from, v_to FROM customer_packages WHERE id = NEW.customer_package_id;
  ELSE
    SELECT cm.customer_id, mp.period_start, mp.period_end INTO v_owner, v_from, v_to
      FROM membership_periods mp JOIN customer_memberships cm ON cm.id = mp.customer_membership_id WHERE mp.id = NEW.membership_period_id;
  END IF;
  IF v_owner IS DISTINCT FROM v_invoice_customer THEN
    RAISE EXCEPTION 'prepaid days can only be used for the customer they belong to' USING ERRCODE = 'P0001';
  END IF;
  IF (v_from IS NOT NULL AND NEW.used_on < v_from) OR (v_to IS NOT NULL AND NEW.used_on > v_to) THEN
    RAISE EXCEPTION 'prepaid days can only be used for dates they cover' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE id = NEW.invoice_line_id AND invoice_id = NEW.invoice_id) THEN
    RAISE EXCEPTION 'a redemption must belong to a line of its invoice' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_redemptions_guard BEFORE INSERT ON package_redemptions FOR EACH ROW EXECUTE FUNCTION package_redemptions_guard();
