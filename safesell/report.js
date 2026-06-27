// SafeSell — standalone seller report page logic.

const els = {
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  errorSub: document.getElementById("error-sub"),
  report: document.getElementById("report"),
  sellerName: document.getElementById("seller-name"),
  trustBadge: document.getElementById("trust-badge"),
  trustEmoji: document.getElementById("trust-emoji"),
  trustLabel: document.getElementById("trust-label"),
  headline: document.getElementById("headline"),
  stats: document.getElementById("stats"),
  activity: document.getElementById("activity"),
  assessment: document.getElementById("assessment"),
  webintel: document.getElementById("webintel"),
  sources: document.getElementById("sources"),
  openListing: document.getElementById("open-listing"),
  profileLink: document.getElementById("profile-link"),
};

// --- Icon selection by keyword (keeps the report pictorial) ---
function pickIcon(text, kind) {
  const t = (text || "").toLowerCase();
  if (kind === "pos") {
    if (/deliver|ship|fast|quick|prompt|speed/.test(t)) return "🚚";
    if (/quality|condition|genuine|authentic|original|as described|accurate|good product/.test(t)) return "✨";
    if (/communica|respons|reply|replies|friendly|polite|helpful|patient|nice/.test(t)) return "💬";
    if (/price|cheap|value|deal|afford|worth|reasonable/.test(t)) return "🏷️";
    if (/packag|wrap|protect/.test(t)) return "📦";
    if (/trust|recommend|reliable|honest|legit/.test(t)) return "🤝";
    if (/refund|payment|secure|safe/.test(t)) return "💳";
    if (/meet|punctual|on time/.test(t)) return "⏰";
    return "✅";
  }
  if (kind === "neg") {
    if (/late|slow|delay|wait/.test(t)) return "🐌";
    if (/no response|ghost|ignore|unrespons|no reply|slow reply/.test(t)) return "👻";
    if (/damage|defect|broken|faulty|not as described|misleading|wrong item/.test(t)) return "🛠️";
    if (/fake|counterfeit|replica|scam|fraud/.test(t)) return "❌";
    if (/overpric|expensive|hidden fee|extra charge/.test(t)) return "💸";
    if (/cancel|no show|noshow|backout|back out/.test(t)) return "🚫";
    if (/rude|impolite|aggressive/.test(t)) return "😠";
    return "⚠️";
  }
  if (kind === "flag") {
    if (/payment|deposit|upfront|transfer|paynow|bank/.test(t)) return "💳";
    if (/off.?platform|whatsapp|telegram|external|redirect/.test(t)) return "📵";
    if (/new account|recently|no review|few review/.test(t)) return "🆕";
    if (/price|too good|cheap|below market/.test(t)) return "🎣";
    if (/image|photo|stock|stolen/.test(t)) return "🖼️";
    return "🚩";
  }
  // tips
  if (/meet|in person|public|face/.test(t)) return "🤝";
  if (/payment|cash|pay on|cod|escrow/.test(t)) return "💵";
  if (/inspect|check|verify|test/.test(t)) return "🔍";
  if (/platform|carousell|in.?app|protection/.test(t)) return "🛡️";
  if (/avoid|don'?t|never/.test(t)) return "🚫";
  return "🛡️";
}

// --- Normalize list items that may be strings or {label, detail} ---
function normItem(item) {
  if (item == null) return null;
  if (typeof item === "string") return { label: item, detail: "" };
  return { label: item.label || item.text || "", detail: item.detail || "" };
}

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
  const tileClass = { pos: "tile-pos", neg: "tile-neg", flag: "tile-flag", tip: "tile-tip" }[kind];
  for (const it of arr) {
    const tile = document.createElement("div");
    tile.className = `tile ${tileClass}`;
    const icon = document.createElement("div");
    icon.className = "tile-icon";
    icon.textContent = pickIcon(it.label + " " + it.detail, kind);
    const label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = it.label;
    tile.appendChild(icon);
    tile.appendChild(label);
    if (it.detail) {
      const detail = document.createElement("div");
      detail.className = "tile-detail";
      detail.textContent = it.detail;
      tile.appendChild(detail);
    }
    container.appendChild(tile);
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

    const icon = document.createElement("div");
    icon.className = "tile-icon";
    icon.textContent = meta.icon;

    const label = document.createElement("div");
    label.className = "tile-label";
    label.textContent = meta.label;

    const confEl = document.createElement("span");
    confEl.className = `tile-conf conf-${["high", "medium", "low"].includes(conf) ? conf : "low"}`;
    confEl.textContent = `${conf} confidence`;

    tile.appendChild(icon);
    tile.appendChild(label);
    tile.appendChild(confEl);
    if (p.note) {
      const note = document.createElement("div");
      note.className = "tile-detail";
      note.textContent = p.note;
      tile.appendChild(note);
    }
    grid.appendChild(tile);
  }
}

const TRUST = {
  trusted: { label: "Trusted", emoji: "🟢", cls: "trust-trusted" },
  mixed: { label: "Mixed", emoji: "🟡", cls: "trust-mixed" },
  risky: { label: "Risky", emoji: "🔴", cls: "trust-risky" },
  unknown: { label: "Unknown", emoji: "⚪", cls: "trust-unknown" },
};

function showError(msg) {
  els.loading.hidden = true;
  els.report.hidden = true;
  els.error.hidden = false;
  els.errorSub.textContent = msg || "Could not build a seller report. Please try again.";
}

function renderReport(report, listing) {
  if (!report || report.error) {
    showError(report && report.error ? report.error : null);
    return;
  }

  els.sellerName.textContent = report.sellerUsername || listing.sellerUsername || "Seller";

  const trust = TRUST[(report.trustLevel || "unknown").toLowerCase()] || TRUST.unknown;
  els.trustBadge.className = `trust-badge ${trust.cls}`;
  els.trustEmoji.textContent = trust.emoji;
  // Show the same score as the sidebar verdict so the two views clearly agree.
  els.trustLabel.textContent =
    Number.isFinite(report.score) ? `${trust.label} · ${report.score}/100` : trust.label;

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
