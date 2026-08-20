// 可序列化 schema 的单一真相源已下沉至 @agentany/ws-protocol（ADR-0034 D2：tool_call.schema / resumeSchema
// 均跨进程、跨设备传递）。本模块保留为**兼容 facade**（原实现体量即全量移植），旧 import 面零改动；
// 新代码直接 `import { schema } from "@agentany/ws-protocol"`。
export { schema, validate } from "@agentany/ws-protocol";
export type { Schema, ValidateResult } from "@agentany/ws-protocol";