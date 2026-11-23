import { isIP } from "net";
import type { Repository } from "typeorm";
import { WalletSession } from "../models/WalletSession.model";
import { HttpError } from "../utils/http-error";

export interface WalletSessionRecord {
  id: string;
  wallet: string;
  deviceLabel: string;
  networkPrefix: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface WalletSessionStore {
  insert(record: WalletSessionRecord): Promise<void>;
  findById(id: string): Promise<WalletSessionRecord | null>;
  listActive(wallet: string, now: Date): Promise<WalletSessionRecord[]>;
  revoke(wallet: string, id: string, now: Date): Promise<boolean>;
}

export interface PublicWalletSession {
  id: string;
  deviceLabel: string;
  networkPrefix: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const OPERATING_SYSTEMS: Array<[RegExp, string]> = [
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/**
 * A coarse "<browser> on <OS>" label. Matches only against a fixed allow-list,
 * so no part of the raw user agent (version strings, device model, tokens)
 * is ever stored or returned.
 */
export function describeDevice(userAgent: string | undefined | null): string {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Unknown browser";
  const os = OPERATING_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Unknown OS";
  return `${browser} on ${os}`;
}

/**
 * Masks a client address to its network prefix: `a.b.c.0/24` for IPv4 and the
 * first three groups of `/48` for IPv6. Returns null when the input is not an
 * IP address, so proxy headers that carry garbage are never stored verbatim.
 */
export function networkPrefix(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const candidate = ip.trim().replace(/^::ffff:/i, "");
  const family = isIP(candidate);
  if (family === 4) {
    const [a, b, c] = candidate.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (family === 6) {
    const groups = expandIpv6(candidate);
    return groups ? `${groups.slice(0, 3).join(":")}::/48` : null;
  }
  return null;
}

function expandIpv6(address: string): string[] | null {
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (address.includes("::") ? missing < 0 : headGroups.length !== 8) return null;
  const zeros = Array.from({ length: Math.max(missing, 0) }, () => "0");
  const groups = [...headGroups, ...zeros, ...tailGroups];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => group.padStart(4, "0"));
}

export class WalletSessionService {
  constructor(
    private readonly store: WalletSessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(input: {
    id: string;
    wallet: string;
    userAgent?: string | null;
    ipAddress?: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await this.store.insert({
      id: input.id,
      wallet: input.wallet,
      deviceLabel: describeDevice(input.userAgent),
      networkPrefix: networkPrefix(input.ipAddress),
      createdAt: this.now(),
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
  }

  /** Rejects tokens whose session was revoked, expired, or never recorded for this wallet. */
  async assertActive(id: string, wallet: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(401, "Invalid or expired token.");
    }
    const record = await this.store.findById(id);
    const now = this.now().getTime();
    if (
      !record ||
      record.wallet !== wallet ||
      record.revokedAt !== null ||
      record.expiresAt.getTime() <= now
    ) {
      throw new HttpError(401, "Invalid or expired token.");
    }
  }

  async list(wallet: string, currentSessionId: string | undefined): Promise<PublicWalletSession[]> {
    const records = await this.store.listActive(wallet, this.now());
    return records.map((record) => ({
      id: record.id,
      deviceLabel: record.deviceLabel,
      networkPrefix: record.networkPrefix,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      current: record.id === currentSessionId,
    }));
  }

  async revoke(wallet: string, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    return this.store.revoke(wallet, id, this.now());
  }
}

export class TypeOrmWalletSessionStore implements WalletSessionStore {
  constructor(private readonly repository: Repository<WalletSession>) {}

  async insert(record: WalletSessionRecord): Promise<void> {
    await this.repository.insert(record);
  }

  async findById(id: string): Promise<WalletSessionRecord | null> {
    return this.repository.findOne({ where: { id } });
  }

  async listActive(wallet: string, now: Date): Promise<WalletSessionRecord[]> {
    return this.repository
      .createQueryBuilder("session")
      .where("session.wallet = :wallet", { wallet })
      .andWhere("session.revokedAt IS NULL")
      .andWhere("session.expiresAt > :now", { now })
      .orderBy("session.createdAt", "DESC")
      .take(100)
      .getMany();
  }

  async revoke(wallet: string, id: string, now: Date): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(WalletSession)
      .set({ revokedAt: now })
      .where("id = :id AND wallet = :wallet AND revoked_at IS NULL", { id, wallet })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
