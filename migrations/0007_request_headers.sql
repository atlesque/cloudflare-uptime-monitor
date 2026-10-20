-- Extra request headers sent with each check of a monitor (for example a secret header a site's
-- WAF lets through), as a JSON array of [name, value] pairs. NULL means none.
ALTER TABLE monitors ADD COLUMN request_headers TEXT;
