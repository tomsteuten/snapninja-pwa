// SnapNinja PWA
(function () {
  "use strict";

  const LS_URL    = "snapninja.endpoint";
  const LS_SECRET = "snapninja.secret";
  const LS_PENDING = "snapninja.pending";

  const STALE_MS = 8 * 60 * 60 * 1000; // 8h — confirm before capture
  const CTX_REFRESH_MS = 15000;
  const RESIZE_MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.8;

  const $ = id => document.getElementById(id);
  const main = $("mainScreen");
  const setup = $("setupScreen");
  const ctxEl = $("ctx");
  const captureBtn = $("captureBtn");
  const fileInput = $("fileInput");
  const tagRow = $("tagRow");
  const uploadsEl = $("uploads");
  const pendingEl = $("pending");

  let uploadSeq = 0;
  const SUCCESS_FADE_MS = 60000; // success cards auto-dismiss after 1 min

  let currentTag = "serial";
  let activeContext = null;
  let confirmedStale = false; // user has tapped through staleness for current ctx

  // ---- Setup screen -------------------------------------------------------

  function showSetup() {
    main.classList.add("hidden");
    setup.classList.add("show");
    $("cfgUrl").value = localStorage.getItem(LS_URL) || "";
    $("cfgSecret").value = localStorage.getItem(LS_SECRET) || "";
  }
  function hideSetup() {
    setup.classList.remove("show");
    main.classList.remove("hidden");
    refreshContext();
  }
  $("setupLink").addEventListener("click", e => { e.preventDefault(); showSetup(); });
  $("cfgCancel").addEventListener("click", hideSetup);
  $("cfgSave").addEventListener("click", () => {
    const url = $("cfgUrl").value.trim();
    const secret = $("cfgSecret").value.trim();
    if (!url || !secret) { alert("Both fields required"); return; }
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_SECRET, secret);
    hideSetup();
  });

  function getConfig() {
    return {
      url: localStorage.getItem(LS_URL) || "",
      secret: localStorage.getItem(LS_SECRET) || ""
    };
  }

  // ---- Context fetch ------------------------------------------------------

  async function refreshContext() {
    const { url, secret } = getConfig();
    if (!url || !secret) {
      renderContext(null, "Tap ⚙️ to set the Apps Script URL and secret.");
      return;
    }
    try {
      const r = await fetch(`${url}?action=context&secret=${encodeURIComponent(secret)}`);
      const data = await r.json();
      if (!data.ok) { renderContext(null, "Backend error: " + (data.error || "unknown")); return; }
      const newCtx = data.context;
      const newKey = newCtx ? `${newCtx.caseNum}::${newCtx.taskNum}` : "";
      const oldKey = activeContext ? `${activeContext.caseNum}::${activeContext.taskNum}` : "";
      if (newKey !== oldKey) confirmedStale = false;
      activeContext = newCtx;
      renderContext(newCtx, null);
    } catch (e) {
      renderContext(null, "Network error: " + e.message);
    }
  }

  function renderContext(ctx, errMsg) {
    ctxEl.classList.remove("warn", "error");
    if (errMsg) {
      ctxEl.classList.add("error");
      ctxEl.innerHTML = `<div class="ctxLine1">No connection</div><div class="ctxLine2">${escapeHtml(errMsg)}</div>`;
      updateCaptureBtn();
      return;
    }
    if (!ctx) {
      ctxEl.classList.add("error");
      ctxEl.innerHTML = `<div class="ctxLine1">No active job</div><div class="ctxLine2">Open a job on the Surface (NetSuite Ninja) first.</div>`;
      updateCaptureBtn();
      return;
    }
    const ageMs = Date.now() - new Date(ctx.writtenAt).getTime();
    const ageStr = formatAge(ageMs);
    const stale = ageMs > STALE_MS;
    if (stale) ctxEl.classList.add("warn");
    ctxEl.innerHTML = `
      <div class="ctxLine1">CASE-${escapeHtml(ctx.caseNum)} · TASK ${escapeHtml(ctx.taskNum)}</div>
      <div class="ctxLine2">${escapeHtml(ctx.site || "(no site)")}${ctx.assetNum ? " · " + escapeHtml(ctx.assetNum) : ""}</div>
      <div class="ctxAge ${stale ? "stale" : ""}">set ${ageStr} ago${stale ? " — confirm before capture" : ""}</div>
    `;
    updateCaptureBtn();
  }

  function formatAge(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h " + (m % 60) + "m";
    return Math.floor(h / 24) + "d";
  }

  function isStale() {
    if (!activeContext) return false;
    return (Date.now() - new Date(activeContext.writtenAt).getTime()) > STALE_MS;
  }

  function updateCaptureBtn() {
    captureBtn.disabled = !activeContext;
  }

  // ---- Tag selection ------------------------------------------------------

  tagRow.addEventListener("click", e => {
    const btn = e.target.closest(".tagBtn");
    if (!btn) return;
    [...tagRow.children].forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTag = btn.dataset.tag;
  });

  // ---- Capture ------------------------------------------------------------

  captureBtn.addEventListener("click", () => {
    if (!activeContext) return;
    if (isStale() && !confirmedStale) {
      showStaleConfirm();
      return;
    }
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    await handlePhoto(file);
  });

  function showStaleConfirm() {
    const wrap = document.createElement("div");
    wrap.className = "confirmRow";
    wrap.innerHTML = `
      <button class="cancel" data-act="cancel">Cancel</button>
      <button data-act="ok">Use this job anyway</button>
    `;
    wrap.addEventListener("click", e => {
      const act = e.target.dataset.act;
      if (act === "ok") { confirmedStale = true; wrap.remove(); fileInput.value=""; fileInput.click(); }
      if (act === "cancel") wrap.remove();
    });
    ctxEl.appendChild(wrap);
  }

  // ---- Resize + upload ---------------------------------------------------

  async function handlePhoto(file) {
    const card = createCard(currentTag);
    const tagAtCapture = currentTag;
    try {
      setCardStatus(card, "Resizing…");
      const { base64, mimeType, sizeKB } = await resizeToBase64(file);
      setCardStatus(card, `Uploading ${sizeKB} KB…`);
      const resp = await uploadPhoto(base64, mimeType, tagAtCapture, (phase) => {
        setCardStatus(card, phase);
      });
      if (!resp.ok) {
        setCardError(card, "Failed: " + (resp.error || "unknown"));
        savePending(base64, mimeType, tagAtCapture);
        return;
      }
      clearPending();
      const ocrLine = resp.ocrResult
        ? resp.ocrResult
        : (resp.ocrError ? "(OCR failed: " + resp.ocrError + ")" : "(no OCR for this tag)");
      setCardSuccess(card, resp.filename, ocrLine);
      refreshContext();
    } catch (e) {
      setCardError(card, "Error: " + e.message);
    }
  }

  function uploadPhoto(base64, mimeType, tag, onPhase) {
    const { url, secret } = getConfig();
    const body = JSON.stringify({
      action: "photo", secret: secret, tag: tag,
      photoBase64: base64, mimeType: mimeType
    });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const pct = Math.round(e.loaded / e.total * 100);
        if (onPhase) onPhase(pct < 100 ? `Uploading ${pct}%…` : "Processing on server…");
      };
      xhr.upload.onload = () => { if (onPhase) onPhase("Processing on server…"); };
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error("bad response")); }
      };
      xhr.onerror = () => reject(new Error("network"));
      xhr.ontimeout = () => reject(new Error("timeout"));
      xhr.send(body);
    });
  }

  // ---- Upload cards ------------------------------------------------------

  function createCard(tag) {
    const id = ++uploadSeq;
    const el = document.createElement("div");
    el.className = "upCard";
    el.dataset.id = id;
    el.innerHTML = `
      <div class="upHead">
        <span class="upTag">${escapeHtml(tag)}</span>
        <span class="upStatus"><span class="spin"></span><span class="upStatusText">Starting…</span></span>
        <button class="upDismiss" aria-label="Dismiss">×</button>
      </div>
      <div class="upBody"></div>
    `;
    el.querySelector(".upDismiss").onclick = () => el.remove();
    uploadsEl.insertBefore(el, uploadsEl.firstChild);
    return el;
  }

  function setCardStatus(card, text) {
    const t = card.querySelector(".upStatusText");
    if (t) t.textContent = text;
  }

  function setCardSuccess(card, filename, ocrText) {
    card.classList.add("success");
    card.querySelector(".upStatus").innerHTML = `<span style="color:var(--accent);">✓ ${escapeHtml(filename)}</span>`;
    card.querySelector(".upBody").textContent = ocrText;
    setTimeout(() => {
      card.classList.add("fading");
      setTimeout(() => card.remove(), 600);
    }, SUCCESS_FADE_MS);
  }

  function setCardError(card, msg) {
    card.classList.add("error");
    card.querySelector(".upStatus").innerHTML = `<span style="color:var(--error);">✗</span>`;
    card.querySelector(".upBody").textContent = msg;
  }

  function resizeToBase64(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = () => reject(new Error("read fail"));
      img.onload = () => {
        const { width, height } = img;
        const longest = Math.max(width, height);
        const scale = longest > RESIZE_MAX_EDGE ? RESIZE_MAX_EDGE / longest : 1;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        const base64 = dataUrl.split(",")[1];
        const sizeKB = Math.round(base64.length * 3 / 4 / 1024);
        resolve({ base64, mimeType: "image/jpeg", sizeKB });
      };
      img.onerror = () => reject(new Error("decode fail"));
      reader.readAsDataURL(file);
    });
  }

  function showResult(headline, body, success) {
    resultEl.classList.remove("hidden", "success", "error");
    if (headline === null) {
      resultEl.classList.add("error");
      resultEl.innerHTML = `<h3>Failed</h3><div class="ocr">${escapeHtml(body)}</div>`;
    } else {
      if (success) resultEl.classList.add("success");
      resultEl.innerHTML = `<h3>${escapeHtml(headline)}</h3>` +
        (body ? `<div class="ocr">${escapeHtml(body)}</div>` : "");
    }
  }

  // ---- Pending (single-photo retry) ---------------------------------------

  function savePending(base64, mimeType, tag) {
    try {
      localStorage.setItem(LS_PENDING, JSON.stringify({ base64, mimeType, tag, at: Date.now() }));
    } catch (e) { /* quota — pending will be in-memory only this session */ }
    renderPending();
  }
  function clearPending() {
    localStorage.removeItem(LS_PENDING);
    renderPending();
  }
  function renderPending() {
    const raw = localStorage.getItem(LS_PENDING);
    if (!raw) { pendingEl.classList.add("hidden"); pendingEl.innerHTML = ""; return; }
    let p; try { p = JSON.parse(raw); } catch (e) { clearPending(); return; }
    pendingEl.classList.remove("hidden");
    pendingEl.className = "pendingBanner";
    pendingEl.innerHTML = `<span>1 photo pending (${p.tag})</span>
      <span><button data-act="retry">Retry</button>
      <button data-act="discard" style="margin-left:6px;">×</button></span>`;
    pendingEl.querySelector('[data-act=retry]').onclick = async () => {
      const saved = currentTag; currentTag = p.tag;
      pendingEl.classList.add("hidden");
      const card = createCard(p.tag);
      setCardStatus(card, "Retrying…");
      try {
        const resp = await uploadPhoto(p.base64, p.mimeType, p.tag, s => setCardStatus(card, s));
        currentTag = saved;
        if (resp.ok) {
          clearPending();
          const ocrLine = resp.ocrResult || resp.ocrError || "(no OCR)";
          setCardSuccess(card, resp.filename, ocrLine);
        } else {
          renderPending();
          setCardError(card, "Retry failed: " + (resp.error || "unknown"));
        }
      } catch (e) {
        currentTag = saved;
        renderPending();
        setCardError(card, "Retry error: " + e.message);
      }
    };
    pendingEl.querySelector('[data-act=discard]').onclick = clearPending;
  }

  // ---- Misc --------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    })[c]);
  }

  // ---- Boot --------------------------------------------------------------

  if (!getConfig().url) {
    showSetup();
  } else {
    refreshContext();
    setInterval(refreshContext, CTX_REFRESH_MS);
    // Re-render age every 10s without re-fetching
    setInterval(() => { if (activeContext) renderContext(activeContext, null); }, 10000);
    renderPending();
  }
})();
