import "reflect-metadata";
import express from "express";
import request from "supertest";
import { Column, DataSource, Entity, PrimaryColumn } from "typeorm";
import { EnumValidationSubscriber } from "../../src/subscribers/enum-validation.subscriber";
import { EnumQuarantine } from "../../src/models/EnumQuarantine.model";
import { AddEnumQuarantine1755700000000 } from "../../src/migrations/1755700000000-AddEnumQuarantine";
import { runWithRequestContext } from "../../src/observability/request-context";
import { MetricsRegistry } from "../../src/observability/metrics";
import { setReliabilityMetricsRegistry } from "../../src/observability/reliability-metrics";

@Entity("curve_migrations")
class LegacyProjection {
  @PrimaryColumn({ type: "varchar" }) id!: string;
  @Column({ type: "varchar" }) status!: string | null;
}
@Entity("compatibility_rows")
class NativeProjection {
  @PrimaryColumn({ type: "varchar" }) id!: string;
  @Column({ type: "enum", enum: ["known"] }) status!: string | null;
  @Column({ type: "varchar", enum: ["known"], nullable: true }) optional!: string | null;
}

const databaseDescribe = process.env.DATABASE_URL ? describe : describe.skip;
databaseDescribe("enum validation and migration compatibility (#860)", () => {
  let db: DataSource;
  const metrics = new MetricsRegistry();
  beforeAll(async () => {
    db = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_URL,
      schema: "enum_test",
      entities: [LegacyProjection, NativeProjection, EnumQuarantine],
      subscribers: [EnumValidationSubscriber],
      extra: { max: 1 },
    });
    await db.initialize();
    await db.query(`DROP SCHEMA IF EXISTS enum_test CASCADE`);
    await db.query(`CREATE SCHEMA enum_test`);
    await db.query(`SET search_path TO enum_test, public`);
    await db.query(
      `CREATE TABLE curve_migrations (id varchar PRIMARY KEY, status varchar NOT NULL)`
    );
    // Legacy rows must not block deploying new write guards.
    await db.query(`INSERT INTO curve_migrations VALUES ('legacy','future_version')`);
    await db.query(`CREATE TYPE compatibility_rows_status_enum AS ENUM ('known','future')`);
    await db.query(
      `CREATE TABLE compatibility_rows (id varchar PRIMARY KEY, status compatibility_rows_status_enum NOT NULL, optional varchar)`
    );
    await db.query(`INSERT INTO compatibility_rows VALUES ('native','future',NULL)`);
    const runner = db.createQueryRunner();
    await new AddEnumQuarantine1755700000000().up(runner);
    await runner.release();
    setReliabilityMetricsRegistry(metrics);
  });
  afterAll(async () => {
    setReliabilityMetricsRegistry(undefined);
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA enum_test CASCADE`);
      await db.destroy();
    }
  });

  it("rejects repository insert, save, update and query builder writes", async () => {
    const repo = db.getRepository(LegacyProjection);
    await expect(repo.insert({ id: "bad", status: "unexpected" })).rejects.toMatchObject({
      code: "INVALID_ENUM_VALUE",
    });
    await expect(repo.save({ id: "bad", status: "unexpected" })).rejects.toMatchObject({
      code: "INVALID_ENUM_VALUE",
    });
    await repo.insert({ id: "valid", status: "pending" });
    await expect(repo.update("valid", { status: "unexpected" })).rejects.toMatchObject({
      code: "INVALID_ENUM_VALUE",
    });
    await expect(
      repo
        .createQueryBuilder()
        .update()
        .set({ status: "unexpected" })
        .where("id = :id", { id: "valid" })
        .execute()
    ).rejects.toMatchObject({ code: "INVALID_ENUM_VALUE" });
    await expect(
      db.query(`INSERT INTO curve_migrations VALUES ('raw','unexpected')`)
    ).rejects.toThrow();
    await expect(
      db.query(`UPDATE curve_migrations SET status = 'unexpected' WHERE id = 'valid'`)
    ).rejects.toThrow();
  });

  it("serves unknown legacy and future native enums safely and records operator evidence", async () => {
    const app = express();
    app.get("/rows", async (_req, res) => {
      const rows = await runWithRequestContext({ correlationId: "enum-list-test" }, () =>
        db.getRepository(LegacyProjection).find()
      );
      res.json(rows);
    });
    const response = await request(app).get("/rows");
    expect(response.status).toBe(200);
    expect(response.body.find((row: { id: string }) => row.id === "legacy").status).toBeNull();
    expect((await db.getRepository(NativeProjection).find())[0].status).toBeNull();
    const quarantine = await db.getRepository(EnumQuarantine).find();
    expect(quarantine).toHaveLength(2);
    expect(quarantine.find((row) => row.sourceTable === "curve_migrations")).toMatchObject({
      rawValue: "future_version",
      correlationId: "enum-list-test",
      recordId: '{"id":"legacy"}',
    });
    await db.getRepository(LegacyProjection).find();
    expect(await db.getRepository(EnumQuarantine).count()).toBe(2);
    expect(metrics.renderPrometheusMetrics()).toContain("stellarsettle_enum_rejected_writes_total");
    expect(metrics.renderPrometheusMetrics()).toContain(
      "stellarsettle_enum_quarantined_values_total"
    );
  });

  it("accepts nullable fields and preserves quarantine during rollback and reapply", async () => {
    await db
      .getRepository(NativeProjection)
      .insert({ id: "valid", status: "known", optional: null });
    const runner = db.createQueryRunner();
    const migration = new AddEnumQuarantine1755700000000();
    await migration.down(runner);
    await migration.up(runner);
    await runner.release();
    expect(await db.getRepository(EnumQuarantine).count()).toBe(2);
    await expect(
      db.query(`INSERT INTO curve_migrations VALUES ('raw2','unexpected')`)
    ).rejects.toThrow();
  });
});
