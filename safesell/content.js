// SafeSell — content script.
// Scrapes the Carousell listing DOM, injects the sidebar iframe, and relays
// messages between the page, the sidebar, and the background worker.

(function () {
  const FRAME_ID = "safesell-frame";
  const LISTING_RE = /\/p\//; // Carousell listing path

  let lastUrl = location.href;
  let lastScrapeKey = "";
  let scrapeTimer = null;

  // -------------------------------------------------------------------------
  // Sidebar iframe
  // -------------------------------------------------------------------------
  function ensureSidebar() {
    let frame = document.getElementById(FRAME_ID);
    if (frame) return frame;

    frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.src = chrome.runtime.getURL("sidebar.html");
    frame.setAttribute("allowtransparency", "true");
    Object.assign(frame.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: "340px",
      height: "100vh",
      border: "none",
      zIndex: "99999",
      background: "transparent",
      colorScheme: "light",
    });
    document.documentElement.appendChild(frame);
    return frame;
  }

  function postToSidebar(payload) {
    const frame = document.getElementById(FRAME_ID);
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ source: "safesell", ...payload }, "*");
    }
  }

  // -------------------------------------------------------------------------
  // Scraping helpers
  // -------------------------------------------------------------------------
  function textOf(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && textOf(el)) return el;
    }
    return null;
  }

  // Find the element whose text looks most like a price (contains a currency
  // symbol followed by digits), preferring shorter/earlier nodes.
  function findPriceText() {
    const candidates = document.querySelectorAll(
      "h1, h2, h3, p, span, div"
    );
    const priceRe = /(S?\$|RM|₱|Rp|฿)\s?[\d,.]+/;
    for (const el of candidates) {
      // Only leaf-ish nodes to avoid grabbing huge containers.
      if (el.children.length > 2) continue;
      const t = textOf(el);
      if (t.length <= 40 && priceRe.test(t)) return t;
    }
    return "";
  }

  function findDescription(title) {
    // Carousell descriptions are usually a long block of text. Pick the longest
    // visible paragraph-like element that isn't the title.
    let best = "";
    const els = document.querySelectorAll("p, div, span");
    for (const el of els) {
      if (el.children.length > 3) continue;
      const t = textOf(el);
      if (t.length > best.length && t.length > 40 && t !== title) best = t;
    }
    return best.slice(0, 2000);
  }

  function findListingImages() {
    const urls = [];
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.currentSrc || img.src || "";
      // Carousell listing photos are served from media.karousell / cloudfront.
      if (
        /carousell|karousell|cloudfront|media-/i.test(src) &&
        !/avatar|profile|logo|icon/i.test(src) &&
        (img.naturalWidth === 0 || img.naturalWidth >= 150)
      ) {
        if (!urls.includes(src)) urls.push(src);
      }
      if (urls.length >= 3) break;
    }
    return urls.slice(0, 3);
  }

  function findSeller() {
    const out = { sellerUsername: "", sellerJoinDate: "", sellerReviews: "", sellerRating: "" };

    // Username: profile link of the shape /<username>/ (single path segment).
    const profileLink = Array.from(document.querySelectorAll('a[href^="/"]')).find(
      (a) => /^\/[^/]+\/?$/.test(a.getAttribute("href") || "") && textOf(a)
    );
    if (profileLink) out.sellerUsername = textOf(profileLink);

    const bodyText = document.body.innerText || "";

    const joined = bodyText.match(/Joined[^\n]*?(\d+\s+(?:year|month|week|day)s?|\b\d{4}\b)/i);
    if (joined) out.sellerJoinDate = joined[0].replace(/\s+/g, " ").trim();

    const reviews = bodyText.match(/([\d,]+)\s+[Rr]eview/);
    if (reviews) out.sellerReviews = reviews[1];

    const rating = bodyText.match(/\b([0-5](?:\.\d)?)\b\s*(?:\/\s*5|★|stars?)/i);
    if (rating) out.sellerRating = rating[1];

    return out;
  }

  function findCondition() {
    const bodyText = (document.body.innerText || "").toLowerCase();
    if (/\bbrand new\b/.test(bodyText)) return "Brand new";
    if (/\blike new\b/.test(bodyText)) return "Like new";
    if (/\bwell used\b/.test(bodyText)) return "Well used";
    if (/\blightly used\b/.test(bodyText)) return "Lightly used";
    if (/\bused\b/.test(bodyText)) return "Used";
    if (/\bnew\b/.test(bodyText)) return "New";
    return "";
  }

  function scrapeListing() {
    const titleEl = firstMatch(["h1"]) || firstMatch(["h2"]);
    const title = textOf(titleEl);
    const seller = findSeller();

    return {
      title,
      description: findDescription(title),
      price: findPriceText(),
      condition: findCondition(),
      imageUrls: findListingImages(),
      ...seller,
      listingUrl: location.href,
    };
  }

  // -------------------------------------------------------------------------
  // Analysis trigger
  // -------------------------------------------------------------------------
  function runAnalysis() {
    if (!LISTING_RE.test(location.pathname)) return;

    ensureSidebar();
    const listing = scrapeListing();

    // Avoid re-analyzing the same content repeatedly during SPA mutations.
    const key = `${location.href}|${listing.title}|${listing.price}`;
    if (key === lastScrapeKey) return;
    lastScrapeKey = key;

    postToSidebar({ type: "LOADING" });

    chrome.runtime.sendMessage({ type: "ANALYZE_LISTING", data: listing }, () => {
      // Swallow "receiving end does not exist" noise during fast navigation.
      void chrome.runtime.lastError;
    });
  }

  // Debounced trigger so we wait for the SPA to settle after navigation.
  function scheduleAnalysis(delay = 1200) {
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(runAnalysis, delay);
  }

  // -------------------------------------------------------------------------
  // SPA navigation detection
  // -------------------------------------------------------------------------
  function onMaybeNavigated() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastScrapeKey = "";
      if (LISTING_RE.test(location.pathname)) {
        scheduleAnalysis(1200);
      } else {
        // Left a listing page — hide the sidebar.
        const frame = document.getElementById(FRAME_ID);
        if (frame) frame.remove();
      }
    }
  }

  // Patch history methods to catch pushState/replaceState navigations.
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const ret = orig.apply(this, arguments);
      window.dispatchEvent(new Event("safesell:locationchange"));
      return ret;
    };
  });
  window.addEventListener("popstate", onMaybeNavigated);
  window.addEventListener("safesell:locationchange", onMaybeNavigated);

  // MutationObserver: catches both URL changes and late-rendered content.
  const observer = new MutationObserver(() => {
    onMaybeNavigated();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ANALYSIS_COMPLETE") {
      postToSidebar({ type: "RESULT", result: message.result });
    }
  });

  // Sidebar -> content script requests (e.g. re-run analysis on demand).
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "safesell-sidebar") return;
    if (msg.type === "REANALYZE") {
      lastScrapeKey = "";
      runAnalysis();
    } else if (msg.type === "RESIZE") {
      const frame = document.getElementById(FRAME_ID);
      if (frame) {
        frame.style.width = `${msg.width || 340}px`;
        // When collapsed, shrink the frame so it doesn't block page clicks.
        frame.style.height = msg.full === false ? "72px" : "100vh";
      }
    }
  });

  // -------------------------------------------------------------------------
  // Kickoff
  // -------------------------------------------------------------------------
  scheduleAnalysis(1500);
})();
