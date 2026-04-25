import { AppError, HttpError } from "../src/utils/http-error";

describe("AppError", () => {
  it("creates an AppError with statusCode, code, and message", () => {
    const error = new AppError(400, "Invalid input", "INVALID_INPUT");

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("Invalid input");
    expect(error.name).toBe("AppError");
  });

  it("includes optional details", () => {
    const details = { field: "email", reason: "required" };
    const error = new AppError(400, "Invalid email", "INVALID_EMAIL", details);

    expect(error.details).toEqual(details);
  });

  it("extends Error and has proper stack trace", () => {
    const error = new AppError(500, "Database error", "DB_ERROR");

    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeDefined();
  });
});

describe("HttpError", () => {
  it("creates an HttpError with statusCode and auto-generated code", () => {
    const error = new HttpError(404, "Not found");

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("HTTP_404");
    expect(error.message).toBe("Not found");
    expect(error.name).toBe("HttpError");
  });

  it("includes optional details", () => {
    const details = { path: "/api/users/123" };
    const error = new HttpError(404, "User not found", details);

    expect(error.details).toEqual(details);
  });

  it("extends Error and has proper stack trace", () => {
    const error = new HttpError(503, "Service unavailable");

    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeDefined();
  });
});
