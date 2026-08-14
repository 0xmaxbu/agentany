// lib/group（f2-3）：会话按 workspace 分组纯函数——组序=workspaces 返回序、组内保持传入序（updatedAt 倒序）、未知 ws 落「默认」组。
import { describe, test, expect } from "bun:test";
import { groupByWorkspace } from "../src/lib/group";
import type { Workspace } from "../src/api";
import type { ConversationRow } from "../src/api";

const ws = (id: string, name: string): Workspace => ({ id, slug: id, name, allUsers: true, createdAt: "t", updatedAt: "t" });
const conv = (id: string, workspaceId: string): ConversationRow => ({ id, workspaceId, userId: "u1", title: null, createdAt: "t", updatedAt: "t" });

describe("groupByWorkspace", () => {
  test("多 ws 分组：组序 = workspaces 返回序；组内保持传入序（倒序传入→倒序展示）", () => {
    const wss = [ws("ws_company", "公司"), ws("ws_acme", "Acme")];
    const convs = [conv("c_new", "ws_company"), conv("c_old", "ws_company"), conv("c_acme", "ws_acme")];
    const g = groupByWorkspace(wss, convs);
    expect(g.map((x) => x.workspace.name)).toEqual(["公司", "Acme"]);
    expect(g[0].items.map((c) => c.id)).toEqual(["c_new", "c_old"]); // 传入序不动
    expect(g[1].items.map((c) => c.id)).toEqual(["c_acme"]);
  });

  test("未知 workspaceId（ws 列表缺失）→ 落单个「默认」组且排最后", () => {
    const g = groupByWorkspace([ws("ws_company", "公司")], [conv("c1", "ws_company"), conv("c2", "ws_ghost")]);
    expect(g).toHaveLength(2);
    expect(g[1].workspace.name).toBe("默认");
    expect(g[1].items.map((c) => c.id)).toEqual(["c2"]);
  });

  test("多个未知 workspaceId → 合并进同一个「默认」组（不各建组头）", () => {
    const g = groupByWorkspace([ws("ws_company", "公司")], [conv("c1", "ws_ghost1"), conv("c2", "ws_ghost2")]);
    expect(g).toHaveLength(2);
    expect(g[1].workspace.name).toBe("默认");
    expect(g[1].items.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("空会话 → 各 ws 仍出组（空 items，Sidebar 显组头）", () => {
    const g = groupByWorkspace([ws("a", "A"), ws("b", "B")], []);
    expect(g.map((x) => x.workspace.name)).toEqual(["A", "B"]);
    expect(g.every((x) => x.items.length === 0)).toBe(true);
  });

  test("空 workspaces + 有会话 → 全落「默认」", () => {
    const g = groupByWorkspace([], [conv("c1", "ws_x")]);
    expect(g).toHaveLength(1);
    expect(g[0].workspace.name).toBe("默认");
  });

  test("两输入全空 → 空数组", () => {
    expect(groupByWorkspace([], [])).toEqual([]);
  });
});
