import jwt from "jsonwebtoken";
import {
  buildAuthFailureDetails,
  truncateWalletAddress,
} from "../../src/lib/auth-failure";

describe("auth failure helpers", () => {
  it("truncates wallet addresses consistently", () => {
    expect(truncateWalletAddress("GABCDEFGHIJKLMNO1234567890")).toBe("GABC...7890");
    expect(truncateWalletAddress("G123")).toBe("G123");
    expect(truncateWalletAddress(null)).toBeNull();
  });

  it("extracts a truncated address from a parseable token", () => {
    const token = jwt.sign(
      { sub: "GABCDEFGHIJKLMNO1234567890" },
      "test-secret",
      { expiresIn: "1h" },
    );

    expect(buildAuthFailureDetails(token, "invalid_signature")).toEqual({
      authFailure: {
        reason: "invalid_signature",
        truncatedAddress: "GABC...7890",
        failedAt: expect.any(String),
      },
    });
  });

  it("returns null truncated addresses for unparseable tokens", () => {
    expect(buildAuthFailureDetails("not-a-jwt", "invalid_token")).toEqual({
      authFailure: {
        reason: "invalid_token",
        truncatedAddress: null,
        failedAt: expect.any(String),
      },
    });
  });
});
