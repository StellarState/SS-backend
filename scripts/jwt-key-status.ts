/**
 * Prints JWT signing-key rotation state for operators. Shows key ids, overlap
 * end and revocations only; secret material is never printed.
 *
 *   ts-node -r tsconfig-paths/register scripts/jwt-key-status.ts
 */
import { describeJwtKeyRing, loadJwtKeyRing } from "../src/lib/jwt-keyring";

try {
  console.log(JSON.stringify(describeJwtKeyRing(loadJwtKeyRing(process.env), new Date()), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
