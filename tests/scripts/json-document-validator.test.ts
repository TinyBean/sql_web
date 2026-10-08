import assert from "node:assert/strict";
import test from "node:test";
import { JsonDocumentValidator } from "../../scripts/database/json-document-validator.ts";

test("JSON validation accepts escaped and nested payloads across stream boundaries", () => {
  for (const value of [null, true, 123, -1.2e-5, "中文😀\\\"", [], {},
    { response: { result: { row: [{ text: "[}\\\"", n: null, nested: [false, 1] }] } } }]) {
    const document = JSON.stringify(value);
    for (const size of [1, 3, 10_000]) {
      const validator = new JsonDocumentValidator();
      for (let offset = 0; offset < document.length; offset += size) validator.push(document.slice(offset, offset + size));
      validator.finish();
    }
  }
});

test("JSON validation rejects incomplete envelopes, extra roots, bad separators and invalid scalars", () => {
  for (const document of ['{"row":[]', '{"row":[]}garbage', '{}[]', '{"row":[],}',
    '[1,]', '{"row":[] "x":1}', '{"x" 1}', '{"x":tru}', 'NaN', '01', '"unclosed', '[}', '']) {
    const validator = new JsonDocumentValidator();
    assert.throws(() => { validator.push(document); validator.finish(); }, document);
  }
});
