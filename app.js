// SnapNinja PWA
(function () {
  "use strict";

  const LS_URL    = "snapninja.endpoint";
  const LS_SECRET = "snapninja.secret";
  const LS_PENDING = "snapninja.pending";
  const LS_TAG = "snapninja.tag";

  const STALE_MS = 8 * 60 * 60 * 1000; // 8h — confirm before capture
  const CTX_REFRESH_MS = 15000;
  const AGENT_REFRESH_MS = 15000;
  const MACRO_STATUS_POLL_MS = 3000;
  const MACRO_STATUS_POLL_MAX_MS = 30000;
  const RESIZE_MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.8;

  const $ = id => document.getElementById(id);
  const main = $("mainScreen");
  const setup = $("setupScreen");
  const ctxEl = $("ctx");
  const captureBtn = $("captureBtn");
  const galleryBtn = $("galleryBtn");
  const fileInput = $("fileInput");
  const galleryInput = $("galleryInput");
  const tagRow = $("tagRow");
  const uploadsEl = $("uploads");
  const pendingEl = $("pending");
  const recentEl = $("recent");
  const recentListEl = $("recentList");
  const recentCountEl = $("recentCount");
  const tabPanels = Array.from(document.querySelectorAll(".tabPanel"));
  const tabButtons = Array.from(document.querySelectorAll(".tabBtn"));
  const actionsJobSummaryEl = $("actionsJobSummary");
  const tabletStatusEl = $("tabletStatus");
  const actionGridEl = $("actionGrid");
  const actionQueueStatusEl = $("actionQueueStatus");
  const partsSearchEl = $("partsSearch");
  const partsMsgEl = $("partsMsg");
  const partsResultsEl = $("partsResults");

  const RECENT_LIMIT = 8;
  const RECENT_REFRESH_MS = 30000;

  let uploadSeq = 0;
  const SUCCESS_FADE_MS = 60000; // success cards auto-dismiss after 1 min

  let currentTag = "serial";
  const validTags = new Set(Array.from(tagRow.querySelectorAll(".tagBtn")).map(b => b.dataset.tag));
  let activeContext = null;
  let confirmedStale = false; // user has tapped through staleness for current ctx
  let pendingActionConfirm = null;

  const FINAL_MACRO_STATUSES = { DONE: true, FAILED: true, CANCELLED: true };
  const ACTION_STATUS_LABELS = {
    PENDING: "Queued",
    CLAIMED: "Claimed by tablet",
    RUNNING: "Running on tablet",
    DONE: "Done",
    FAILED: "Failed",
    CANCELLED: "Cancelled"
  };

  // ---- Tabs ---------------------------------------------------------------

  function switchTab(tabId) {
    tabPanels.forEach(panel => panel.classList.toggle("active", panel.id === tabId));
    tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabId));
    if (tabId === "tabActions") refreshAgentStatus();
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

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
    refreshAgentStatus();
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
      if (newKey !== oldKey) { confirmedStale = false; recentListEl.innerHTML = ""; }
      activeContext = newCtx;
      renderContext(newCtx, null);
      if (newKey !== oldKey) refreshRecent();
    } catch (e) {
      renderContext(null, "Network error: " + e.message);
    }
  }

  function renderContext(ctx, errMsg) {
    ctxEl.classList.remove("warn", "error");
    if (errMsg) {
      ctxEl.classList.add("error");
      ctxEl.innerHTML = `<div class="ctxLine1">No connection</div><div class="ctxLine2">${escapeHtml(errMsg)}</div>`;
      updateActionTab();
      updateCaptureBtn();
      return;
    }
    if (!ctx) {
      ctxEl.classList.add("error");
      ctxEl.innerHTML = `<div class="ctxLine1">No active job</div><div class="ctxLine2">Open a job on the Surface (NetSuite Ninja) first.</div>`;
      updateActionTab();
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
    updateActionTab();
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

  function formatAgentAge(updatedAt) {
    if (!updatedAt) return "";
    const updatedMs = new Date(updatedAt).getTime();
    if (Number.isNaN(updatedMs)) return "";
    return formatAge(Math.max(0, Date.now() - updatedMs));
  }

  function isStale() {
    if (!activeContext) return false;
    return (Date.now() - new Date(activeContext.writtenAt).getTime()) > STALE_MS;
  }

  function updateCaptureBtn() {
    captureBtn.disabled = !activeContext;
    galleryBtn.disabled = !activeContext;
  }

  // ---- Recent photos for current job --------------------------------------

  recentEl.querySelector(".recentHead").addEventListener("click", () => {
    recentEl.classList.toggle("open");
  });

  async function refreshRecent() {
    if (!activeContext) { recentEl.classList.add("hidden"); return; }
    const { url, secret } = getConfig();
    if (!url || !secret) return;
    const qs = `action=photos&secret=${encodeURIComponent(secret)}` +
      `&caseNum=${encodeURIComponent(activeContext.caseNum)}` +
      `&taskNum=${encodeURIComponent(activeContext.taskNum)}`;
    try {
      const r = await fetch(`${url}?${qs}`);
      const data = await r.json();
      if (!data.ok || !Array.isArray(data.photos)) return;
      renderRecent(data.photos);
    } catch (e) {
      console.warn("[SnapNinja] recent fetch failed:", e);
    }
  }

  function renderRecent(photos) {
    const sorted = photos.slice().sort((a, b) =>
      String(b.timestamp || "").localeCompare(String(a.timestamp || ""))
    );
    const shown = sorted.slice(0, RECENT_LIMIT);
    recentEl.classList.remove("hidden");
    recentCountEl.textContent = sorted.length ? `${shown.length}/${sorted.length}` : "0";
    if (!shown.length) {
      recentListEl.innerHTML = `<div class="recentEmpty">No photos uploaded for this job yet.</div>`;
      return;
    }
    recentListEl.innerHTML = shown.map(p => {
      const ocr = (p.ocrResult || "").replace(/\s+/g, " ").trim();
      const ocrSnippet = ocr && ocr !== "NONE" ? ocr.slice(0, 80) : "";
      const href = p.driveUrl || "#";
      return `<a class="recentItem" href="${escapeHtml(href)}" target="_blank" rel="noopener">
        <span class="rTag">${escapeHtml(p.tag || "")}</span>
        <span class="rText">${escapeHtml(p.filename || "")}${ocrSnippet ? ` <span class="rOcr">— ${escapeHtml(ocrSnippet)}</span>` : ""}</span>
      </a>`;
    }).join("");
  }

  // ---- Tag selection ------------------------------------------------------

  function applyTagSelection(tag) {
    if (!validTags.has(tag)) return;
    currentTag = tag;
    Array.from(tagRow.children).forEach(b => b.classList.toggle("active", b.dataset.tag === tag));
  }

  function restoreTagSelection() {
    const savedTag = localStorage.getItem(LS_TAG);
    if (savedTag && validTags.has(savedTag)) {
      applyTagSelection(savedTag);
    }
  }

  tagRow.addEventListener("click", e => {
    const btn = e.target.closest(".tagBtn");
    if (!btn) return;
    applyTagSelection(btn.dataset.tag);
    localStorage.setItem(LS_TAG, currentTag);
  });

  // ---- Actions + Parts placeholders --------------------------------------

  function showTempMessage(el, msg) {
    if (!el) return;
    el.textContent = msg;
    clearTimeout(el._msgTimer);
    el._msgTimer = setTimeout(() => { el.textContent = ""; }, 2000);
  }

  function setActionQueueStatus(primary, tone, detail) {
    if (!actionQueueStatusEl) return;
    actionQueueStatusEl.className = "actionQueueStatus" + (tone ? ` ${tone}` : "");
    actionQueueStatusEl.innerHTML = `<div>${escapeHtml(primary)}</div>` +
      (detail ? `<div class="actionQueueStatusDetail">${escapeHtml(detail)}</div>` : "");
  }

  function hasActionConfig() {
    const { url, secret } = getConfig();
    return Boolean(url && secret);
  }

  function formatCaseLabel(caseNum) {
    const raw = String(caseNum || "").trim();
    if (!raw) return "CASE-?";
    return /^CASE[-\s]?/i.test(raw) ? raw.toUpperCase() : `CASE-${raw}`;
  }

  function updateActionButtons() {
    if (!actionGridEl) return;
    const disabled = !activeContext || !activeContext.caseNum || !activeContext.taskNum || !hasActionConfig();
    actionGridEl.querySelectorAll(".actionBtn").forEach(btn => {
      btn.disabled = disabled || btn.dataset.busy === "true";
    });
  }

  function buildActionJobSummary(ctx) {
    return `${formatCaseLabel(ctx.caseNum)} TASK ${ctx.taskNum}`;
  }

  function buildQueuePayload(command) {
    return {
      action: "queueMacro",
      secret: getConfig().secret,
      command: command,
      caseNum: activeContext.caseNum,
      taskNum: activeContext.taskNum,
      woNum: activeContext.woNum || "",
      site: activeContext.site || "",
      assetNum: activeContext.assetNum || "",
      contextWrittenAt: activeContext.writtenAt || "",
      requestedBy: "snapninja-pwa",
      source: "phone-pwa",
      payload: {
        queuedFromTab: "Actions",
        contextWrittenAt: activeContext.writtenAt || "",
        userAgent: navigator.userAgent || ""
      }
    };
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      const snippet = text.slice(0, 240).replace(/\s+/g, " ");
      throw new Error(`Bad JSON (status ${response.status}): ${snippet || "empty response"}`);
    }
  }

  function buildQueuedMessage(action) {
    return `Queued for ${formatCaseLabel(action.caseNum)} TASK ${action.taskNum}`;
  }

  function buildMacroStatusMessage(action) {
    const status = String(action.status || "").toUpperCase();
    const label = ACTION_STATUS_LABELS[status] || status || "Queued";
    return `${label} for ${formatCaseLabel(action.caseNum)} TASK ${action.taskNum}`;
  }

  function buildMacroStatusDetail(action) {
    const detail = [];
    if (action.label) detail.push(action.label);
    if (action.resultMessage) detail.push(action.resultMessage);
    if (action.lastError) detail.push(action.lastError);
    return detail.join(" · ");
  }

  function getActionStatusTone(action) {
    const status = String(action.status || "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED") return "error";
    if (status === "DONE") return "online";
    return "pending";
  }

  async function pollMacroStatus(actionId) {
    const { url, secret } = getConfig();
    if (!url || !secret || !actionId) return;
    const deadline = Date.now() + MACRO_STATUS_POLL_MAX_MS;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, MACRO_STATUS_POLL_MS));
      try {
        const response = await fetch(
          `${url}?action=macroStatus&secret=${encodeURIComponent(secret)}&actionId=${encodeURIComponent(actionId)}`
        );
        const data = await parseJsonResponse(response);
        if (!data || data.ok !== true || !Array.isArray(data.actions) || !data.actions.length) continue;

        const action = data.actions[0];
        setActionQueueStatus(
          buildMacroStatusMessage(action),
          getActionStatusTone(action),
          buildMacroStatusDetail(action)
        );
        if (FINAL_MACRO_STATUSES[String(action.status || "").toUpperCase()]) return;
      } catch (e) {
        return;
      }
    }
  }

  async function queueMacro(command) {
    const { url, secret } = getConfig();
    if (!url || !secret) {
      setActionQueueStatus("Action queue unavailable", "error", "Setup needed.");
      return null;
    }
    if (!activeContext || !activeContext.caseNum || !activeContext.taskNum) {
      setActionQueueStatus("No active job", "error", "Open a job on the Surface first.");
      return null;
    }
    if (isStale()) {
      const now = Date.now();
      if (!pendingActionConfirm || pendingActionConfirm.command !== command || pendingActionConfirm.expiresAt < now) {
        pendingActionConfirm = { command: command, expiresAt: now + 15000 };
        setActionQueueStatus(
          `Job context is stale for ${buildActionJobSummary(activeContext)}`,
          "warn",
          "Tap the same action again within 15s to queue it anyway."
        );
        return null;
      }
    }
    pendingActionConfirm = null;

    const requestBody = buildQueuePayload(command);
    setActionQueueStatus(
      `Queueing for ${buildActionJobSummary(activeContext)}`,
      "pending",
      command
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(requestBody),
        redirect: "follow"
      });
      const data = await parseJsonResponse(response);
      if (!data || data.ok !== true || !data.action) {
        setActionQueueStatus(
          "Action queue backend error",
          "error",
          data && data.error ? data.error : "Unknown backend error"
        );
        return null;
      }

      setActionQueueStatus(
        buildQueuedMessage(data.action),
        "pending",
        data.action.label || data.action.command || "Queued"
      );
      pollMacroStatus(data.action.actionId);
      return data.action;
    } catch (e) {
      setActionQueueStatus("Action queue network error", "error", e.message);
      return null;
    }
  }

  function setTabletStatus(primary, tone, detail) {
    if (!tabletStatusEl) return;
    tabletStatusEl.className = "agentStatus" + (tone ? ` ${tone}` : "");
    tabletStatusEl.innerHTML = `<div>${escapeHtml(primary)}</div>` +
      (detail ? `<div class="agentStatusDetail">${escapeHtml(detail)}</div>` : "");
  }

  function buildAgentScore(agent) {
    const isFresh = agent && agent.stale === false;
    const isPartsNinja = String(agent && agent.agentType || "").toLowerCase() === "partsninja-python";
    const updatedMs = new Date(agent && agent.updatedAt || 0).getTime();
    return [isFresh ? 1 : 0, isPartsNinja ? 1 : 0, Number.isNaN(updatedMs) ? 0 : updatedMs];
  }

  function compareAgentScore(left, right) {
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
  }

  function pickBestAgent(agents) {
    return agents
      .filter(agent => agent && typeof agent === "object")
      .slice()
      .sort((a, b) => compareAgentScore(buildAgentScore(a), buildAgentScore(b)))[0] || null;
  }

  function buildAgentSummary(agent) {
    const parts = ["Tablet online"];
    if (agent.caseNum) parts.push(`CASE-${agent.caseNum}`);
    if (agent.taskNum) parts.push(`TASK ${agent.taskNum}`);
    return parts.join(" · ");
  }

  async function refreshAgentStatus() {
    const { url, secret } = getConfig();
    if (!url || !secret) {
      setTabletStatus("Tablet status: setup needed", "error");
      return;
    }
    try {
      const response = await fetch(`${url}?action=agentStatus&secret=${encodeURIComponent(secret)}`);
      const data = await response.json();
      if (!data || data.ok !== true) {
        setTabletStatus("Tablet status: backend error", "error");
        return;
      }
      const agents = Array.isArray(data.agents) ? data.agents : [];
      if (!agents.length) {
        setTabletStatus("Tablet status: no tablet agent seen yet");
        return;
      }

      const agent = pickBestAgent(agents);
      if (!agent) {
        setTabletStatus("Tablet status: no tablet agent seen yet");
        return;
      }

      const age = formatAgentAge(agent.updatedAt);
      if (agent.stale === true) {
        setTabletStatus(
          "Tablet status: offline or stale",
          "stale",
          age ? `Last update ${age} ago` : ""
        );
        return;
      }

      if (String(agent.status || "").toLowerCase() === "online") {
        setTabletStatus(buildAgentSummary(agent), "online", agent.message || "");
        return;
      }

      const details = [];
      if (agent.message) details.push(agent.message);
      if (age) details.push(`Updated ${age} ago`);
      setTabletStatus(`Tablet status: ${agent.status || "seen"}`, "error", details.join(" · "));
    } catch (e) {
      setTabletStatus("Tablet status: cannot reach backend", "error");
    }
  }

  function updateActionTab() {
    if (!actionsJobSummaryEl || !actionGridEl) return;
    if (!hasActionConfig()) {
      actionsJobSummaryEl.textContent = "Setup needed to queue tablet actions.";
      updateActionButtons();
      if (actionQueueStatusEl && !actionQueueStatusEl.textContent.trim()) {
        setActionQueueStatus("Action queue unavailable", "error", "Add Apps Script URL and secret in setup.");
      }
      return;
    }
    if (!activeContext) {
      actionsJobSummaryEl.textContent = "No active job. Open a job on the Surface (NetSuite Ninja) first.";
      updateActionButtons();
      if (actionQueueStatusEl && !actionQueueStatusEl.textContent.trim()) {
        setActionQueueStatus("No active job", "error", "Open a job on the Surface first.");
      }
      return;
    }
    actionsJobSummaryEl.textContent =
      `CASE-${activeContext.caseNum} · TASK ${activeContext.taskNum}` +
      `${activeContext.site ? ` · ${activeContext.site}` : ""}` +
      `${activeContext.assetNum ? ` · ${activeContext.assetNum}` : ""}`;
    updateActionButtons();
    if (actionQueueStatusEl && !actionQueueStatusEl.textContent.trim()) {
      setActionQueueStatus(`Ready for ${buildActionJobSummary(activeContext)}`, "pending", "Tap an action to queue it for the tablet.");
    }
  }

  if (actionGridEl) {
    actionGridEl.addEventListener("click", async e => {
      const btn = e.target.closest(".actionBtn");
      if (!btn || btn.disabled) return;
      const command = btn.dataset.command;
      if (!command) return;
      btn.dataset.busy = "true";
      updateActionButtons();
      try {
        await queueMacro(command);
      } finally {
        delete btn.dataset.busy;
        updateActionButtons();
      }
    });
  }

  if (partsSearchEl) {
    const updatePartsPlaceholder = () => {
      const q = (partsSearchEl.value || "").trim();
      if (!q) {
        partsResultsEl.textContent = "Parts lookup not wired yet";
      } else {
        partsResultsEl.textContent = `No local parts results for \"${q}\" yet.`;
      }
    };
    partsSearchEl.addEventListener("input", updatePartsPlaceholder);
    partsSearchEl.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        showTempMessage(partsMsgEl, "Parts lookup not wired yet");
      }
    });
    updatePartsPlaceholder();
  }

  // ---- Capture ------------------------------------------------------------

  function triggerPicker(input) {
    if (!activeContext) return;
    if (isStale() && !confirmedStale) {
      showStaleConfirm(input);
      return;
    }
    input.value = "";
    input.click();
  }

  captureBtn.addEventListener("click", () => triggerPicker(fileInput));
  galleryBtn.addEventListener("click", () => triggerPicker(galleryInput));

  async function onFilesChosen(input) {
    const files = input.files ? [...input.files] : [];
    for (const f of files) await handlePhoto(f);
  }
  fileInput.addEventListener("change", () => onFilesChosen(fileInput));
  galleryInput.addEventListener("change", () => onFilesChosen(galleryInput));

  function showStaleConfirm(input) {
    const wrap = document.createElement("div");
    wrap.className = "confirmRow";
    wrap.innerHTML = `
      <button class="cancel" data-act="cancel">Cancel</button>
      <button data-act="ok">Use this job anyway</button>
    `;
    wrap.addEventListener("click", e => {
      const act = e.target.dataset.act;
      if (act === "ok") { confirmedStale = true; wrap.remove(); input.value=""; input.click(); }
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
      const { base64, mimeType, sizeKB, thumbDataUrl } = await resizeToBase64(file);
      setCardThumb(card, thumbDataUrl);
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
      refreshRecent();
    } catch (e) {
      setCardError(card, "Error: " + e.message);
    }
  }

  async function uploadPhoto(base64, mimeType, tag, onPhase) {
    const { url, secret } = getConfig();
    const body = JSON.stringify({
      action: "photo", secret: secret, tag: tag,
      photoBase64: base64, mimeType: mimeType
    });
    if (onPhase) onPhase("Uploading…");
    // After ~3s switch to "Processing on server…" since Gemini call dominates
    let serverTimer = setTimeout(() => { if (onPhase) onPhase("Processing on server…"); }, 3000);
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: body,
        redirect: "follow"
      });
    } catch (e) {
      clearTimeout(serverTimer);
      console.error("[SnapNinja] fetch threw:", e);
      const detail = `${e.name || "Error"}: ${e.message || String(e)} | url=${url.slice(0,60)}… | bodyKB=${Math.round(body.length/1024)}`;
      throw new Error(detail);
    }
    clearTimeout(serverTimer);
    let text;
    try {
      text = await r.text();
    } catch (e) {
      console.error("[SnapNinja] body read threw:", e);
      throw new Error(`Body read fail: ${e.message} | status=${r.status} | final=${r.url}`);
    }
    console.log("[SnapNinja] response status", r.status, "len", text.length, "final", r.url);
    try {
      return JSON.parse(text);
    } catch (e) {
      const snippet = text.slice(0, 300).replace(/\s+/g, " ");
      throw new Error(`Bad JSON (status ${r.status}, ${text.length}B): ${snippet}`);
    }
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
      <div class="upRow">
        <img class="upThumb" alt="" hidden>
        <div class="upBody"></div>
      </div>
    `;
    el.querySelector(".upDismiss").onclick = () => el.remove();
    uploadsEl.insertBefore(el, uploadsEl.firstChild);
    return el;
  }

  function setCardStatus(card, text) {
    const t = card.querySelector(".upStatusText");
    if (t) t.textContent = text;
  }

  function setCardThumb(card, dataUrl) {
    const img = card.querySelector(".upThumb");
    if (img && dataUrl) { img.src = dataUrl; img.hidden = false; }
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

  async function decodeWithOrientation(file) {
    // Prefer createImageBitmap with EXIF orientation applied, so portrait-mode
    // phone photos and gallery screenshots don't end up rotated on the canvas.
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (e) {
        console.warn("[SnapNinja] createImageBitmap failed, falling back:", e);
      }
    }
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = () => reject(new Error("read fail"));
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode fail"));
      reader.readAsDataURL(file);
    });
  }

  async function resizeToBase64(file) {
    const source = await decodeWithOrientation(file);
    const width = source.width;
    const height = source.height;
    const longest = Math.max(width, height);
    const scale = longest > RESIZE_MAX_EDGE ? RESIZE_MAX_EDGE / longest : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.split(",")[1];
    const sizeKB = Math.round(base64.length * 3 / 4 / 1024);
    // Small thumbnail for the upload card (~128px longest edge)
    const tScale = 128 / Math.max(w, h);
    const tw = Math.max(1, Math.round(w * tScale));
    const th = Math.max(1, Math.round(h * tScale));
    const tCanvas = document.createElement("canvas");
    tCanvas.width = tw; tCanvas.height = th;
    tCanvas.getContext("2d").drawImage(canvas, 0, 0, tw, th);
    const thumbDataUrl = tCanvas.toDataURL("image/jpeg", 0.6);
    if (source.close) source.close(); // release ImageBitmap
    return { base64, mimeType: "image/jpeg", sizeKB, thumbDataUrl };
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
    restoreTagSelection();
    updateActionTab();
    refreshAgentStatus();
    setInterval(refreshAgentStatus, AGENT_REFRESH_MS);
    showSetup();
  } else {
    restoreTagSelection();
    refreshContext();
    refreshAgentStatus();
    setInterval(refreshContext, CTX_REFRESH_MS);
    setInterval(refreshAgentStatus, AGENT_REFRESH_MS);
    setInterval(refreshRecent, RECENT_REFRESH_MS);
    // Re-render age every 10s without re-fetching
    setInterval(() => { if (activeContext) renderContext(activeContext, null); }, 10000);
    renderPending();
  }
})();
