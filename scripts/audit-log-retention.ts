/**
 * Operator CLI for audit-log retention and legal holds.
 *
 *   ts-node -r tsconfig-paths/register scripts/audit-log-retention.ts run
 *   ts-node -r tsconfig-paths/register scripts/audit-log-retention.ts hold <userId> <reason...>
 *   ts-node -r tsconfig-paths/register scripts/audit-log-retention.ts release <holdId>
 */
import "reflect-metadata";
import { closeDataSource, initializeDataSource } from "../src/config/data-source";
import {
  createTypeOrmPurgeBatch,
  placeAuditHold,
  releaseAuditHold,
  resolveAuditRetentionPolicy,
  runAuditRetention,
} from "../src/services/audit-log-retention.service";

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const dataSource = await initializeDataSource();
  try {
    if (command === "run") {
      const result = await runAuditRetention({
        policy: resolveAuditRetentionPolicy(process.env),
        now: new Date(),
        purgeBatch: createTypeOrmPurgeBatch(dataSource),
      });
      console.log(JSON.stringify(result, null, 2));
      return result.complete ? 0 : 2;
    }

    if (command === "hold") {
      const [subjectUserId, ...reasonParts] = args;
      if (!subjectUserId || reasonParts.length === 0) {
        console.error("usage: hold <userId> <reason...>");
        return 1;
      }
      const hold = await placeAuditHold(dataSource, {
        subjectUserId,
        reason: reasonParts.join(" "),
        placedByUserId: null,
      });
      console.log(JSON.stringify({ holdId: hold.id, subjectUserId: hold.subjectUserId }, null, 2));
      return 0;
    }

    if (command === "release") {
      const [holdId] = args;
      if (!holdId) {
        console.error("usage: release <holdId>");
        return 1;
      }
      const released = await releaseAuditHold(dataSource, holdId, new Date());
      console.log(JSON.stringify({ holdId, released }, null, 2));
      return released ? 0 : 1;
    }

    console.error("usage: audit-log-retention.ts run | hold <userId> <reason...> | release <holdId>");
    return 1;
  } finally {
    await closeDataSource();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
