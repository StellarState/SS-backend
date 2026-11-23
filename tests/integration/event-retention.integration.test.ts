import "reflect-metadata";
import { DataSource } from "typeorm";
import { AddEventRetention1755600000000 } from "../../src/migrations/1755600000000-AddEventRetention";
import {
  DEFAULT_RETENTION_POLICY,
  maintainEventRetention,
} from "../../src/maintenance/event-retention";

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip;
databaseDescribe("event retention and reversible index strategy (#859)", () => {
  let db: DataSource;
  beforeAll(async () => {
    db = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, extra: { max: 1 } });
    await db.initialize();
    await db.query(`DROP SCHEMA IF EXISTS retention_test CASCADE`);
    await db.query(`CREATE SCHEMA retention_test`);
    await db.query(`SET search_path TO retention_test, public`);
    await db.query(`CREATE TABLE soroban_event_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id varchar(56), event_id varchar(255),
      ledger_sequence bigint, processed boolean, created_at timestamptz)`);
    await db.query(`CREATE TABLE webhook_delivery_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id uuid, event_id varchar(200),
      delivered boolean, created_at timestamptz)`);
    await db.query(
      `CREATE TABLE soroban_indexer_checkpoints (checkpoint_key varchar(255), ledger_sequence bigint)`
    );
    const runner = db.createQueryRunner();
    await new AddEventRetention1755600000000().up(runner);
    await runner.release();
  });
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA retention_test CASCADE`);
      await db.destroy();
    }
  });

  it("bounds cleanup, protects pending/checkpoint events and audits exact rows", async () => {
    await db.query(`INSERT INTO soroban_indexer_checkpoints VALUES ('contract', 100)`);
    await db.query(`INSERT INTO soroban_event_logs (contract_id,event_id,ledger_sequence,processed,created_at)
      SELECT 'contract', n::text, n, true, now() - interval '400 days' FROM generate_series(1,8) n`);
    await db.query(`INSERT INTO soroban_event_logs (contract_id,event_id,ledger_sequence,processed,created_at)
      VALUES ('contract','pending',9,false,now() - interval '400 days'),
        ('contract','at_checkpoint',100,true,now() - interval '400 days')`);
    const result = await maintainEventRetention("soroban_event_logs", db, {
      ...DEFAULT_RETENTION_POLICY,
      batchSize: 2,
      maxBatches: 2,
    });
    expect(result.archived).toBe(4);
    expect(result.purged).toBe(4);
    expect(await db.query(`SELECT * FROM soroban_event_logs`)).toHaveLength(6);
    expect(await db.query(`SELECT * FROM event_replay_receipts`)).toHaveLength(4);
    const audit = await db.query(`SELECT * FROM event_retention_audit`);
    expect(audit).toHaveLength(4);
    expect(
      audit.every(
        (row: { correlation_id: string; row_count: number }) =>
          row.correlation_id === result.correlationId && row.row_count === 2
      )
    ).toBe(true);
  });

  it("rolls back payload movement and receipts when audit fails", async () => {
    await db.query(
      `ALTER TABLE event_retention_audit ADD CONSTRAINT reject_test CHECK (row_count < 0) NOT VALID`
    );
    await expect(maintainEventRetention("soroban_event_logs", db)).rejects.toThrow();
    expect(await db.query(`SELECT * FROM soroban_event_logs`)).toHaveLength(6);
    expect(await db.query(`SELECT * FROM event_replay_receipts`)).toHaveLength(4);
    await db.query(`ALTER TABLE event_retention_audit DROP CONSTRAINT reject_test`);
  });

  it("benchmarks selective time queries on 100000 rows without sequential scans", async () => {
    await db.query(`INSERT INTO webhook_delivery_logs (subscription_id,event_id,delivered,created_at)
      SELECT '00000000-0000-0000-0000-000000000001', n::text, true,
        now() - n * interval '1 minute' FROM generate_series(1,100000) n`);
    await db.query(`ANALYZE webhook_delivery_logs`);
    const plan = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM webhook_delivery_logs
      WHERE subscription_id = '00000000-0000-0000-0000-000000000001'
      AND created_at > now() - interval '10 minutes' ORDER BY created_at, id LIMIT 100`);
    const parsed = plan[0]["QUERY PLAN"][0];
    expect(JSON.stringify(parsed.Plan)).not.toContain('"Node Type":"Seq Scan"');
    console.info("event retention benchmark", JSON.stringify(parsed));
  });

  it("benchmarks Soroban contract/time access on 100000 rows", async () => {
    await db.query(`INSERT INTO soroban_event_logs (contract_id,event_id,ledger_sequence,processed,created_at)
      SELECT 'benchmark_contract', n::text, n, true, now() - n * interval '1 minute'
      FROM generate_series(1,100000) n`);
    await db.query(`ANALYZE soroban_event_logs`);
    const plan = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM soroban_event_logs WHERE contract_id = 'benchmark_contract'
      AND created_at > now() - interval '10 minutes' ORDER BY created_at, id LIMIT 100`);
    const parsed = plan[0]["QUERY PLAN"][0];
    expect(JSON.stringify(parsed.Plan)).not.toContain('"Node Type":"Seq Scan"');
    console.info("Soroban time range benchmark", JSON.stringify(parsed));
    await db.query(`DELETE FROM soroban_event_logs WHERE contract_id = 'benchmark_contract'`);
  });

  it("restores archived rows on rollback, preserves audit and reapplies safely", async () => {
    await db.query(
      `UPDATE soroban_event_logs SET created_at = now() - interval '40 days' WHERE processed = true AND ledger_sequence < 100`
    );
    await maintainEventRetention("soroban_event_logs", db);
    const runner = db.createQueryRunner();
    const migration = new AddEventRetention1755600000000();
    await migration.down(runner);
    expect(await runner.query(`SELECT * FROM soroban_event_logs`)).toHaveLength(6);
    expect((await runner.query(`SELECT * FROM event_retention_audit`)).length).toBeGreaterThan(4);
    await migration.up(runner);
    await runner.release();
  });
});
