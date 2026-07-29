import { StrKey } from "stellar-sdk";

export function isValidStellarPublicKey(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}
