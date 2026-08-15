// #手风琴：ws 组显示序纯函数——公司置顶 + 其余 lastActiveAt 倒序（null 用 updatedAt 兜底）。
import { describe, test, expect } from "bun:test";
import { sortWorkspaces } from "../src/store/workspace";
import type { Workspace } from "../src/api";

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id, slug: id, name: id, allUsers: false, createdAt: "", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});

describe("sortWorkspaces", () => {
  test("公司置顶（即使很久没活跃）；其余按 lastActiveAt 倒序", () => {
    const out = sortWorkspaces([
      ws("ws_b", { lastActiveAt: "2026-08-10T00:00:00.000Z" }),
      ws("ws_company", { lastActiveAt: "2026-01-01T00:00:00.000Z" }),
      ws("ws_a", { lastActiveAt: "2026-08-14T00:00:00.000Z" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_company", "ws_a", "ws_b"]);
  });

  test("无 lastActiveAt（无会话的 ws）用 updatedAt 兜底，排有活动的后面", () => {
    const out = sortWorkspaces([
      ws("ws_new_empty", { updatedAt: "2026-08-15T00:00:00.000Z" }), // 刚建但无会话
      ws("ws_active", { lastActiveAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_active", "ws_new_empty"]); // 兜底时间晚但排在后
  });

  test("全无会话：updatedAt 倒序（近建的在前）", () => {
    const out = sortWorkspaces([
      ws("ws_old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      ws("ws_new", { updatedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_new", "ws_old"]);
  });
});
