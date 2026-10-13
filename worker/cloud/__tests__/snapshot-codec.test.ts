import { expect, test } from 'vitest';
import { encodeSnapshot, decodeSnapshot } from '../snapshot-codec';
test('cloud archive compression preserves exact response bytes and reads legacy JSON',()=>{
 const raw=' {"text":"héllo","padding":"'+'abcd'.repeat(20000)+'"}\n';
 const encoded=encodeSnapshot(raw);
 expect(encoded.length).toBeLessThan(raw.length/10);
 expect(decodeSnapshot(encoded)).toBe(raw);
 expect(decodeSnapshot(raw)).toBe(raw);
 expect(()=>decodeSnapshot('hob:gzip:v1:invalid')).toThrow();
});
