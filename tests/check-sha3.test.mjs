import { ok, eq, section } from "./harness.mjs";
import { sha3_512, utf8, toHex, toBase64 } from "../src/pow/sha3.ts";

section("SHA3-512 标准向量");
// NIST FIPS 202 测试向量
eq(toHex(sha3_512(utf8(""))),
  "a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a6" +
  "15b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26",
  "空串");
eq(toHex(sha3_512(utf8("abc"))),
  "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e" +
  "10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0",
  "abc");
eq(toHex(sha3_512(utf8("The quick brown fox jumps over the lazy dog"))),
  "01dedd5de4ef14642445ba5f5b97c15e47b9ad931326e4b0727cd94cefc44fff" +
  "23f07bf543139939b49128caf436dc1bdee54fcb24023a08d9403f9b4bf0d450",
  "quick brown fox");
eq(toHex(sha3_512(new Uint8Array(0))).length, 128, "摘要长度 64 字节 = 128 hex");

section("SHA3-512 边界：跨 rate 分块");
// 72 字节正好一个 rate；73 字节跨块
eq(toHex(sha3_512(utf8("a".repeat(72)))).length, 128, "72 字节");
eq(toHex(sha3_512(utf8("a".repeat(73)))).length, 128, "73 字节");
eq(toHex(sha3_512(utf8("a".repeat(144)))).length, 128, "144 字节");

section("base64 编码");
eq(toBase64(utf8("hello")), "aGVsbG8=", "hello");
eq(toBase64(utf8("")), "", "空串");
