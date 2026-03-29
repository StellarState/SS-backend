import "dotenv/config";
import "reflect-metadata";
import { DataSource } from "typeorm";

const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";
const migrationsPath = isProduction ? "dist/migrations/*.js" : "src/migrations/*.ts";
const entitiesPath = isProduction ? "dist/models/**/*.js" : "src/models/**/*.ts";

const baseConfig = {
  synchronize: isDevelopment,
  logging: process.env.NODE_ENV === "development",
  logger: "advanced-console" as const,
  entities: [entitiesPath],
  migrations: [migrationsPath],
  migrationsTableName: "migrations",
  migrationsRun: !isDevelopment,
};

export const dataSource = isDevelopment
  ? new DataSource({
      ...baseConfig,
      type: "sqlite",
      database: "dev.db",
    })
  : new DataSource({
      ...baseConfig,
      type: "postgres",
      url: process.env.DATABASE_URL,
      extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      },
    });

export default dataSource;
