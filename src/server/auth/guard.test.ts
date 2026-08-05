import { describe, expect, it } from "vitest";
import type { Manager } from "../db/schema";
import { assertCommissioner } from "./guard";

function makeManager(overrides: Partial<Manager> = {}): Manager {
  return {
    id: 1,
    name: "Test Manager",
    franchiseId: null,
    role: "manager",
    inviteToken: "test-token",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("assertCommissioner", () => {
  it("does not throw for a commissioner", () => {
    expect(() => assertCommissioner(makeManager({ role: "commissioner" }))).not.toThrow();
  });

  it("denies a manager-role manager", () => {
    expect(() => assertCommissioner(makeManager({ role: "manager" }))).toThrow();
  });
});
