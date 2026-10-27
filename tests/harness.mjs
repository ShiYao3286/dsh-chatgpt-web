let passed = 0;
let failed = 0;
const failures = [];
let scope = "(root)";

export function section(name) {
  scope = name;
  console.log("");
  console.log("## " + name);
}

export function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log("  PASS  " + label);
  } else {
    failed += 1;
    failures.push(scope + " / " + label);
    console.log("  FAIL  " + label);
  }
}

export function eq(actual, expected, label) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log("  PASS  " + label);
  } else {
    failed += 1;
    failures.push(scope + " / " + label + "\n    actual:   " + a + "\n    expected: " + e);
    console.log("  FAIL  " + label);
    console.log("        actual:   " + a);
    console.log("        expected: " + e);
  }
}

export function deepEq(actual, expected, label) {
  eq(JSON.stringify(actual), JSON.stringify(expected), label);
}

export function summary() {
  console.log("");
  console.log("================================");
  console.log("  PASS " + passed + "   FAIL " + failed);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log("  x " + f);
  }
  console.log("================================");
  if (failed > 0) process.exitCode = 1;
}
