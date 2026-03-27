import "dotenv/config";
import "reflect-metadata";
import { DataSource } from "typeorm";

const isProduction = process.env.NODE_ENV === "production";
const migrationsPath = isProduction ? "dist/migrations/*.js" : "src/migrations/*.ts";
const entitiesPath = isProduction ? "dist/models/**/*.js" : "src/models/**/*.ts";

export const dataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  synchronize: false,
  logging: process.env.NODE_ENV === "development",
  logger: "advanced-console",
  entities: [entitiesPath],
  migrations: [migrationsPath],
  migrationsTableName: "migrations",
  migrationsRun: false,
  extra: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
});

export default dataSource;
