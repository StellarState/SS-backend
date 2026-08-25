import { nativeToScVal, xdr } from "stellar-sdk";

export function scValI128(amount: bigint | string): xdr.ScVal {
  return nativeToScVal(BigInt(amount), { type: "i128" });
}

export function scValU64(val: number): xdr.ScVal {
  return nativeToScVal(val, { type: "u64" });
}
