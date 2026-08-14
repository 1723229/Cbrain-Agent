import { describe, expect, it } from "vitest";
import { sanitizeApiPayload } from "./api-sanitize.js";

describe("sanitizeApiPayload", () => {
  it("redacts web session and recovery credentials", () => {
    const value = sanitizeApiPayload(
      {
        session_token: "cs-secret-session-token-value",
        nested: { password: "ldap-password" },
      },
      300,
    ) as Record<string, unknown>;

    expect(value.session_token).not.toBe("cs-secret-session-token-value");
    expect((value.nested as Record<string, unknown>).password).not.toBe("ldap-password");
  });
});
