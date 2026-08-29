import { StrKey } from "stellar-sdk";

export function isValidStellarPublicKey(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

export function isValidSorobanContractId(contractId: unknown): contractId is string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof contractId === "string" && (StrKey as any).isValidContract(contractId);
}
