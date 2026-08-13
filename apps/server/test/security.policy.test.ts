// ticket #18：CommandPolicy 单元测试。纯函数（无 DB）；显式传 posture，禁 set process.env（防泄漏）。
import { describe, test, expect } from "bun:test";
import { resolvePosture, decide, POSTURES } from "../src/security/policy";

describe("policy · resolvePosture", () => {
  test("显式 env：dangerous/auto/strict 直返", () => {
    expect(resolvePosture("dangerous")).toBe("dangerous");
    expect(resolvePosture("auto")).toBe("auto");
    expect(resolvePosture("strict")).toBe("strict");
  });
  test("缺省/空 → auto", () => {
    expect(resolvePosture(undefined)).toBe("auto");
    expect(resolvePosture("")).toBe("auto");
  });
  test("非法值 → auto（warn，不抛；大小写敏感）", () => {
    expect(resolvePosture("garbage")).toBe("auto");
    expect(resolvePosture("STRICT")).toBe("auto");
  });
});

describe("policy · decide 矩阵（显式 posture，不碰 process.env）", () => {
  test("dangerous：全 allow（* 通配）", () => {
    expect(decide("synthetic-3step", "dangerous").decision).toBe("allow");
    expect(decide("brand-research", "dangerous").decision).toBe("allow");
    expect(decide("anything-else", "dangerous").decision).toBe("allow");
  });
  test("auto：synthetic allow / brand-* require_approval / 其它 deny（fail-closed）", () => {
    expect(decide("synthetic-3step", "auto").decision).toBe("allow");
    expect(decide("brand-research", "auto").decision).toBe("require_approval");
    expect(decide("brand-strategy-analysis", "auto").decision).toBe("require_approval");
    expect(decide("unknown-wf", "auto").decision).toBe("deny");
  });
  test("strict：一切 require_approval（* 通配）", () => {
    expect(decide("synthetic-3step", "strict").decision).toBe("require_approval");
    expect(decide("brand-research", "strict").decision).toBe("require_approval");
    expect(decide("whatever", "strict").decision).toBe("require_approval");
  });
  test("verdict 带 reason（命中规则 / fail-closed）", () => {
    expect(decide("synthetic-3step", "auto").reason).toMatch(/auto/);
    expect(decide("unknown-wf", "auto").reason).toMatch(/fail-closed/);
  });
  test("fail-closed：auto 无 * 规则，未列工作流一律 deny（契 ADR-0011:24）", () => {
    expect(POSTURES.auto.some((r) => r.workflowId === "*")).toBe(false);
    expect(decide("brand-research-v2", "auto").decision).toBe("deny");
  });
});

describe("policy · 调用时读 env（缺省 posture，不 set process.env）", () => {
  test("decide 不传 posture → resolvePosture() → 测试环境 env 未设 = auto", () => {
    expect(decide("synthetic-3step").decision).toBe("allow");
    expect(decide("brand-research").decision).toBe("require_approval");
    expect(decide("unknown").decision).toBe("deny");
  });
});
