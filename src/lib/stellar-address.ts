import { StrKey } from "stellar-sdk";

export function isValidStellarPublicKey(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

export function isValidSorobanContractId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    StrKey.decodeContract(value);
    return true;
  } catch {
    return false;
  }
}
