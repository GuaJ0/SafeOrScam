// SafeSell — content script.
// Scrapes the Carousell listing DOM, injects the sidebar iframe, and relays
// messages between the page, the sidebar, and the background worker.

(function () {
  const FRAME_ID = "safesell-frame";
  const LISTING_RE = /\/p\//; // Carousell listing path

  let lastUrl = location.href;
  let lastScrapeKey = "";
  let scrapeTimer = null;
  let observer = null;

  // True only while this content script's extension context is still alive.
  // After the extension is reloaded/updated, an old injected script lingers and
  // any chrome.* call throws "Extension context invalidated"; we bail instead.
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // Stop all activity once the context is dead (prevents repeated errors from
  // the MutationObserver re-triggering on every SPA mutation).
  function shutdown() {
    try {
      if (observer) observer.disconnect();
    } catch (e) {
      /* ignore */
    }
    clearTimeout(scrapeTimer);
  }

  // -------------------------------------------------------------------------
  // Sidebar iframe
  // -------------------------------------------------------------------------
  function ensureSidebar() {
    if (!extAlive()) {
      shutdown();
      return null;
    }
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

  function findPriceText() {
    const priceRe = /(S?\$|RM|₱|Rp|฿)\s?[\d,.]+/;

    // First pass: look for the price near the listing title (h1), which is
    // where Carousell always places it. Walk siblings and nearby ancestors.
    const h1 = document.querySelector("h1");
    if (h1) {
      // Check siblings and parent's children within a small window.
      const parent = h1.parentElement;
      if (parent) {
        for (const el of parent.querySelectorAll("p, span, div")) {
          if (el.children.length > 2) continue;
          const t = textOf(el);
          if (t.length <= 30 && priceRe.test(t)) return t;
        }
      }
    }

    // Second pass: scan the whole page but require the element to contain
    // ONLY a price (short text, no other sentences mixed in).
    const candidates = document.querySelectorAll("h2, h3, p, span, div");
    for (const el of candidates) {
      if (el.children.length > 1) continue;
      const t = textOf(el);
      // Must be short and the entire text should be (roughly) just a price.
      if (t.length <= 20 && priceRe.test(t)) return t;
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

  // Heuristically grab short review-like blurbs visible on the listing page.
  function findReviewSnippets() {
    const snippets = [];
    const els = document.querySelectorAll("p, span, div, li");
    for (const el of els) {
      if (el.children.length > 2) continue;
      const t = textOf(el);
      // Reviews tend to be sentence-length, conversational fragments.
      if (
        t.length >= 25 &&
        t.length <= 300 &&
        /\b(great|good|fast|legit|recommend|smooth|pleasant|nice|scam|cheat|fake|late|never|refund|liar|patient|friendly|deal)\b/i.test(
          t
        )
      ) {
        if (!snippets.includes(t)) snippets.push(t);
      }
      if (snippets.length >= 12) break;
    }
    return snippets;
  }

  function findSeller() {
    const out = {
      sellerUsername: "",
      sellerHandle: "",
      sellerJoinDate: "",
      sellerReviews: "",
      sellerRating: "",
      sellerProfileUrl: "",
      reviewSnippets: [],
    };

    // Seller profile links on Carousell are strictly of the form /u/<handle>/.
    // The earlier, looser "/<segment>/" match accidentally caught category /
    // breadcrumb links (e.g. "Electronics"), so we now only trust /u/ links.
    const GENERIC =
      /^(home|categories?|electronics|fashion|mobile phones?|computers?|shop|reviews?|visit|follow|following|share|see all|listings?|sold|new|used)$/i;
    const profileLinks = Array.from(document.querySelectorAll('a[href]')).filter(
      (a) => /\/u\/[^/]+\/?$/.test(a.getAttribute("href") || "")
    );
    // Prefer a profile link whose visible text looks like a real seller name.
    const profileLink =
      profileLinks.find((a) => {
        const t = textOf(a);
        return t && !GENERIC.test(t) && t.length <= 40;
      }) || profileLinks[0];

    if (profileLink) {
      const href = profileLink.getAttribute("href") || "";
      const handleMatch = href.match(/\/u\/([^/]+)/);
      const handle = handleMatch ? decodeURIComponent(handleMatch[1]) : "";
      const text = textOf(profileLink);
      out.sellerHandle = handle;
      // Use the display name when it's meaningful; otherwise fall back to the
      // URL handle so we never label the seller with a category name.
      out.sellerUsername = text && !GENERIC.test(text) && text.length <= 40 ? text : handle;
      try {
        out.sellerProfileUrl = new URL(href, location.origin).href;
      } catch (e) {
        /* ignore */
      }
    }

    // Best-effort: capture any review-like text already on the listing page.
    out.reviewSnippets = findReviewSnippets();

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
    if (!extAlive()) {
      shutdown();
      return;
    }
    if (!LISTING_RE.test(location.pathname)) return;

    if (!ensureSidebar()) return;
    const listing = scrapeListing();

    // Avoid re-analyzing the same content repeatedly during SPA mutations.
    const key = `${location.href}|${listing.title}|${listing.price}`;
    if (key === lastScrapeKey) return;
    lastScrapeKey = key;

    postToSidebar({ type: "LOADING" });
    postToSidebar({ type: "LISTING_URL", url: location.href.split("?")[0] });

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
    if (!extAlive()) {
      shutdown();
      return;
    }
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
  observer = new MutationObserver(() => {
    onMaybeNavigated();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ANALYSIS_COMPLETE") {
      postToSidebar({ type: "RESULT", result: message.result });
      // Re-send listing URL now that the sidebar is fully loaded and ready.
      postToSidebar({ type: "LISTING_URL", url: location.href.split("?")[0] });
    }
  });

  // Sidebar -> content script requests (e.g. re-run analysis on demand).
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "safesell-sidebar") return;
    if (msg.type === "REANALYZE") {
      lastScrapeKey = "";
      runAnalysis();
    } else if (msg.type === "OPEN_SELLER_REPORT") {
      // Open the full report in a dedicated tab (cleaner than the sidebar).
      console.debug("[SafeSell] content: OPEN_SELLER_REPORT received → scraping + messaging background");
      const listing = scrapeListing();
      chrome.runtime.sendMessage({ type: "OPEN_REPORT_TAB", data: listing, verdict: msg.verdict }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("[SafeSell] content: OPEN_REPORT_TAB failed:", chrome.runtime.lastError.message);
        } else {
          console.debug("[SafeSell] content: background ack:", resp);
        }
      });
    } else if (msg.type === "RESIZE") {
      const frame = document.getElementById(FRAME_ID);
      if (frame) {
        frame.style.width = `${msg.width || 340}px`;
        frame.style.height = msg.full === false ? "72px" : "100vh";
      }
    } else if (msg.type === "SUBMIT_VOTE") {
      chrome.runtime.sendMessage(
        { type: "SUBMIT_VOTE", data: { listingUrl: msg.listingUrl, verdict: msg.verdict, comment: msg.comment } },
        (res) => {
          void chrome.runtime.lastError;
          postToSidebar({ type: "VOTE_RESULT", ok: res?.ok, error: res?.error });
        }
      );
    } else if (msg.type === "GET_VOTES") {
      chrome.runtime.sendMessage({ type: "GET_VOTES", listingUrl: msg.listingUrl }, (res) => {
        void chrome.runtime.lastError;
        postToSidebar({ type: "VOTES_DATA", ...res });
      });
    } else if (msg.type === "SIGN_IN_GOOGLE") {
      chrome.runtime.sendMessage({ type: "SIGN_IN_GOOGLE" }, (res) => {
        void chrome.runtime.lastError;
        if (res?.ok) {
          // Reload community data after sign-in
          postToSidebar({ type: "VOTES_DATA", user: res.user });
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Kickoff
  // -------------------------------------------------------------------------
  scheduleAnalysis(1500);
})();
