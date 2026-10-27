// 页面侧 PoW 运行时：SHA3-512 + ChatGPT 挑战求解。
// 与 src/pow/{sha3,solve}.ts 是同一套算法的两份实现（页面里没有 node:crypto，
// 也无法 import ESM），一致性由 tests/check-page-pow.test.mjs 的**差分测试**钉住：
// 同一输入必须得到逐字节相同的输出。
(function () {
  var MASK = (1n << 64n) - 1n;
  var RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  var RHO = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];
  function rotl(v, n) {
    if (n === 0) return v & MASK;
    var b = BigInt(n);
    return ((v << b) | (v >> (64n - b))) & MASK;
  }
  function keccakF(A) {
    var C = new Array(5), B = new Array(25);
    for (var round = 0; round < 24; round++) {
      for (var x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
      for (var x2 = 0; x2 < 5; x2++) {
        var d = C[(x2 + 4) % 5] ^ rotl(C[(x2 + 1) % 5], 1);
        for (var y = 0; y < 25; y += 5) A[x2 + y] ^= d;
      }
      for (var x3 = 0; x3 < 5; x3++) {
        for (var y2 = 0; y2 < 5; y2++) B[y2 + 5 * ((2 * x3 + 3 * y2) % 5)] = rotl(A[x3 + 5 * y2], RHO[x3][y2]);
      }
      for (var x4 = 0; x4 < 5; x4++) {
        for (var y3 = 0; y3 < 5; y3++) {
          var i = x4 + 5 * y3;
          A[i] = B[i] ^ ((~B[(x4 + 1) % 5 + 5 * y3] & MASK) & B[(x4 + 2) % 5 + 5 * y3]);
        }
      }
      A[0] ^= RC[round];
    }
  }
  function sha3_512(bytes) {
    var RATE = 72;
    var S = new Array(25);
    for (var z = 0; z < 25; z++) S[z] = 0n;
    var padLen = RATE - (bytes.length % RATE);
    var padded = new Uint8Array(bytes.length + padLen);
    padded.set(bytes);
    padded[bytes.length] ^= 0x06;
    padded[padded.length - 1] ^= 0x80;
    for (var off = 0; off < padded.length; off += RATE) {
      for (var k = 0; k < RATE / 8; k++) {
        var lane = 0n;
        for (var b = 0; b < 8; b++) lane |= BigInt(padded[off + k * 8 + b]) << BigInt(8 * b);
        S[k] ^= lane;
      }
      keccakF(S);
    }
    var out = new Uint8Array(64);
    for (var m = 0; m < 8; m++) {
      var L = S[m];
      for (var q = 0; q < 8; q++) { out[m * 8 + q] = Number(L & 0xffn); L >>= 8n; }
    }
    return out;
  }
  var enc = new TextEncoder();
  function utf8(s) { return enc.encode(s); }
  function toBase64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }
  function concat(a, b) {
    var o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  }
  function utcParseTime(ms) {
    var d = new Date(ms);
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var p = function (n) { return String(n).padStart(2, "0"); };
    return days[d.getUTCDay()] + " " + months[d.getUTCMonth()] + " " + p(d.getUTCDate()) + " " +
      d.getUTCFullYear() + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) +
      " GMT+0200 (Central European Summer Time)";
  }
  function buildPowConfig(env) {
    var core = String(env.hardwareConcurrency == null ? 8 : env.hardwareConcurrency);
    var screen = String(env.screenWidth == null ? 1920 : env.screenWidth);
    var now = env.now == null ? Date.now() : env.now;
    return [
      core + screen, utcParseTime(now), null, Math.random(), env.userAgent, null,
      env.dataBuild == null ? "" : env.dataBuild, "en-US", (env.languages || ["en-US"]).join(","),
      0, "webdriver", "location", "window", env.perfNow, env.uuid, "", 8, Math.floor(now / 1000),
    ];
  }
  function solve(seed, difficulty, config, maxAttempts) {
    var t0 = Date.now();
    var diffLen = difficulty.length;
    var target = parseInt(difficulty, 16);
    var seedBytes = utf8(seed);
    var p1s = JSON.stringify(config.slice(0, 3)).slice(0, -1) + ",";
    var p2s = "," + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ",";
    var p3s = "," + JSON.stringify(config.slice(10)).slice(1);
    var p1 = utf8(p1s), p2 = utf8(p2s), p3 = utf8(p3s);
    for (var i = 0; i < maxAttempts; i++) {
      var d1 = utf8(String(i));
      var d2 = utf8(String(i >> 1));
      var body = concat(concat(concat(concat(p1, d1), p2), d2), p3);
      var base = toBase64(body);
      var digest = sha3_512(concat(seedBytes, utf8(base)));
      if (parseInt(toHex(digest).slice(0, diffLen), 16) <= target) {
        return { token: base, attempts: i + 1, ms: Date.now() - t0 };
      }
    }
    throw new Error("PoW unsolved after " + maxAttempts);
  }
  function solveRequirementsToken(config, maxAttempts) {
    var r = solve(String(Math.random()), "0fffff", config, maxAttempts || 500000);
    return { token: "gAAAAAC" + r.token, attempts: r.attempts, ms: r.ms };
  }
  function solveProofToken(challenge, config, maxAttempts) {
    var r = solve(challenge.seed, challenge.difficulty, config, maxAttempts || 500000);
    return { token: "gAAAAAB" + r.token, attempts: r.attempts, ms: r.ms };
  }
  globalThis.__POW__ = {
    sha3_512: sha3_512,
    utf8: utf8,
    toBase64: toBase64,
    toHex: toHex,
    utcParseTime: utcParseTime,
    buildPowConfig: buildPowConfig,
    solveRequirementsToken: solveRequirementsToken,
    solveProofToken: solveProofToken,
    newId: function () { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); },
  };
})();
