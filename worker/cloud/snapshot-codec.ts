import { gzipSync, gunzipSync } from "node:zlib";

const PREFIX = "hob:gzip:v1:";
/** Cloud storage envelope only. Decoding restores the verbatim ESPN body/hash. */
export function encodeSnapshot(payload: string): string {
  return PREFIX + gzipSync(Buffer.from(payload, "utf8")).toString("base64");
}

export function decodeSnapshot(payload: string): string {
  return payload.startsWith(PREFIX)
    ? gunzipSync(Buffer.from(payload.slice(PREFIX.length), "base64"), { maxOutputLength: 32_000_000 }).toString("utf8")
    : payload;
}
