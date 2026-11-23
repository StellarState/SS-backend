import { createHash, randomUUID } from "crypto";
import {
  EventSubscriber,
  type EntitySubscriberInterface,
  type InsertEvent,
  type UpdateEvent,
  type LoadEvent,
} from "typeorm";
import type { EntityMetadata } from "typeorm";
import { EnumQuarantine } from "../models/EnumQuarantine.model";
import { VARCHAR_ENUMS, isEnumValue, requireEnumValue } from "../utils/enum-validation";
import { getCorrelationId } from "../observability/request-context";
import { recordReliabilityMetric } from "../observability/reliability-metrics";
import { logger } from "../observability/logger";

function enumColumns(metadata: EntityMetadata) {
  return metadata.columns.flatMap((column) => {
    const allowed = column.enum ?? VARCHAR_ENUMS[metadata.tableName]?.[column.propertyName];
    return allowed ? [{ column, allowed }] : [];
  });
}

@EventSubscriber()
export class EnumValidationSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<unknown>): void {
    this.validate(event.entity, event.metadata);
  }
  beforeUpdate(event: UpdateEvent<unknown>): void {
    this.validate(event.entity, event.metadata);
  }

  private validate(entity: unknown, metadata: EntityMetadata): void {
    if (!entity || typeof entity !== "object") return;
    for (const { column, allowed } of enumColumns(metadata)) {
      const value = column.getEntityValue(entity);
      // Partial updates omit fields. Database NOT NULL enforces required inserts.
      if (value === undefined || (value === null && column.isNullable)) continue;
      requireEnumValue(value, allowed.map(String), `${metadata.tableName}.${column.propertyName}`);
    }
  }

  async afterLoad(entity: unknown, event?: LoadEvent<unknown>): Promise<void> {
    if (!event || !entity || typeof entity !== "object") return;
    for (const { column, allowed } of enumColumns(event.metadata)) {
      const value = column.getEntityValue(entity);
      if (
        value === undefined ||
        (value === null && column.isNullable) ||
        isEnumValue(value, allowed)
      )
        continue;
      const recordId = JSON.stringify(event.metadata.getEntityIdMap(entity) ?? {}).slice(0, 512);
      const correlationId = getCorrelationId() ?? randomUUID();
      const rawValue = typeof value === "string" ? value.slice(0, 256) : `<${typeof value}>`;
      const id = createHash("sha256")
        .update(`${event.metadata.tableName}:${column.databaseName}:${recordId}`)
        .digest("hex");
      await event.manager.getRepository(EnumQuarantine).upsert(
        {
          id,
          sourceTable: event.metadata.tableName,
          sourceColumn: column.databaseName,
          recordId,
          rawValue,
          correlationId,
          observedAt: new Date(),
        },
        ["id"]
      );
      column.setEntityValue(entity, null);
      recordReliabilityMetric("enum_quarantined_values");
      logger.warn("enum.projection.quarantined", {
        sourceTable: event.metadata.tableName,
        sourceColumn: column.databaseName,
        recordId,
        correlationId,
      });
    }
  }
}
