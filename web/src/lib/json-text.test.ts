import assert from "node:assert/strict";
import test from "node:test";
import { formatJsonText, jsonTokens } from "./json-text.ts";

test("raw formatting indents two spaces and preserves every disk token", () => {
  const line = ' {"10":1.2300e+004,"2":900719925474099312345,"n":-0,"n":1E-9,"x":[{},[],true,false,null,"é\\u0041\\n\\\"{},:"],"spaced":"  keep  "}\r\n';
  const formatted = formatJsonText(line);
  assert.deepEqual(jsonTokens(formatted), jsonTokens(line));
  assert.equal(formatted, [
    '{', '  "10": 1.2300e+004,', '  "2": 900719925474099312345,',
    '  "n": -0,', '  "n": 1E-9,', '  "x": [', '    {},', '    [],',
    '    true,', '    false,', '    null,', '    "é\\u0041\\n\\\"{},:"',
    '  ],', '  "spaced": "  keep  "', '}',
  ].join('\n'));
  assert.equal(formatJsonText(formatted), formatted);
});

test("token formatting handles empty containers and scalar roots", () => {
  for (const line of ['{}', '[]', '"\\t"', 'false', 'null', '-2.00e-7'])
    assert.equal(formatJsonText(` \t${line}\r\n`), line);
  assert.throws(() => formatJsonText('{"secret":NaN}'), /Invalid JSON token/);
});
