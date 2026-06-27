// SafeSell — chat red flag monitor.
// Watches the Carousell chat DOM for new messages and sends them to the
// background worker for OpenAI red flag analysis.

(function () {
  const BANNER_ID = "safesell-chat-banner";
  let lastAnalyzedHash = "";
  let analyzeTimer = null;

  function extAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Banner UI
  // ---------------------------------------------------------------------------
  function getBanner() {
    return document.getElementById(BANNER_ID);
  }

  function removeBanner() {
    const b = getBanner();
    if (b) b.remove();
  }

  function showBanner(flags) {
    removeBanner();

    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    Object.assign(banner.style, {
      position: "fixed",
      bottom: "80px",
      right: "16px",
      zIndex: "999999",
      maxWidth: "320px",
      background: "#fff",
      border: "1.5px solid #fca5a5",
      borderRadius: "12px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.13)",
      fontFamily: "system-ui, -apple-system, sans-serif",
      overflow: "hidden",
    });

    banner.innerHTML = `
      <div style="background:#fef2f2;padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #fecaca;">
        <span style="font-size:16px;">⚠️</span>
        <span style="font-size:13px;font-weight:700;color:#b91c1c;">SafeSell detected red flags</span>
        <button id="safesell-dismiss" style="margin-left:auto;background:none;border:none;cursor:pointer;color:#9ca3af;font-size:16px;line-height:1;padding:0;">✕</button>
      </div>
      <ul style="margin:0;padding:10px 14px 12px 28px;display:flex;flex-direction:column;gap:6px;">
        ${flags.map(f => `<li style="font-size:12.5px;color:#374151;line-height:1.45;">${f}</li>`).join("")}
      </ul>
      <div style="padding:0 14px 12px;font-size:11px;color:#9ca3af;">Powered by SafeSell · Be cautious before paying</div>
    `;

    document.body.appendChild(banner);
    document.getElementById("safesell-dismiss").addEventListener("click", removeBanner);
  }

  // ---------------------------------------------------------------------------
  // Message scraping
  // ---------------------------------------------------------------------------
  function scrapeMessages() {
    const messages = [];

    // Carousell chat messages are rendered in a scrollable list.
    // Each message bubble is a <p> or <div> inside a chat row.
    const els = document.querySelectorAll('[class*="message"], [class*="Message"], [class*="chat"], [class*="Chat"], [class*="bubble"], [class*="Bubble"]');
    for (const el of els) {
      if (el.children.length > 4) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length >= 5 && t.length <= 1000 && !messages.includes(t)) {
        messages.push(t);
      }
    }

    // Fallback: grab all reasonably-sized text nodes in the main content area.
    if (messages.length === 0) {
      const fallback = document.querySelectorAll("p, span, div");
      for (const el of fallback) {
        if (el.children.length > 1) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length >= 10 && t.length <= 500) messages.push(t);
        if (messages.length >= 30) break;
      }
    }

    return messages.slice(-20); // Send the most recent 20 messages only.
  }

  function hashMessages(messages) {
    return messages.join("|");
  }

  // ---------------------------------------------------------------------------
  // Analysis trigger
  // ---------------------------------------------------------------------------
  function maybeAnalyze() {
    if (!extAlive()) return;
    const messages = scrapeMessages();
    if (messages.length < 2) return; // Not enough context yet.

    const hash = hashMessages(messages);
    if (hash === lastAnalyzedHash) return; // No new messages.
    lastAnalyzedHash = hash;

    chrome.runtime.sendMessage(
      { type: "ANALYZE_CHAT", data: { messages } },
      () => { void chrome.runtime.lastError; }
    );
  }

  function scheduleAnalyze() {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(maybeAnalyze, 1500);
  }

  // ---------------------------------------------------------------------------
  // Listen for result from background
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "CHAT_RESULT") return;
    const { flagged, flags } = message;
    if (flagged && flags && flags.length > 0) {
      showBanner(flags);
    } else {
      removeBanner();
    }
  });

  // ---------------------------------------------------------------------------
  // Observe DOM for new messages
  // ---------------------------------------------------------------------------
  const observer = new MutationObserver(scheduleAnalyze);
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check after page settles.
  setTimeout(maybeAnalyze, 2000);
})();
