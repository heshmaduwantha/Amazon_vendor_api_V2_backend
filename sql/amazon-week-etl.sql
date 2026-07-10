\set ON_ERROR_STOP on

\if :{?source_password}
\else
  \echo 'Pass the source password with -v source_password=...'
  \quit
\endif

-- The audit log intentionally lives in final_amazon_db, as required.
\connect final_amazon_db

CREATE TABLE IF NOT EXISTS public.amazon_etl_sync_log (
  run_id uuid PRIMARY KEY,
  target_database text NOT NULL,
  source_database text NOT NULL,
  amazon_year integer NOT NULL,
  amazon_week integer NOT NULL,
  week_start date NOT NULL,
  week_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
  source_inventory_rows bigint,
  source_sales_rows bigint,
  target_inventory_deleted bigint,
  target_sales_deleted bigint,
  target_inventory_inserted bigint,
  target_sales_inserted bigint,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS amazon_etl_sync_log_week_idx
  ON public.amazon_etl_sync_log (amazon_year, amazon_week, started_at DESC);

\connect amazon_db

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE SCHEMA IF NOT EXISTS etl;

DROP SERVER IF EXISTS final_amazon_db_source CASCADE;

CREATE SERVER final_amazon_db_source
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'localhost', port '5433', dbname 'final_amazon_db');

CREATE USER MAPPING FOR CURRENT_USER
  SERVER final_amazon_db_source
  OPTIONS (user 'postgres', password :'source_password');

DROP SCHEMA IF EXISTS etl_source CASCADE;
CREATE SCHEMA etl_source;

IMPORT FOREIGN SCHEMA public
  LIMIT TO (
    amazon_inventory_by_asin,
    amazon_sales_by_asin,
    amazon_etl_sync_log
  )
  FROM SERVER final_amazon_db_source
  INTO etl_source;

-- Deleted target rows are retained here, so every replacement can be audited
-- or reversed without relying on the source database.
CREATE TABLE IF NOT EXISTS etl.amazon_inventory_by_asin_history (
  run_id uuid NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  LIKE public.amazon_inventory_by_asin INCLUDING DEFAULTS INCLUDING GENERATED
);

CREATE INDEX IF NOT EXISTS amazon_inventory_history_run_idx
  ON etl.amazon_inventory_by_asin_history (run_id);

CREATE INDEX IF NOT EXISTS amazon_inventory_history_key_idx
  ON etl.amazon_inventory_by_asin_history (start_date, end_date, asin);

CREATE TABLE IF NOT EXISTS etl.amazon_sales_by_asin_history (
  run_id uuid NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  LIKE public.amazon_sales_by_asin INCLUDING DEFAULTS INCLUDING GENERATED
);

CREATE INDEX IF NOT EXISTS amazon_sales_history_run_idx
  ON etl.amazon_sales_by_asin_history (run_id);

CREATE INDEX IF NOT EXISTS amazon_sales_history_key_idx
  ON etl.amazon_sales_by_asin_history (start_date, end_date, asin);

CREATE OR REPLACE PROCEDURE etl.sync_amazon_week(
  p_amazon_year integer,
  p_amazon_week integer
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_run_id uuid := gen_random_uuid();
  v_year_start date;
  v_week_start date;
  v_week_end date;
  v_inventory_days integer := 0;
  v_sales_days integer := 0;
  v_source_inventory_rows bigint := 0;
  v_source_sales_rows bigint := 0;
  v_inventory_deleted bigint := 0;
  v_sales_deleted bigint := 0;
  v_inventory_inserted bigint := 0;
  v_sales_inserted bigint := 0;
  v_error text;
BEGIN
  IF p_amazon_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'Amazon year % is outside the supported range', p_amazon_year;
  END IF;

  IF p_amazon_week NOT BETWEEN 1 AND 53 THEN
    RAISE EXCEPTION 'Amazon week % must be between 1 and 53', p_amazon_week;
  END IF;

  -- Amazon Week 01 starts on the Sunday on or before January 1.
  v_year_start := make_date(p_amazon_year, 1, 1)
    - extract(dow FROM make_date(p_amazon_year, 1, 1))::integer;
  v_week_start := v_year_start + ((p_amazon_week - 1) * 7);
  v_week_end := v_week_start + 6;

  PERFORM pg_advisory_xact_lock(hashtext('amazon-week-etl'));

  INSERT INTO etl_source.amazon_etl_sync_log (
    run_id,
    target_database,
    source_database,
    amazon_year,
    amazon_week,
    week_start,
    week_end,
    status,
    started_at
  ) VALUES (
    v_run_id,
    current_database(),
    'final_amazon_db',
    p_amazon_year,
    p_amazon_week,
    v_week_start,
    v_week_end,
    'RUNNING',
    clock_timestamp()
  );

  BEGIN
    SELECT count(*), count(DISTINCT start_date)
      INTO v_source_inventory_rows, v_inventory_days
    FROM etl_source.amazon_inventory_by_asin
    WHERE start_date BETWEEN v_week_start AND v_week_end
      AND start_date = end_date;

    SELECT count(*), count(DISTINCT start_date::date)
      INTO v_source_sales_rows, v_sales_days
    FROM etl_source.amazon_sales_by_asin
    WHERE start_date::date BETWEEN v_week_start AND v_week_end
      AND start_date::date = end_date::date;

    IF v_inventory_days <> 7 THEN
      RAISE EXCEPTION
        'Source inventory is incomplete for Amazon % Week %: expected 7 dates, found %',
        p_amazon_year, p_amazon_week, v_inventory_days;
    END IF;

    IF v_sales_days <> 7 THEN
      RAISE EXCEPTION
        'Source sales is incomplete for Amazon % Week %: expected 7 dates, found %',
        p_amazon_year, p_amazon_week, v_sales_days;
    END IF;

    INSERT INTO etl.amazon_inventory_by_asin_history
    SELECT v_run_id, clock_timestamp(), target.*
    FROM public.amazon_inventory_by_asin target
    WHERE target.start_date <= v_week_end
      AND target.end_date >= v_week_start;
    GET DIAGNOSTICS v_inventory_deleted = ROW_COUNT;

    INSERT INTO etl.amazon_sales_by_asin_history
    SELECT v_run_id, clock_timestamp(), target.*
    FROM public.amazon_sales_by_asin target
    WHERE target.start_date::date <= v_week_end
      AND target.end_date::date >= v_week_start;
    GET DIAGNOSTICS v_sales_deleted = ROW_COUNT;

    DELETE FROM public.amazon_inventory_by_asin target
    WHERE target.start_date <= v_week_end
      AND target.end_date >= v_week_start;

    DELETE FROM public.amazon_sales_by_asin target
    WHERE target.start_date::date <= v_week_end
      AND target.end_date::date >= v_week_start;

    INSERT INTO public.amazon_inventory_by_asin (
      start_date,
      end_date,
      asin,
      sourceable_product_out_of_stock_rate,
      procurable_product_out_of_stock_rate,
      open_purchase_order_units,
      receive_fill_rate,
      average_vendor_lead_time_days,
      sell_through_rate,
      unfilled_customer_ordered_units,
      vendor_confirmation_rate,
      net_received_inventory_cost_amount,
      net_received_inventory_cost_currency_code,
      net_received_inventory_units,
      sellable_on_hand_inventory_cost_amount,
      sellable_on_hand_inventory_cost_currency_code,
      sellable_on_hand_inventory_units,
      unsellable_on_hand_inventory_cost_amount,
      unsellable_on_hand_inventory_cost_currency_code,
      unsellable_on_hand_inventory_units,
      aged_90_plus_days_sellable_inventory_cost_amount,
      aged_90_plus_days_sellable_inventory_cost_currency_code,
      aged_90_plus_days_sellable_inventory_units
    )
    SELECT
      start_date,
      end_date,
      asin,
      sourceable_product_out_of_stock_rate,
      procurable_product_out_of_stock_rate,
      open_purchase_order_units,
      receive_fill_rate,
      average_vendor_lead_time_days,
      sell_through_rate,
      unfilled_customer_ordered_units,
      vendor_confirmation_rate,
      net_received_inventory_cost_amount,
      net_received_inventory_cost_currency_code,
      net_received_inventory_units,
      sellable_on_hand_inventory_cost_amount,
      sellable_on_hand_inventory_cost_currency_code,
      sellable_on_hand_inventory_units,
      unsellable_on_hand_inventory_cost_amount,
      unsellable_on_hand_inventory_cost_currency_code,
      unsellable_on_hand_inventory_units,
      aged_90_plus_days_sellable_inventory_cost_amount,
      aged_90_plus_days_sellable_inventory_cost_currency_code,
      aged_90_plus_days_sellable_inventory_units
    FROM etl_source.amazon_inventory_by_asin
    WHERE start_date BETWEEN v_week_start AND v_week_end
      AND start_date = end_date;
    GET DIAGNOSTICS v_inventory_inserted = ROW_COUNT;

    INSERT INTO public.amazon_sales_by_asin (
      start_date,
      end_date,
      asin,
      customer_returns,
      shipped_cogs_amount,
      shipped_cogs_currency,
      shipped_revenue_amount,
      shipped_revenue_currency,
      shipped_units,
      ordered_revenue_amount,
      ordered_revenue_currency,
      ordered_units
    )
    SELECT
      start_date,
      end_date,
      asin,
      customer_returns,
      shipped_cogs_amount,
      shipped_cogs_currency,
      shipped_revenue_amount,
      shipped_revenue_currency,
      shipped_units,
      ordered_revenue_amount,
      ordered_revenue_currency,
      ordered_units
    FROM etl_source.amazon_sales_by_asin
    WHERE start_date::date BETWEEN v_week_start AND v_week_end
      AND start_date::date = end_date::date;
    GET DIAGNOSTICS v_sales_inserted = ROW_COUNT;

    IF v_inventory_inserted <> v_source_inventory_rows
      OR v_sales_inserted <> v_source_sales_rows THEN
      RAISE EXCEPTION
        'Inserted row counts do not match source counts (inventory %/%, sales %/%)',
        v_inventory_inserted,
        v_source_inventory_rows,
        v_sales_inserted,
        v_source_sales_rows;
    END IF;

    UPDATE etl_source.amazon_etl_sync_log
    SET status = 'SUCCESS',
        source_inventory_rows = v_source_inventory_rows,
        source_sales_rows = v_source_sales_rows,
        target_inventory_deleted = v_inventory_deleted,
        target_sales_deleted = v_sales_deleted,
        target_inventory_inserted = v_inventory_inserted,
        target_sales_inserted = v_sales_inserted,
        finished_at = clock_timestamp(),
        error_message = NULL
    WHERE run_id = v_run_id;
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;

      UPDATE etl_source.amazon_etl_sync_log
      SET status = 'FAILED',
          source_inventory_rows = v_source_inventory_rows,
          source_sales_rows = v_source_sales_rows,
          target_inventory_deleted = 0,
          target_sales_deleted = 0,
          target_inventory_inserted = 0,
          target_sales_inserted = 0,
          finished_at = clock_timestamp(),
          error_message = v_error
      WHERE run_id = v_run_id;

      RAISE WARNING 'Amazon % Week % was not changed: %',
        p_amazon_year, p_amazon_week, v_error;
  END;
END;
$procedure$;

CREATE OR REPLACE PROCEDURE etl.sync_amazon_week_range(
  p_amazon_year integer,
  p_first_week integer,
  p_last_week integer
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_week integer;
BEGIN
  IF p_first_week NOT BETWEEN 1 AND 53
    OR p_last_week NOT BETWEEN 1 AND 53
    OR p_first_week > p_last_week THEN
    RAISE EXCEPTION 'Invalid Amazon week range % to %', p_first_week, p_last_week;
  END IF;

  FOR v_week IN p_first_week..p_last_week LOOP
    CALL etl.sync_amazon_week(p_amazon_year, v_week);
  END LOOP;
END;
$procedure$;

CREATE OR REPLACE PROCEDURE etl.sync_last_completed_amazon_week(
  p_reference_date date DEFAULT current_date
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_current_week_start date;
  v_week_start date;
  v_amazon_year integer;
  v_year_start date;
  v_amazon_week integer;
BEGIN
  v_current_week_start := p_reference_date - extract(dow FROM p_reference_date)::integer;
  v_week_start := v_current_week_start - 7;
  v_amazon_year := extract(year FROM (v_week_start + 6))::integer;
  v_year_start := make_date(v_amazon_year, 1, 1)
    - extract(dow FROM make_date(v_amazon_year, 1, 1))::integer;
  v_amazon_week := ((v_week_start - v_year_start) / 7) + 1;

  CALL etl.sync_amazon_week(v_amazon_year, v_amazon_week);
END;
$procedure$;

-- Initial controlled load:
-- CALL etl.sync_amazon_week_range(2026, 1, 23);
--
-- Future weekly load:
-- CALL etl.sync_last_completed_amazon_week();
--
-- Audit status (stored in final_amazon_db):
-- SELECT * FROM public.amazon_etl_sync_log ORDER BY started_at DESC;
