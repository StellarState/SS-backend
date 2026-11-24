import { createHash } from "node:crypto";
import type { DataSource } from "typeorm";
import { AuditLog } from "@/models/AuditLog.model";

export const GENESIS_PREV_HASH = "0".repeat(64);

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passphrase|authorization|api[_-]?key|private[_-]?key|seed|cookie|jwt|admin[_-]?key|signature)/i;

export interface AuditLogRecord {
  id: string;
  actor: string;
  action: string;
  resource: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
  createdAt: string;
}

export interface RecordAuditEntryInput {
  actor: string;
  action: string;
  resource: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt?: Date | string;
}

export interface AuditLogFilterQuery {
  actor?: string;
  action?: string;
  resource?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditLogPage {
  items: AuditLogRecord[];
  limit: number;
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface BrokenAuditLink {
  id: string;
  index: number;
  reason: "prev_hash_mismatch" | "hash_mismatch";
  expectedPrevHash: string;
  actualPrevHash: string;
  expectedHash: string;
  actualHash: string;
}

export interface AuditChainVerification {
  valid: boolean;
  checkedCount: number;
  brokenEntry: BrokenAuditLink | null;
}

export interface AuditLogStore {
  getLatest(): Promise<AuditLogRecord | null>;
  append(entry: Omit<AuditLogRecord, "id">): Promise<AuditLogRecord>;
  list(query: AuditLogFilterQuery): Promise<{ rows: AuditLogRecord[]; limit: number }>;
  listAllOrdered(): Promise<AuditLogRecord[]>;
}

export function sanitizeAuditPayload(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditPayload(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitizeAuditPayload(val);
      }
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  return (
    "{" +
    sortedKeys.map((key) => JSON.stringify(key) + ":" + canonicalJson(obj[key])).join(",") +
    "}"
  );
}

export function computeAuditHash(entry: Omit<AuditLogRecord, "id" | "hash">): string {
  const preimage = [
    entry.prevHash,
    entry.actor,
    entry.action,
    entry.resource,
    canonicalJson(entry.before),
    canonicalJson(entry.after),
    entry.createdAt,
  ].join("|");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function toRecord(entity: AuditLog): AuditLogRecord {
  const iso =
    entity.createdAt instanceof Date
      ? entity.createdAt.toISOString()
      : new Date(String(entity.createdAt)).toISOString();
  return {
    id: String(entity.id),
    actor: entity.actor,
    action: entity.action,
    resource: entity.resource,
    before: entity.before ?? null,
    after: entity.after ?? null,
    prevHash: entity.prevHash,
    hash: entity.hash,
    createdAt: iso,
  };
}

export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly rows: AuditLogRecord[] = [];
  private nextId = 1;

  public async getLatest(): Promise<AuditLogRecord | null> {
    if (this.rows.length === 0) return null;
    return structuredClone(this.rows[this.rows.length - 1]);
  }

  public async append(entry: Omit<AuditLogRecord, "id">): Promise<AuditLogRecord> {
    const stored: AuditLogRecord = {
      id: String(this.nextId++),
      ...structuredClone(entry),
    };
    this.rows.push(stored);
    return structuredClone(stored);
  }

  public async list(
    query: AuditLogFilterQuery
  ): Promise<{ rows: AuditLogRecord[]; limit: number }> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const cursorNum = query.cursor !== undefined ? BigInt(query.cursor) : 0n;
    const matched = this.rows.filter((row) => {
      if (BigInt(row.id) <= cursorNum) return false;
      if (query.actor && row.actor !== query.actor) return false;
      if (query.action && row.action !== query.action) return false;
      if (query.resource && row.resource !== query.resource) return false;
      return true;
    });
    return {
      rows: matched.slice(0, limit + 1).map((row) => structuredClone(row)),
      limit,
    };
  }

  public async listAllOrdered(): Promise<AuditLogRecord[]> {
    return this.rows.map((row) => structuredClone(row));
  }

  /** Test helper used solely to simulate out-of-band storage tampering. */
  public unsafeMutateRow(id: string, patch: Partial<AuditLogRecord>): boolean {
    const target = this.rows.find((row) => row.id === id);
    if (!target) return false;
    Object.assign(target, patch);
    return true;
  }
}

export class TypeOrmAuditLogStore implements AuditLogStore {
  constructor(private readonly dataSource: DataSource) {}

  public async getLatest(): Promise<AuditLogRecord | null> {
    const repo = this.dataSource.getRepository(AuditLog);
    const latest = await repo.createQueryBuilder("a").orderBy("a.id", "DESC").getOne();
    return latest ? toRecord(latest) : null;
  }

  public async append(entry: Omit<AuditLogRecord, "id">): Promise<AuditLogRecord> {
    const repo = this.dataSource.getRepository(AuditLog);
    const created = repo.create({
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      before: entry.before,
      after: entry.after,
      prevHash: entry.prevHash,
      hash: entry.hash,
      createdAt: new Date(entry.createdAt),
    });
    const saved = await repo.save(created);
    return toRecord(saved);
  }

  public async list(
    query: AuditLogFilterQuery
  ): Promise<{ rows: AuditLogRecord[]; limit: number }> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const qb = this.dataSource
      .getRepository(AuditLog)
      .createQueryBuilder("a")
      .orderBy("a.id", "ASC")
      .take(limit + 1);

    if (query.cursor !== undefined) {
      qb.andWhere("a.id > :cursor", { cursor: query.cursor });
    }
    if (query.actor) {
      qb.andWhere("a.actor = :actor", { actor: query.actor });
    }
    if (query.action) {
      qb.andWhere("a.action = :action", { action: query.action });
    }
    if (query.resource) {
      qb.andWhere("a.resource = :resource", { resource: query.resource });
    }

    const entities = await qb.getMany();
    return { rows: entities.map(toRecord), limit };
  }

  public async listAllOrdered(): Promise<AuditLogRecord[]> {
    const entities = await this.dataSource
      .getRepository(AuditLog)
      .createQueryBuilder("a")
      .orderBy("a.id", "ASC")
      .getMany();
    return entities.map(toRecord);
  }
}

export class AuditService {
  private readonly store: AuditLogStore;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(storeOrDataSource?: AuditLogStore | DataSource) {
    if (!storeOrDataSource) {
      this.store = new InMemoryAuditLogStore();
    } else if ("getRepository" in storeOrDataSource) {
      this.store = new TypeOrmAuditLogStore(storeOrDataSource);
    } else {
      this.store = storeOrDataSource;
    }
  }

  public record(input: RecordAuditEntryInput): Promise<AuditLogRecord> {
    const op = this.writeChain.then(async () => {
      const actor = input.actor?.trim();
      const action = input.action?.trim();
      const resource = input.resource?.trim();
      if (!actor) throw new Error("AuditLog actor is required");
      if (!action) throw new Error("AuditLog action is required");
      if (!resource) throw new Error("AuditLog resource is required");

      const latest = await this.store.getLatest();
      const prevHash = latest ? latest.hash : GENESIS_PREV_HASH;
      const sanitizedBefore = sanitizeAuditPayload(input.before ?? null) as Record<
        string,
        unknown
      > | null;
      const sanitizedAfter = sanitizeAuditPayload(input.after ?? null) as Record<
        string,
        unknown
      > | null;
      const createdAtIso =
        input.createdAt instanceof Date
          ? input.createdAt.toISOString()
          : input.createdAt
            ? new Date(input.createdAt).toISOString()
            : new Date().toISOString();

      const base: Omit<AuditLogRecord, "id" | "hash"> = {
        actor,
        action,
        resource,
        before: sanitizedBefore,
        after: sanitizedAfter,
        prevHash,
        createdAt: createdAtIso,
      };
      const hash = computeAuditHash(base);
      return this.store.append({ ...base, hash });
    });

    this.writeChain = op.catch(() => undefined);
    return op;
  }

  public async list(query: AuditLogFilterQuery = {}): Promise<AuditLogPage> {
    const { rows, limit } = await this.store.list(query);
    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage && items.length > 0 ? items[items.length - 1].id : null;
    return {
      items,
      limit,
      nextCursor,
      hasNextPage,
    };
  }

  public async verifyChain(): Promise<AuditChainVerification> {
    const rows = await this.store.listAllOrdered();
    let expectedPrevHash = GENESIS_PREV_HASH;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const recomputedHash = computeAuditHash({
        actor: row.actor,
        action: row.action,
        resource: row.resource,
        before: row.before,
        after: row.after,
        prevHash: row.prevHash,
        createdAt: row.createdAt,
      });

      if (row.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          checkedCount: i + 1,
          brokenEntry: {
            id: row.id,
            index: i,
            reason: "prev_hash_mismatch",
            expectedPrevHash,
            actualPrevHash: row.prevHash,
            expectedHash: recomputedHash,
            actualHash: row.hash,
          },
        };
      }

      if (row.hash !== recomputedHash) {
        return {
          valid: false,
          checkedCount: i + 1,
          brokenEntry: {
            id: row.id,
            index: i,
            reason: "hash_mismatch",
            expectedPrevHash,
            actualPrevHash: row.prevHash,
            expectedHash: recomputedHash,
            actualHash: row.hash,
          },
        };
      }

      expectedPrevHash = row.hash;
    }

    return {
      valid: true,
      checkedCount: rows.length,
      brokenEntry: null,
    };
  }
}

let activeAuditService: AuditService = new AuditService();

export function getActiveAuditService(): AuditService {
  return activeAuditService;
}

export function setActiveAuditService(service: AuditService): void {
  activeAuditService = service;
}
