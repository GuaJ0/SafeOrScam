// SafeSell — search page badges.
// Injects a small coloured safety dot onto each listing card in search results.

(function () {
  const BADGE_ATTR = "data-safesell-badge";
  const CACHE_PREFIX = "safesell_badge_";
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // Extract listing URL from a card element.
  function getListingUrl(card) {
    const a = card.querySelector('a[href*="/p/"]');
    if (!a) return null;
    try {
      return new URL(a.getAttribute("href"), location.origin).href.split("?")[0];
    } catch (e) { return null; }
  }

  // Load a cached badge result from sessionStorage.
  function loadCache(url) {
    try {
      const raw = sessionStorage.getItem(CACHE_PREFIX + url);
      if (!raw) return null;
      const { verdict, score, ts } = JSON.parse(raw);
      if (Date.now() - ts > CACHE_TTL_MS) return null;
      return { verdict, score };
    } catch (e) { return null; }
  }

  function saveCache(url, verdict, score) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ verdict, score, ts: Date.now() }));
    } catch (e) { /* storage full, skip */ }
  }

  function colorForVerdict(verdict, score) {
    if (verdict === "SCAM" || score < 40) return "#ef4444";
    if (verdict === "CAUTION" || score < 65) return "#f59e0b";
    return "#22c55e";
  }

  function labelForVerdict(verdict, score) {
    if (verdict === "SCAM" || score < 40) return "Likely scam";
    if (verdict === "CAUTION" || score < 65) return "Caution";
    return "Looks safe";
  }

  // Create and attach a badge to a card.
  function attachBadge(card, verdict, score) {
    if (card.querySelector(`[${BADGE_ATTR}]`)) return;

    const color = colorForVerdict(verdict, score);
    const label = labelForVerdict(verdict, score);

    const badge = document.createElement("div");
    badge.setAttribute(BADGE_ATTR, verdict);
    badge.title = `SafeSell: ${label} (${score}/100)`;
    Object.assign(badge.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      zIndex: "10",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      background: "rgba(255,255,255,0.92)",
      backdropFilter: "blur(4px)",
      border: `1.5px solid ${color}`,
      borderRadius: "999px",
      padding: "2px 7px 2px 5px",
      fontSize: "11px",
      fontWeight: "600",
      color: color,
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
      pointerEvents: "none",
      lineHeight: "1.4",
    });

    const dot = document.createElement("span");
    Object.assign(dot.style, {
      width: "7px",
      height: "7px",
      borderRadius: "50%",
      background: color,
      flexShrink: "0",
      display: "inline-block",
    });

    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(label));

    // Cards need relative positioning for the absolute badge to sit correctly.
    const pos = getComputedStyle(card).position;
    if (pos === "static") card.style.position = "relative";

    card.appendChild(badge);
  }

  // Show a grey "checking…" placeholder while the analysis runs.
  function attachPending(card) {
    if (card.querySelector(`[${BADGE_ATTR}]`)) return;
    const badge = document.createElement("div");
    badge.setAttribute(BADGE_ATTR, "pending");
    Object.assign(badge.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      zIndex: "10",
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      background: "#d1d5db",
      boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
      pointerEvents: "none",
    });
    const pos = getComputedStyle(card).position;
    if (pos === "static") card.style.position = "relative";
    card.appendChild(badge);
  }

  function removePending(card) {
    const pending = card.querySelector(`[${BADGE_ATTR}="pending"]`);
    if (pending) pending.remove();
  }

  // Quick lightweight pre-check: just seller newness + title/price plausibility.
  // Sends QUICK_CHECK to the background worker instead of the full pipeline.
  function checkCard(card) {
    if (!extAlive()) return;
    const url = getListingUrl(card);
    if (!url) return;

    // Already processed.
    if (card.querySelector(`[${BADGE_ATTR}]:not([${BADGE_ATTR}="pending"])`)) return;

    // Cache hit — instant badge.
    const cached = loadCache(url);
    if (cached) {
      removePending(card);
      attachBadge(card, cached.verdict, cached.score);
      return;
    }

    attachPending(card);

    // Scrape minimal listing info from the card itself.
    const titleEl = card.querySelector("p, h2, h3, span");
    const title = titleEl ? titleEl.textContent.trim().slice(0, 100) : "";
    const priceEl = Array.from(card.querySelectorAll("p, span, div")).find((el) => {
      return /S?\$[\d,]+/.test(el.textContent) && el.textContent.trim().length < 25;
    });
    const price = priceEl ? priceEl.textContent.trim() : "";

    chrome.runtime.sendMessage(
      { type: "QUICK_CHECK", data: { listingUrl: url, title, price } },
      () => { void chrome.runtime.lastError; }
    );
  }

  // Find listing cards in search results. Carousell renders them as <a> tags
  // wrapping an image + text, sitting inside a grid. We look for any <a> that
  // links to a /p/ listing and has an <img> inside it.
  function findCards() {
    return Array.from(document.querySelectorAll('a[href*="/p/"]')).filter(
      (a) => a.querySelector("img") && a.offsetParent !== null
    );
  }

  // Process all visible cards.
  function scanPage() {
    if (!extAlive()) return;
    findCards().forEach(checkCard);
  }

  // Listen for QUICK_RESULT messages from the background worker.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "QUICK_RESULT") return;
    const { listingUrl, verdict, score } = message;
    if (!listingUrl || !verdict) return;

    saveCache(listingUrl, verdict, score);

    // Find the card(s) matching this URL and update them.
    findCards().forEach((card) => {
      const url = getListingUrl(card);
      if (url === listingUrl.split("?")[0]) {
        removePending(card);
        attachBadge(card, verdict, score);
      }
    });
  });

  // Observe DOM mutations (infinite scroll / SPA navigation adds new cards).
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan.
  setTimeout(scanPage, 1000);
})();
