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

function showLoading() {
  setAccent("#3b82f6");
  setState("loading");
}

function showError() {
  setAccent(COLORS.UNAVAILABLE);
  setState("error");
}

function badgeFromScore(score) {
  if (score >= 65) return { label: "LIKELY SAFE", emoji: "🟢", color: COLORS.SAFE };
  if (score >= 40) return { label: "CAUTION", emoji: "🟡", color: COLORS.CAUTION };
  return { label: "LIKELY SCAM", emoji: "🔴", color: COLORS.SCAM };
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
    ? 15
    : result.verdict === "SAFE"
    ? 85
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
  reasons.slice(0, 5).forEach((r) => {
    const li = document.createElement("li");
    li.textContent = r;
    reasonsEl.appendChild(li);
  });

  applyRisk("seller-risk", result.sellerRisk);
  applyRisk("image-risk", result.imageRisk);

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

  setState("verdict");
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
