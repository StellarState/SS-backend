import { isValidStellarPublicKey, isValidSorobanContractId } from "../../../src/utils/stellar-address.utils";

describe("stellar-address utils", () => {
  describe("isValidStellarPublicKey", () => {
    it("accepts valid Stellar public key starting with G", () => {
      const validKey = "GBBD47UZQ5PQQ4DFFH7D6XWVV37G5FFQVLNGIS2HFJ7FALL3UL5TWUC6";
      expect(isValidStellarPublicKey(validKey)).toBe(true);
    });

    it("rejects non-string input", () => {
      expect(isValidStellarPublicKey(123)).toBe(false);
      expect(isValidStellarPublicKey(null)).toBe(false);
      expect(isValidStellarPublicKey(undefined)).toBe(false);
    });

    it("rejects invalid key format", () => {
      expect(isValidStellarPublicKey("invalid-key")).toBe(false);
      expect(isValidStellarPublicKey("")).toBe(false);
    });

    it("rejects contract addresses (starting with C)", () => {
      const contractAddress = "CBBD47UZQ5PQQ4DFFH7D6XWVV37G5FFQVLNGIS2HFJ7FALL3UL5TWUC6";
      expect(isValidStellarPublicKey(contractAddress)).toBe(false);
    });
  });

  describe("isValidSorobanContractId", () => {
    it("accepts valid Soroban contract ID starting with C", () => {
      const validContractId = "CBBD47UZQ5PQQ4DFFH7D6XWVV37G5FFQVLNGIS2HFJ7FALL3UL5TWUC6";
      expect(isValidSorobanContractId(validContractId)).toBe(true);
    });

    it("rejects non-string input", () => {
      expect(isValidSorobanContractId(123)).toBe(false);
      expect(isValidSorobanContractId(null)).toBe(false);
      expect(isValidSorobanContractId(undefined)).toBe(false);
    });

    it("rejects invalid contract ID format", () => {
      expect(isValidSorobanContractId("invalid-contract")).toBe(false);
      expect(isValidSorobanContractId("")).toBe(false);
    });

    it("rejects Stellar public keys (starting with G)", () => {
      const publicKey = "GBBD47UZQ5PQQ4DFFH7D6XWVV37G5FFQVLNGIS2HFJ7FALL3UL5TWUC6";
      expect(isValidSorobanContractId(publicKey)).toBe(false);
    });

    it("rejects malformed contract addresses", () => {
      expect(isValidSorobanContractId("C" + "0".repeat(55))).toBe(false);
      expect(isValidSorobanContractId("CBBD47UZQ5PQQ4DFFH7D6XWVV37G5FFQVLNGIS2HFJ7FALL3UL5TWUC")).toBe(
        false
      );
    });
  });
});
