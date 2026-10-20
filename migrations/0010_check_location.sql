-- Where a monitor's checks run from: a Durable Object location hint such as 'weur'.
-- NULL follows the CHECK_LOCATION var.
ALTER TABLE monitors ADD COLUMN check_location TEXT;
