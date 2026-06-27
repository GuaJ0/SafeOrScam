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

// Inline Tabler outline icons (the extension runs offline under a strict CSP,
// so icons are bundled as SVG markup rather than loaded from a webfont/CDN).
const ICONS = {
  user:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" /><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /></svg>',
  coin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" /><path d="M14.8 9a2 2 0 0 0 -1.8 -1h-2a2 2 0 1 0 0 4h2a2 2 0 1 1 0 4h-2a2 2 0 0 1 -1.8 -1" /><path d="M12 6v2m0 8v2" /></svg>',
  fileText:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M9 9l1 0" /><path d="M9 13l6 0" /><path d="M9 17l6 0" /></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2" /><path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" /></svg>',
};

// Total length of the semicircular gauge arc (radius 80 → π·80 ≈ 251).
const ARC_LENGTH = 251;

let collapsed = false;
let lastResult = null; // most recent verdict

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

// Apply the verdict tone (accent + tinted background + border) to the panel.
function setTheme(theme) {
  panel.style.setProperty("--accent", theme.color);
  panel.style.setProperty("--tone-bg", theme.bg);
  panel.style.setProperty("--tone-border", theme.border);
}

function showLoading() {
  setAccent("#3b82f6");
  setState("loading");
}

function showError() {
  setAccent(COLORS.UNAVAILABLE);
  setState("error");
}

// Visual tone (color + tinted surfaces) derived from the score thresholds.
function themeFromScore(score) {
  if (score >= 65)
    return { label: "LIKELY SAFE", color: "#16a34a", bg: "#f0fdf4", border: "#86efac" };
  if (score >= 40)
    return { label: "CAUTION", color: "#d97706", bg: "#fffbeb", border: "#fcd34d" };
  return { label: "LIKELY SCAM", color: "#dc2626", bg: "#fef2f2", border: "#fca5a5" };
}

// Map a free-text concern to an icon + tone (purely presentational).
function concernVisual(text) {
  const t = String(text).toLowerCase();
  if (/review|rating|feedback|history|account|joined|member/.test(t))
    return { icon: ICONS.user, tone: "warn" };
  if (/price|cheap|below market|low for|deal|discount|underpriced|s\$|\$|cost/.test(t))
    return { icon: ICONS.coin, tone: "warn" };
  if (/desc|vague|detail|missing info|qualif|generic|unclear/.test(t))
    return { icon: ICONS.fileText, tone: "neutral" };
  if (/image|photo|picture|\bpic\b|stock|uploaded/.test(t))
    return { icon: ICONS.camera, tone: "neutral" };
  return { icon: ICONS.info, tone: "neutral" };
}

// Map a risk level to a bar width, color and label.
function riskMeta(level) {
  const v = (level || "unknown").toLowerCase();
  if (v === "low") return { pct: 20, color: "var(--text-success)", label: "Low" };
  if (v === "medium") return { pct: 55, color: "var(--text-warning)", label: "Medium" };
  if (v === "high") return { pct: 90, color: "var(--text-danger)", label: "High" };
  return { pct: 8, color: "var(--text-muted)", label: "Unknown" };
}

function applyRiskBar(barId, valueId, level, delaySec) {
  const bar = document.getElementById(barId);
  const value = document.getElementById(valueId);
  const meta = riskMeta(level);
  value.textContent = meta.label;
  value.style.color = meta.color;
  bar.style.background = meta.color;
  bar.style.width = "0%";
  bar.style.transition = `width 1s ease ${delaySec}s`;
  // Defer to next frame so the transition runs from 0 → target.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.width = `${meta.pct}%`;
    });
  });
}

function renderConcerns(reasons) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  const items =
    Array.isArray(reasons) && reasons.length
      ? reasons
      : ["No specific risk factors were identified."];
  items.slice(0, 5).forEach((reason) => {
    const { icon, tone } = concernVisual(reason);
    const card = document.createElement("div");
    card.className = "concern-card";

    const iconWrap = document.createElement("div");
    iconWrap.className = `concern-icon tone-${tone}`;
    iconWrap.innerHTML = icon;

    const body = document.createElement("div");
    body.className = "concern-body";
    const title = document.createElement("p");
    title.className = "concern-title";
    title.textContent = reason;
    body.appendChild(title);

    const dot = document.createElement("div");
    dot.className = `concern-dot tone-${tone}`;

    card.appendChild(iconWrap);
    card.appendChild(body);
    card.appendChild(dot);
    list.appendChild(card);
  });
}

function animateGauge(score) {
  const arc = document.getElementById("score-arc");
  if (!arc) return;
  const target = ARC_LENGTH * (1 - score / 100);
  // Reset, then animate on the next frame so the stroke fills in on render.
  arc.style.strokeDashoffset = String(ARC_LENGTH);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      arc.style.strokeDashoffset = String(target);
    });
  });
}

function showVerdict(result) {
  // Prefer the model score; fall back to a verdict-string mapping.
  let score = Number.isFinite(result.score)
    ? Math.max(0, Math.min(100, Math.round(result.score)))
    : result.verdict === "SCAM"
    ? 15
    : result.verdict === "SAFE"
    ? 85
    : 50;

  const theme = themeFromScore(score);
  setTheme(theme);

  document.getElementById("score-num").textContent = String(score);
  document.getElementById("verdict-label").textContent = theme.label;

  // Scam type tag
  const scamTypeEl = document.getElementById("scam-type");
  if (result.scamType && result.scamType !== "none") {
    const label = result.scamType.charAt(0).toUpperCase() + result.scamType.slice(1);
    scamTypeEl.textContent = label;
    scamTypeEl.hidden = false;
  } else {
    scamTypeEl.hidden = true;
  }

  // Concerns
  renderConcerns(result.reasons);

  // Alternatives
  const altSection = document.getElementById("alternatives-section");
  const altList = document.getElementById("alternatives-list");
  const alts = Array.isArray(result.alternatives) ? result.alternatives : [];
  if (alts.length > 0) {
    altList.innerHTML = "";
    alts.forEach((alt) => {
      const li = document.createElement("li");
      li.className = "alt-item";

      li.innerHTML = `
        <a class="alt-card" href="${alt.url}" target="_blank" rel="noopener noreferrer">
          <div class="alt-img-wrap">
            ${alt.image
              ? `<img class="alt-img" src="${alt.image}" alt="" loading="lazy" onerror="this.parentElement.classList.add('alt-img-fallback')">`
              : `<div class="alt-img-placeholder"></div>`
            }
          </div>
          <div class="alt-info">
            <span class="alt-title">${alt.title}</span>
            <span class="alt-price">${alt.price || "View listing"}</span>
          </div>
          <svg class="alt-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </a>
      `;

      altList.appendChild(li);
    });
    altSection.hidden = false;
  } else {
    altSection.hidden = true;
  }

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

  // Reveal the verdict view first so transitions can run, then animate.
  setState("verdict");
  animateGauge(score);
  applyRiskBar("seller-bar", "seller-risk", result.sellerRisk, 0.3);
  applyRiskBar("image-bar", "image-risk", result.imageRisk, 0.5);
}

function handleResult(result) {
  lastResult = result;
  if (!result || result.verdict === "UNAVAILABLE") {
    showError();
    return;
  }
  showVerdict(result);
}

// ---- Seller report (opens in a new tab) ----
const reportBtn = document.getElementById("report-btn");

reportBtn.addEventListener("click", () => {
  console.debug("[SafeSell] report button clicked → posting OPEN_SELLER_REPORT");
  reportBtn.querySelector("span").textContent = "Opening report…";
  setTimeout(() => {
    reportBtn.querySelector("span").textContent = "View full seller report";
  }, 2500);
  // Pass the current verdict so the report's trust level stays consistent.
  postToParent({ type: "OPEN_SELLER_REPORT", verdict: lastResult });
});

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

// ---------------------------------------------------------------------------
// Community voting
// ---------------------------------------------------------------------------
let currentListingUrl = null;
let selectedVerdict = null;

const communitySection = document.getElementById("community-section");
const communityCounts = document.getElementById("community-counts");
const communityComments = document.getElementById("community-comments");
const voteArea = document.getElementById("vote-area");
const authPrompt = document.getElementById("auth-prompt");
const voteSafeBtn = document.getElementById("vote-safe-btn");
const voteScamBtn = document.getElementById("vote-scam-btn");
const commentArea = document.getElementById("comment-area");
const voteCommentEl = document.getElementById("vote-comment");
const submitVoteBtn = document.getElementById("submit-vote-btn");
const voteStatus = document.getElementById("vote-status");
const signInSidebarBtn = document.getElementById("sign-in-sidebar-btn");

function setVoteStatus(msg, isError = false) {
  voteStatus.textContent = msg;
  voteStatus.className = "vote-status" + (isError ? " vote-status-error" : " vote-status-ok");
  voteStatus.hidden = false;
}

function selectVerdict(verdict) {
  selectedVerdict = verdict;
  voteSafeBtn.classList.toggle("active", verdict === "safe");
  voteScamBtn.classList.toggle("active", verdict === "scam");
  commentArea.hidden = false;
}

voteSafeBtn.addEventListener("click", () => selectVerdict("safe"));
voteScamBtn.addEventListener("click", () => selectVerdict("scam"));

submitVoteBtn.addEventListener("click", async () => {
  if (!selectedVerdict || !currentListingUrl) return;
  submitVoteBtn.disabled = true;
  submitVoteBtn.textContent = "Submitting…";

  postToParent({
    type: "SUBMIT_VOTE",
    listingUrl: currentListingUrl,
    verdict: selectedVerdict,
    comment: voteCommentEl.value.trim(),
  });
});

signInSidebarBtn.addEventListener("click", () => {
  postToParent({ type: "SIGN_IN_GOOGLE" });
});

function renderCommunity({ safeCount, scamCount, safePercent, total, comments, myVote, user }) {
  // Percentage summary
  const countsEl = document.getElementById("community-counts");
  const percentEl = document.getElementById("safe-percent");
  const totalEl = document.getElementById("vote-total");
  if (total > 0) {
    percentEl.textContent = `${safePercent}% said safe`;
    percentEl.className = "safe-percent " + (safePercent >= 60 ? "pct-safe" : safePercent >= 40 ? "pct-caution" : "pct-scam");
    totalEl.textContent = `${total} ${total === 1 ? "review" : "reviews"}`;
    countsEl.hidden = false;
  } else {
    countsEl.hidden = true;
  }

  // Comments — Google review style
  communityComments.innerHTML = "";
  if (comments && comments.length > 0) {
    comments.forEach(({ comment, verdict, displayName, avatarUrl }) => {
      const initials = (displayName || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
      const color = verdict === "safe" ? "#16a34a" : "#dc2626";
      const div = document.createElement("div");
      div.className = "community-comment";
      div.innerHTML = `
        <div class="review-avatar">
          ${avatarUrl
            ? `<img src="${avatarUrl}" alt="${initials}" onerror="this.parentElement.innerHTML='<span class=review-initials>${initials}</span>'">`
            : `<span class="review-initials">${initials}</span>`
          }
        </div>
        <div class="review-body">
          <div class="review-header">
            <span class="review-name">${displayName || "Anonymous"}</span>
            <span class="review-verdict" style="color:${color}">${verdict === "safe" ? "✓ Safe" : "⚑ Scam"}</span>
          </div>
          <p class="review-text">${comment}</p>
        </div>
      `;
      communityComments.appendChild(div);
    });
    communityComments.hidden = false;
  } else {
    communityComments.hidden = true;
  }

  if (!user) {
    voteArea.hidden = true;
    authPrompt.hidden = false;
    return;
  }

  authPrompt.hidden = true;
  voteArea.hidden = false;

  // If user already voted, show their existing vote selected
  if (myVote) {
    selectVerdict(myVote);
    setVoteStatus("You voted · change your vote below");
  }
}

function loadCommunityData(listingUrl) {
  if (!listingUrl) return;
  postToParent({ type: "GET_VOTES", listingUrl });
}

// Handle vote result from content script
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "safesell") return;

  if (msg.type === "VOTE_RESULT") {
    submitVoteBtn.disabled = false;
    submitVoteBtn.textContent = "Submit";
    if (msg.ok) {
      setVoteStatus("Thanks for your report!");
      loadCommunityData(currentListingUrl);
    } else {
      setVoteStatus(msg.error || "Failed to submit. Try again.", true);
    }
  }

  if (msg.type === "VOTES_DATA") {
    renderCommunity(msg);
  }

  if (msg.type === "LISTING_URL") {
    currentListingUrl = msg.url;
    loadCommunityData(msg.url);
  }
});

// Initial state.
showLoading();
setExpandedWidth();
