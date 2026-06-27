// SafeSell — standalone seller report page logic.

const els = {
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  errorSub: document.getElementById("error-sub"),
  report: document.getElementById("report"),
  hero: document.getElementById("hero"),
  sellerName: document.getElementById("seller-name"),
  trustLabel: document.getElementById("trust-label"),
  scoreNum: document.getElementById("score-num"),
  scoreArc: document.getElementById("score-arc"),
  headline: document.getElementById("headline"),
  stats: document.getElementById("stats"),
  activity: document.getElementById("activity"),
  assessment: document.getElementById("assessment"),
  webintel: document.getElementById("webintel"),
  sources: document.getElementById("sources"),
  openListing: document.getElementById("open-listing"),
  profileLink: document.getElementById("profile-link"),
};

// Inline Tabler outline icons (extension page runs offline under a strict CSP).
const ICONS = {
  sparkles:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" /><path d="M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2z" /><path d="M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" /></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4" /><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z" /><path d="M12 16h.01" /></svg>',
  flag:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9z" /><path d="M5 21v-7" /></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg>',
};

// --- Normalize list items that may be strings or {label, detail} ---
function normItem(item) {
  if (item == null) return null;
  if (typeof item === "string") return { label: item, detail: "" };
  return { label: item.label || item.text || "", detail: item.detail || "" };
}

const KIND_META = {
  pos: { icon: ICONS.sparkles, tone: "tone-success" },
  neg: { icon: ICONS.alert, tone: "tone-warning" },
  flag: { icon: ICONS.flag, tone: "tone-danger" },
  tip: { icon: ICONS.search, tone: "tone-accent" },
};

function renderTiles(containerId, sectionId, items, kind) {
  const container = document.getElementById(containerId);
  const section = document.getElementById(sectionId);
  container.innerHTML = "";
  const arr = (Array.isArray(items) ? items : [])
    .map(normItem)
    .filter((x) => x && x.label);
  if (!arr.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const meta = KIND_META[kind] || KIND_META.tip;
  for (const it of arr) {
    const card = document.createElement("div");
    card.className = "content-card";

    const icon = document.createElement("div");
    icon.className = `card-icon ${meta.tone}`;
    icon.innerHTML = meta.icon;

    const text = document.createElement("div");
    text.className = "card-text";
    const title = document.createElement("p");
    title.className = "card-title";
    title.textContent = it.label;
    text.appendChild(title);
    if (it.detail) {
      const sub = document.createElement("p");
      sub.className = "card-subtitle";
      sub.textContent = it.detail;
      text.appendChild(sub);
    }

    card.appendChild(icon);
    card.appendChild(text);
    container.appendChild(card);
  }
}

const PLATFORM_META = {
  instagram: { icon: "📸", label: "Instagram" },
  linkedin: { icon: "💼", label: "LinkedIn" },
  twitter: { icon: "🐦", label: "X / Twitter" },
  tiktok: { icon: "🎵", label: "TikTok" },
  facebook: { icon: "👤", label: "Facebook" },
  github: { icon: "💻", label: "GitHub" },
  marketplace: { icon: "🛍️", label: "Marketplace" },
  website: { icon: "🌐", label: "Website" },
};

const SIGNAL_META = {
  strong: { label: "Strong identity", cls: "signal-strong" },
  some: { label: "Some presence", cls: "signal-some" },
  weak: { label: "Weak presence", cls: "signal-weak" },
  none: { label: "No match found", cls: "signal-none" },
};

function renderPresence(presence) {
  const section = document.getElementById("sec-presence");
  const grid = document.getElementById("presence-grid");
  const signalEl = document.getElementById("presence-signal");
  const summaryEl = document.getElementById("presence-summary");
  grid.innerHTML = "";

  const platforms = (presence && Array.isArray(presence.platforms) ? presence.platforms : []).filter(
    (p) => p && p.url && PLATFORM_META[p.platform]
  );
  const signalKey = (presence && presence.identitySignal) || (platforms.length ? "some" : "none");

  // Hide the whole section only when there's truly nothing to say.
  if (!platforms.length && (!presence || !presence.summary) && signalKey === "none") {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const sig = SIGNAL_META[signalKey] || SIGNAL_META.none;
  signalEl.textContent = sig.label;
  signalEl.className = `presence-pill ${sig.cls}`;
  summaryEl.textContent =
    (presence && presence.summary) ||
    (platforms.length
      ? "Matching public profiles were found on other platforms."
      : "No matching public profiles were found — not necessarily suspicious.");

  for (const p of platforms) {
    const meta = PLATFORM_META[p.platform];
    const conf = (p.confidence || "low").toLowerCase();
    const tile = document.createElement("a");
    tile.className = "tile tile-presence";
    tile.href = p.url;
    tile.target = "_blank";
    tile.rel = "noopener noreferrer";

    const icon = document.createElement("span");
    icon.className = "tile-icon";
    icon.textContent = meta.icon;

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = meta.label;

    const confEl = document.createElement("span");
    confEl.className = `tile-conf conf-${["high", "medium", "low"].includes(conf) ? conf : "low"}`;
    confEl.textContent = conf;

    tile.appendChild(icon);
    tile.appendChild(label);
    tile.appendChild(confEl);
    if (p.note) {
      const note = document.createElement("span");
      note.className = "tile-detail";
      note.textContent = p.note;
      tile.appendChild(note);
    }
    grid.appendChild(tile);
  }
}

const TRUST = {
  trusted: { label: "Trusted", cls: "trust-trusted" },
  mixed: { label: "Mixed", cls: "trust-mixed" },
  risky: { label: "Risky", cls: "trust-risky" },
  unknown: { label: "Unknown", cls: "trust-unknown" },
};

// Verdict tone (gauge stroke + status pill) by trust level.
const TONE = {
  trusted: { color: "#16a34a", border: "#86efac" },
  mixed: { color: "#d97706", border: "#fcd34d" },
  risky: { color: "#dc2626", border: "#fca5a5" },
  unknown: { color: "#6b7280", border: "#d1d5db" },
};

function showError(msg) {
  els.loading.hidden = true;
  els.report.hidden = true;
  els.error.hidden = false;
  els.errorSub.textContent = msg || "Could not build a seller report. Please try again.";
}

function animateGauge(score) {
  if (!els.scoreArc) return;
  els.scoreArc.style.strokeDashoffset = "170";
  if (!Number.isFinite(score)) return;
  const target = Math.round(170 - (score / 100) * 170);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.scoreArc.style.strokeDashoffset = String(target);
    });
  });
}

function renderReport(report, listing) {
  if (!report || report.error) {
    showError(report && report.error ? report.error : null);
    return;
  }

  els.sellerName.textContent = report.sellerUsername || listing.sellerUsername || "Seller";

  const level = (report.trustLevel || "unknown").toLowerCase();
  const trust = TRUST[level] || TRUST.unknown;
  const tone = TONE[level] || TONE.unknown;
  els.hero.style.setProperty("--tone", tone.color);
  els.hero.style.setProperty("--tone-border", tone.border);
  els.trustLabel.textContent = trust.label;

  // Score gauge — same score as the sidebar verdict so the views agree.
  const hasScore = Number.isFinite(report.score);
  const score = hasScore ? Math.max(0, Math.min(100, Math.round(report.score))) : null;
  els.scoreNum.textContent = hasScore ? String(score) : "—";

  els.headline.textContent = report.headline || "";

  const stats = [
    ["Rating", report.sellerRating || listing.sellerRating || "—"],
    ["Reviews", report.sellerReviews || listing.sellerReviews || "—"],
    ["Joined", report.sellerJoinDate || listing.sellerJoinDate || "—"],
    ["Evidence", report.evidenceQuality || "—"],
  ];
  els.stats.innerHTML = stats
    .map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`)
    .join("");

  const trends = report.reviewTrends || {};
  renderTiles("positives", "sec-positives", trends.positives, "pos");
  renderTiles("complaints", "sec-complaints", trends.complaints, "neg");
  renderTiles("redflags", "sec-redflags", report.redFlags, "flag");
  renderTiles("tips", "sec-tips", report.safetyTips, "tip");
  renderPresence(report.webPresence);

  els.activity.textContent = report.activity || "No activity details available.";
  els.assessment.textContent = report.assessment || "No assessment available.";
  els.webintel.textContent = report.webIntel || "No notable mentions found online.";

  const profileUrl = report.sellerProfileUrl || listing.sellerProfileUrl;
  if (profileUrl) {
    els.profileLink.href = profileUrl;
    els.profileLink.hidden = false;
  }

  const src = report.sources || {};
  const bits = [src.profilePage ? "seller profile page" : "listing page"];
  if (src.webSearch) bits.push("Exa web search");
  els.sources.textContent = "Based on " + bits.join(" + ") + ".";

  els.loading.hidden = true;
  els.error.hidden = true;
  els.report.hidden = false;

  // Animate after the report is visible so the transition runs.
  animateGauge(score);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Boot: read the stored listing, then ask the worker to build the report ---
chrome.storage.local.get("safesell_report_listing", (data) => {
  const payload = data.safesell_report_listing;
  if (!payload || !payload.listing) {
    showError("No listing data found. Please re-open the report from a Carousell listing.");
    return;
  }
  const listing = payload.listing;
  const verdict = payload.verdict || null;

  if (listing.listingUrl) {
    els.openListing.href = listing.listingUrl;
    els.openListing.hidden = false;
  }

  chrome.runtime.sendMessage({ type: "SELLER_REPORT", data: listing, verdict }, (resp) => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message);
      return;
    }
    if (!resp || !resp.report) {
      showError("The background service did not return a report.");
      return;
    }
    renderReport(resp.report, listing);
  });
});
