// spikes/spike-b/schema.mjs — 最小手搓 schema（仅够 spike 的契约校验）。
// prod 换 zod：API 形状保持 { _t, ... } → ZodType，validate → safeParse。
export const schema = {
  any: () => ({ _t: "any" }),
  string: () => ({ _t: "string" }),
  number: () => ({ _t: "number" }),
  boolean: () => ({ _t: "boolean" }),
  enum: (...vals) => ({ _t: "enum", vals }),
  optional: (inner) => ({ _t: "optional", inner }),
  object: (shape) => ({ _t: "object", shape }),
};

// 返回 { ok:true } | { ok:false, error }
export function validate(s, data, path = "root") {
  if (!s) return { ok: true };
  switch (s._t) {
    case "any": return { ok: true };
    case "optional":
      return data === undefined ? { ok: true } : validate(s.inner, data, path);
    case "string":
      return typeof data === "string" ? { ok: true } : { ok: false, error: `${path}: expected string` };
    case "number":
      return typeof data === "number" ? { ok: true } : { ok: false, error: `${path}: expected number` };
    case "boolean":
      return typeof data === "boolean" ? { ok: true } : { ok: false, error: `${path}: expected boolean` };
    case "enum":
      return s.vals.includes(data) ? { ok: true } : { ok: false, error: `${path}: expected one of ${JSON.stringify(s.vals)}` };
    case "object": {
      if (typeof data !== "object" || data === null) return { ok: false, error: `${path}: expected object` };
      for (const [k, child] of Object.entries(s.shape)) {
        if (!(k in data) && child._t !== "optional")
          return { ok: false, error: `${path}.${k}: missing` };
        if (k in data) {
          const r = validate(child, data[k], `${path}.${k}`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: `${path}: unknown schema type ${s._t}` };
  }
}
