import type { SelectQueryBuilder } from "typeorm";
import { WaitlistEntry } from "../models/WaitlistEntry.model";

export function orderWaitlistQueue(
  query: SelectQueryBuilder<WaitlistEntry>,
  alias: string,
): SelectQueryBuilder<WaitlistEntry> {
  return query
    .orderBy(`${alias}.referralCount`, "DESC")
    .addOrderBy(`${alias}.createdAt`, "ASC")
    .addOrderBy(`${alias}.id`, "ASC");
}
