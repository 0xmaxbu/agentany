// lib/token（f2）：token 存取三函数（localStorage 薄封装——契约：key 名 + 容错）。
import { describe, test, expect, beforeEach } from "bun:test";
import { getToken, setToken, clearToken, TOKEN_KEY } from "../src/lib/token";

describe("lib/token", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("key 名固定 agentany.token.v1（勿改——已发布用户 localStorage 兼容）", () => {
    expect(TOKEN_KEY).toBe("agentany.token.v1");
  });

  test("set → get → clear 往返", () => {
    expect(getToken()).toBeNull(); // 未设 = null（非 undefined）
    setToken("tok_abc");
    expect(getToken()).toBe("tok_abc");
    clearToken();
    expect(getToken()).toBeNull();
  });

  test("clear 未设时 no-op 不炸", () => {
    clearToken();
    expect(getToken()).toBeNull();
  });
});
