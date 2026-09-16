/** Lex the already validated disk JSON without decoding any token's value. */
export function jsonTokens(text: string): string[] {
  const token = /[ \t\r\n]+|"(?:\\(?:["\\/bfnrt]|u[\da-fA-F]{4})|[^"\\\u0000-\u001f])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) throw new Error(`Invalid JSON token at offset ${offset}`);
    if (!/^[ \t\r\n]/.test(match[0])) tokens.push(match[0]);
    offset = token.lastIndex;
  }
  return tokens;
}

/** Change only inter-token whitespace: no object parsing, sorting or rounding. */
export function formatJsonText(text: string): string {
  const tokens = jsonTokens(text);
  const out: string[] = [];
  let depth = 0;
  const newline = () => out.push("\n", "  ".repeat(depth));
  for (const [index, token] of tokens.entries()) {
    if (token === "{" || token === "[") {
      out.push(token);
      depth++;
      if (tokens[index + 1] !== (token === "{" ? "}" : "]")) newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== (token === "}" ? "{" : "[")) newline();
      out.push(token);
    } else if (token === ",") {
      out.push(token);
      newline();
    } else out.push(token === ":" ? ": " : token);
  }
  return out.join("");
}
