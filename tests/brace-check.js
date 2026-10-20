// Counts braces outside strings and comments, to find where a file lost its
// balance. Run: node tests/brace-check.js <file>
import { readFileSync } from "node:fs";

const file = process.argv[2];
const s = readFileSync(file, "utf8");

let depth = 0;
let line = 1;
let quote = null;
const stack = [];

for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (c === "\n") line++;
  if (quote) {
    if (c === "\\") { i++; continue; }
    if (c === quote) quote = null;
    continue;
  }
  if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
  if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; line++; continue; }
  if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i) + 1; continue; }
  if (c === "{" || c === "(" || c === "[") { stack.push({ c, line }); depth++; }
  if (c === "}" || c === ")" || c === "]") {
    const open = stack.pop();
    depth--;
    if (!open) { console.log(`лишний ${c} на строке ${line}`); }
    else if (open.c !== { "}": "{", ")": "(", "]": "[" }[c]) {
      console.log(`закрыт ${c} на строке ${line}, а открыт ${open.c} на строке ${open.line}`);
    }
  }
}
console.log(`${file}: незакрытых ${depth}`);
for (const o of stack.slice(0, 5)) console.log(`  не закрыт ${o.c} со строки ${o.line}`);
