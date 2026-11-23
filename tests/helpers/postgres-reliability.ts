import "reflect-metadata";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

/** Isolated PostgreSQL schema; unlike serialized fakes, this exercises real row locks. */
export async function reliabilityDatabase(): Promise<DataSource> {
  const schema = `reliability_${randomUUID().replace(/-/g, "")}`;
  const source = new DataSource({
    type: "postgres",
    url: process.env.DATABASE_URL,
    schema,
    entities: [path.join(__dirname, "../../src/models/*.model.ts")],
    synchronize: false,
    extra: { max: 20, options: `-c search_path=${schema},public` },
  });
  await source.initialize();
  await source.query(`CREATE SCHEMA "${schema}"`);
  try {
    await source.synchronize();
    return source;
  } catch (error) {
    await source.query(`DROP SCHEMA "${schema}" CASCADE`);
    await source.destroy();
    throw error;
  }
}

export async function closeReliabilityDatabase(source: DataSource): Promise<void> {
  await source.query(
    `DROP SCHEMA "${"schema" in source.options ? source.options.schema : ""}" CASCADE`
  );
  await source.destroy();
}
