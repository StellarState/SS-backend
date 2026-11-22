import { MigrationInterface, QueryRunner } from "typeorm";

/** Database triggers cover every listing writer, including bulk expiry and SQL updates. */
export class AddSecondaryDepthSnapshots1795400000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE secondary_depth_snapshots (
      id bigserial PRIMARY KEY,
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      levels jsonb NOT NULL,
      captured_at timestamptz NOT NULL,
      valid_until timestamptz
    )`);
    await runner.query(
      `CREATE INDEX idx_secondary_depth_invoice_id ON secondary_depth_snapshots(invoice_id, id DESC)`
    );
    await runner.query(
      `CREATE INDEX idx_secondary_depth_retention ON secondary_depth_snapshots(captured_at)`
    );
    await runner.query(`CREATE FUNCTION refresh_secondary_depth(target uuid) RETURNS void
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
      DECLARE captured timestamptz; depth jsonb; deadline timestamptz;
      BEGIN
        -- Serialize aggregation for an invoice across all application instances.
        PERFORM pg_advisory_xact_lock(hashtextextended('secondary_depth:' || target::text, 0));
        IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = target) THEN RETURN; END IF;
        captured := clock_timestamp();
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'price', price::text, 'quantity', quantity::text, 'listing_count', listing_count)
          ORDER BY price), '[]'::jsonb), min(expires_at)
        INTO depth, deadline FROM (
          SELECT l.price_per_fraction AS price, sum(l.quantity) AS quantity,
            count(*) AS listing_count, min(LEAST(l.expires_at, i.due_date::timestamptz)) AS expires_at
          FROM secondary_listings l JOIN invoices i ON i.id = l.invoice_id
          WHERE l.invoice_id = target AND l.status = 'active' AND l.deleted_at IS NULL
            AND l.expires_at > captured AND i.status = 'funded' AND i.deleted_at IS NULL
            AND i.due_date > captured::date
          GROUP BY l.price_per_fraction
        ) aggregated;
        INSERT INTO secondary_depth_snapshots(invoice_id, levels, captured_at, valid_until)
          VALUES(target, depth, captured, deadline);
        DELETE FROM secondary_depth_snapshots
          WHERE invoice_id = target AND captured_at < captured - interval '90 days';
      END $$`);
    await runner.query(`CREATE FUNCTION snapshot_secondary_listing_change() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM refresh_secondary_depth(OLD.invoice_id);
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.invoice_id <> NEW.invoice_id THEN
          PERFORM refresh_secondary_depth(OLD.invoice_id);
        END IF;
        PERFORM refresh_secondary_depth(NEW.invoice_id);
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER secondary_listing_depth_change
      AFTER INSERT OR UPDATE OR DELETE ON secondary_listings
      FOR EACH ROW EXECUTE FUNCTION snapshot_secondary_listing_change()`);
    await runner.query(`CREATE FUNCTION snapshot_secondary_invoice_change() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
      BEGIN
        IF OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
          OR OLD.due_date IS DISTINCT FROM NEW.due_date THEN
          PERFORM refresh_secondary_depth(NEW.id);
        END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE TRIGGER secondary_invoice_depth_change
      AFTER UPDATE OF status, deleted_at, due_date ON invoices
      FOR EACH ROW EXECUTE FUNCTION snapshot_secondary_invoice_change()`);
    await runner.query(
      `SELECT refresh_secondary_depth(invoice_id) FROM (SELECT DISTINCT invoice_id FROM secondary_listings) existing`
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TRIGGER secondary_invoice_depth_change ON invoices`);
    await runner.query(`DROP TRIGGER secondary_listing_depth_change ON secondary_listings`);
    await runner.query(`DROP FUNCTION snapshot_secondary_invoice_change()`);
    await runner.query(`DROP FUNCTION snapshot_secondary_listing_change()`);
    await runner.query(`DROP FUNCTION refresh_secondary_depth(uuid)`);
    await runner.query(`DROP TABLE secondary_depth_snapshots`);
  }
}
