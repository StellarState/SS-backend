import "reflect-metadata";
import { getMetadataArgsStorage } from "typeorm";
import { FeeSchedule } from "../../src/models/FeeSchedule.model";
import { patchMetadataForSQLite } from "./sqlite-metadata";

function effectiveFromType(): unknown {
  return getMetadataArgsStorage().columns.find(
    (column) => column.target === FeeSchedule && column.propertyName === "effectiveFrom"
  )?.options.type;
}

describe("SQLite metadata compatibility", () => {
  it("restores global TypeORM column metadata after patching", () => {
    const original = effectiveFromType();
    expect(original).toBe("timestamptz");

    const restore = patchMetadataForSQLite();
    try {
      expect(effectiveFromType()).toBe("datetime");
    } finally {
      restore();
    }

    expect(effectiveFromType()).toBe(original);
  });
});
