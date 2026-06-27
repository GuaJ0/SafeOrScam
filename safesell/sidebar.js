// SafeSell — sidebar UI logic (runs inside the injected iframe).

const panel = document.getElementById("panel");
const collapseBtn = document.getElementById("collapse-btn");
const reopenTab = document.getElementById("reopen-tab");
const retryBtn = document.getElementById("retry-btn");

const COLORS = {
  SAFE: "#22c55e",
  CAUTION: "#f59e0b",
  SCAM: "#ef4444",
  UNAVAILABLE: "#6b7280",
};

let collapsed = false;

// --- Communicate with the content script (parent window) ---
function postToParent(payload) {
  window.parent.postMessage({ source: "safesell-sidebar", ...payload }, "*");
}

function setExpandedWidth() {
  postToParent({ type: "RESIZE", width: 340, full: true });
}
function setCollapsedWidth() {
  postToParent({ type: "RESIZE", width: 56, full: false });
}

// --- State setters ---
function setState(name) {
  panel.className = `panel state-${name}`;
}

function setAccent(color) {
  panel.style.setProperty("--accent", color);
}

function showLoading() {
  setAccent("#3b82f6");
  setState("loading");
}

function showError() {
  setAccent(COLORS.UNAVAILABLE);
  setState("error");
}

function badgeFromScore(score) {
  if (score >= 70) return { label: "LIKELY SCAM", emoji: "🔴", color: COLORS.SCAM };
  if (score >= 40) return { label: "CAUTION", emoji: "🟡", color: COLORS.CAUTION };
  return { label: "LIKELY SAFE", emoji: "🟢", color: COLORS.SAFE };
}

function applyRisk(elId, level) {
  const el = document.getElementById(elId);
  const value = (level || "unknown").toLowerCase();
  el.textContent = value;
  el.className = "";
  if (["low", "medium", "high"].includes(value)) el.classList.add(`risk-${value}`);
}

function showVerdict(result) {
  // Prefer the model score; fall back to a verdict-string mapping.
  let score = Number.isFinite(result.score)
    ? Math.max(0, Math.min(100, Math.round(result.score)))
    : result.verdict === "SCAM"
    ? 85
    : result.verdict === "SAFE"
    ? 15
    : 50;

  const badge = badgeFromScore(score);
  setAccent(badge.color);

  document.getElementById("verdict-emoji").textContent = badge.emoji;
  document.getElementById("verdict-label").textContent = badge.label;
  document.getElementById("verdict-score").textContent = `${score}/100`;

  // Scam type tag
  const scamTypeEl = document.getElementById("scam-type");
  if (result.scamType && result.scamType !== "none") {
    const label = result.scamType.charAt(0).toUpperCase() + result.scamType.slice(1);
    scamTypeEl.textContent = label;
    scamTypeEl.hidden = false;
  } else {
    scamTypeEl.hidden = true;
  }

  // Reasons
  const reasonsEl = document.getElementById("reasons");
  reasonsEl.innerHTML = "";
  const reasons = Array.isArray(result.reasons) && result.reasons.length
    ? result.reasons
    : ["No specific risk factors were identified."];
  reasons.slice(0, 3).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    reasonsEl.appendChild(li);
  });

  applyRisk("seller-risk", result.sellerRisk);
  applyRisk("image-risk", result.imageRisk);

  // Degraded-mode note if some checks were unavailable.
  const note = document.getElementById("degraded-note");
  const missing = [];
  if (result.exaAvailable === false) missing.push("web search");
  if (result.imageAvailable === false) missing.push("reverse image search");
  if (result.aiAvailable === false) missing.push("AI analysis");
  if (missing.length) {
    note.textContent = `Partial result — ${missing.join(", ")} unavailable.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  setState("verdict");
}

function handleResult(result) {
  if (!result || result.verdict === "UNAVAILABLE") {
    showError();
    return;
  }
  showVerdict(result);
}

// --- Collapse / expand ---
function collapse() {
  collapsed = true;
  panel.style.display = "none";
  reopenTab.hidden = false;
  setCollapsedWidth();
}
function expand() {
  collapsed = false;
  panel.style.display = "flex";
  reopenTab.hidden = true;
  setExpandedWidth();
}

collapseBtn.addEventListener("click", collapse);
reopenTab.addEventListener("click", expand);
retryBtn.addEventListener("click", () => {
  showLoading();
  postToParent({ type: "REANALYZE" });
});

// --- Messages from the content script ---
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "safesell") return;

  if (msg.type === "LOADING") {
    if (collapsed) expand();
    showLoading();
  } else if (msg.type === "RESULT") {
    handleResult(msg.result);
  }
});

// Initial state.
showLoading();
setExpandedWidth();
