import { describe, expect, it } from "vitest";
import { classifyConnectionStatus } from "../../src/shared/utils/connectionStatus.js";

describe("classifyConnectionStatus", () => {
  it.each([
    { testStatus: "active", isActive: true },
    { testStatus: "success", isActive: true },
    { testStatus: null, isActive: true },
    { isActive: true },
  ])("classifies enabled connection as active: %o", (connection) => {
    expect(classifyConnectionStatus(connection)).toBe("active");
  });

  it.each([
    { testStatus: "unavailable", isActive: true },
    { testStatus: "error", isActive: true },
    { testStatus: "expired", isActive: true },
    { testStatus: null, isActive: false },
  ])("classifies unavailable connection: %o", (connection) => {
    expect(classifyConnectionStatus(connection)).toBe("unavailable");
  });
});
