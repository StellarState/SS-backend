import { Keypair, StrKey } from "stellar-sdk";
import {
  isValidSorobanContractId,
  isValidStellarPublicKey,
} from "../../src/lib/stellar-address";

describe("stellar address validators", () => {
  it("accepts a valid Soroban contract C-address", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));

    expect(isValidSorobanContractId(contractId)).toBe(true);
  });

  it("rejects Stellar public keys when a Soroban contract ID is required", () => {
    expect(isValidSorobanContractId(Keypair.random().publicKey())).toBe(false);
  });

  it("rejects malformed or non-string contract IDs", () => {
    expect(isValidSorobanContractId("CNOT-A-VALID-CONTRACT")).toBe(false);
    expect(isValidSorobanContractId("")).toBe(false);
    expect(isValidSorobanContractId(null)).toBe(false);
    expect(isValidSorobanContractId(undefined)).toBe(false);
    expect(isValidSorobanContractId(123)).toBe(false);
  });

  it("keeps Stellar public key validation separate from contract IDs", () => {
    const publicKey = Keypair.random().publicKey();
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 8));

    expect(isValidStellarPublicKey(publicKey)).toBe(true);
    expect(isValidStellarPublicKey(contractId)).toBe(false);
  });
});
