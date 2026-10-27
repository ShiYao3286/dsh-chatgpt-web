// 在页面上下文中执行的一轮对话。由 turn.ts 作为字符串注入。
// 依赖注入：__POW__（{ buildPowConfig, solveRequirementsToken, solveProofToken, newId }）
(async () => {
  const REQ = globalThis.__TURN_REQ__;
  const POW = globalThis.__POW__;
  const out = { status: 0, frames: [], sawDone: false, ttfbMs: 0, totalMs: 0, failure: null, errorBody: null };
  const t0 = performance.now();
  try {
    const ses = await fetch("/api/auth/session", { credentials: "include" });
    const sj = await ses.json().catch(() => null);
    const token = sj && typeof sj.accessToken === "string" ? sj.accessToken : null;
    if (!token) {
      out.failure = "no-token";
      out.totalMs = Math.round(performance.now() - t0);
      return out;
    }
    const auth = { authorization: "Bearer " + token };
    const cfg = POW.buildPowConfig({
      userAgent: navigator.userAgent,
      languages: navigator.languages || ["en-US"],
      hardwareConcurrency: navigator.hardwareConcurrency,
      screenWidth: (window.screen && window.screen.width) || 1920,
      dataBuild: (document.documentElement && document.documentElement.getAttribute("data-build")) || "",
      uuid: POW.newId(),
      perfNow: performance.now(),
    });
    const req = POW.solveRequirementsToken(cfg);
    const senRes = await fetch("/backend-api/sentinel/chat-requirements", {
      method: "POST",
      credentials: "include",
      headers: Object.assign({ "content-type": "application/json" }, auth),
      body: JSON.stringify({ p: req.token }),
    });
    const sen = await senRes.json().catch(() => null);
    let proof = null;
    if (sen && sen.proofofwork && sen.proofofwork.required) {
      try {
        proof = POW.solveProofToken(
          { required: true, seed: sen.proofofwork.seed, difficulty: sen.proofofwork.difficulty },
          cfg,
        ).token;
      } catch (e) {
        out.failure = "pow-failed";
        out.totalMs = Math.round(performance.now() - t0);
        return out;
      }
    }
    const headers = { "content-type": "application/json", accept: "text/event-stream", authorization: auth.authorization };
    if (sen && sen.token) headers["openai-sentinel-chat-requirements-token"] = sen.token;
    if (proof) headers["openai-sentinel-proof-token"] = proof;
    const body = {
      action: "next",
      messages: [{ id: REQ.userMessageId, author: { role: "user" }, content: { content_type: "text", parts: [REQ.prompt] } }],
      parent_message_id: REQ.parentMessageId || "client-created-root",
      model: REQ.model,
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_rate_limit: false,
      suggestions: [],
      supported_encodings: ["v1"],
      system_hints: [],
      supports_buffering: true,
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: 42,
        page_height: window.innerHeight,
        page_width: window.innerWidth,
        pixel_ratio: window.devicePixelRatio || 1,
        screen_height: (window.screen && window.screen.height) || 1080,
        screen_width: (window.screen && window.screen.width) || 1920,
      },
    };
    if (REQ.conversationId) body.conversation_id = REQ.conversationId;
    const tSend = performance.now();
    const res = await fetch("/backend-api/conversation", {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify(body),
    });
    out.status = res.status;
    out.ttfbMs = Math.round(performance.now() - tSend);
    if (!res.ok) {
      try { out.errorBody = (await res.text()).slice(0, 600); } catch (e) {}
      out.failure = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate-limit" : "unknown";
      out.totalMs = Math.round(performance.now() - t0);
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.indexOf("data:") !== 0) continue;
          const p = line.slice(5).trim();
          if (p === "[DONE]") { out.sawDone = true; continue; }
          if (p.length > 0) out.frames.push(p);
        }
      }
      if (out.sawDone) break;
    }
    out.totalMs = Math.round(performance.now() - t0);
    return out;
  } catch (e) {
    out.failure = "network";
    out.errorBody = String(e && e.message ? e.message : e).slice(0, 300);
    out.totalMs = Math.round(performance.now() - t0);
    return out;
  }
})()