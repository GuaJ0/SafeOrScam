// SafeSell — background service worker.
// All network calls live here so we never hit CORS from the content script.

// ---------------------------------------------------------------------------
// API keys.
// You can either paste keys directly below, or (recommended) leave them blank
// and set them from the extension's Options page (stored in chrome.storage).
// Keys saved via the Options page take precedence over the constants here.
// ---------------------------------------------------------------------------
const OPENAI_API_KEY = "YOUR_OPENAI_KEY";
const EXA_API_KEY = "YOUR_EXA_KEY";
const SERP_API_KEY = "YOUR_SERPAPI_KEY";

const API_TIMEOUT_MS = 15000;
const STOCK_PHOTO_SITES = ["shutterstock", "getty", "unsplash", "istockphoto"];

// Pull keys from storage first, falling back to the in-file constants.
async function getKeys() {
  const stored = await chrome.storage.local.get([
    "OPENAI_API_KEY",
    "EXA_API_KEY",
    "SERP_API_KEY",
  ]);
  const clean = (v, fallback) => {
    const val = (v || "").trim();
    if (val) return val;
    const fb = (fallback || "").trim();
    return fb.startsWith("YOUR_") ? "" : fb;
  };
  return {
    openai: clean(stored.OPENAI_API_KEY, OPENAI_API_KEY),
    exa: clean(stored.EXA_API_KEY, EXA_API_KEY),
    serp: clean(stored.SERP_API_KEY, SERP_API_KEY),
  };
}

// fetch() with an AbortController-based timeout.
async function fetchWithTimeout(url, options = {}, timeout = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Check 1 — Exa search (seller reputation + listing uniqueness)
// ---------------------------------------------------------------------------
async function runExaCheck(listing, exaKey) {
  if (!exaKey) throw new Error("Missing Exa API key");

  const headers = {
    "x-api-key": exaKey,
    "Content-Type": "application/json",
  };

  // Improved seller query: profile + scam signals
  const sellerQuery = `Carousell seller "${listing.sellerUsername || "seller"}" reviews profile Singapore`;
  const sellerScamQuery = `"${listing.sellerUsername || "seller"}" Carousell scam fraud complaint Singapore`;
  const listingQuery = `${listing.title || "listing"} ${listing.price || ""} Singapore marketplace scam`;
  // Market price query to ground the listed price
  const priceQuery = `${listing.title || "item"} price Singapore buy sell 2024 2025`;

  const search = (query) =>
    fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        numResults: 5,
        useAutoprompt: true,
        contents: { text: true },
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Exa ${r.status}: ${await r.text()}`);
      return r.json();
    });

  const [sellerRes, sellerScamRes, listingRes, priceRes] = await Promise.all([
    search(sellerQuery),
    search(sellerScamQuery),
    search(listingQuery),
    search(priceQuery),
  ]);

  const summarize = (label, res) => {
    const results = (res && res.results) || [];
    if (!results.length) return `${label}: no relevant results found.`;
    const lines = results.slice(0, 5).map((item, i) => {
      const title = item.title || "Untitled";
      const text = (item.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
      return `  ${i + 1}. ${title}${text ? ` — ${text}` : ""}`;
    });
    return `${label}:\n${lines.join("\n")}`;
  };

  return [
    summarize("Seller profile results", sellerRes),
    summarize("Seller scam/fraud reports", sellerScamRes),
    summarize("Listing scam results", listingRes),
    summarize("Market price reference", priceRes),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Check 2 — Reverse image search (SerpAPI)
// ---------------------------------------------------------------------------
async function runImageCheck(listing, serpKey) {
  if (!serpKey) throw new Error("Missing SerpAPI key");
  const imageUrl = (listing.imageUrls || [])[0];
  if (!imageUrl) {
    return {
      foundOnStockSites: false,
      foundOnOtherListings: false,
      matchCount: 0,
      summary: "No listing image was available to reverse-search.",
    };
  }

  const url =
    `https://serpapi.com/search.json?engine=google_reverse_image` +
    `&image_url=${encodeURIComponent(imageUrl)}` +
    `&api_key=${encodeURIComponent(serpKey)}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const matches = data.image_results || data.inline_images || [];
  const allText = JSON.stringify(matches).toLowerCase();

  const foundOnStockSites = STOCK_PHOTO_SITES.some((s) => allText.includes(s));
  const foundOnOtherListings = allText.includes("carousell");
  const matchCount = Array.isArray(matches) ? matches.length : 0;

  let summary;
  if (matchCount === 0) {
    summary = "No visually similar images found elsewhere on the web.";
  } else {
    const bits = [`Found ${matchCount} similar image match(es)`];
    if (foundOnStockSites) bits.push("including stock-photo sites");
    if (foundOnOtherListings) bits.push("including other Carousell listings");
    summary = bits.join(", ") + ".";
  }

  return { foundOnStockSites, foundOnOtherListings, matchCount, summary };
}

// ---------------------------------------------------------------------------
// Check 3 — OpenAI analysis
// ---------------------------------------------------------------------------
async function runOpenAICheck(listing, exaSummary, imageResult, openaiKey) {
  if (!openaiKey) throw new Error("Missing OpenAI API key");

  const systemPrompt =
    "You are a scam detection expert for Carousell, a major online marketplace in Southeast Asia. " +
    "Analyze listing data and return a structured JSON verdict. Be concise, specific, and accurate.\n\n" +
    "SCORING GUIDE — use the full 0–100 range:\n" +
    "85–100: Clearly legitimate. Established seller, fair price, real photos, detailed description.\n" +
    "65–84: Likely safe. Minor unknowns (new seller, few reviews) but nothing suspicious.\n" +
    "40–64: Genuine caution warranted. Multiple weak signals: new account, vague description, price slightly low.\n" +
    "20–39: Probably a scam. Stock/stolen images, price well below market, suspicious seller history.\n" +
    "0–19: Almost certainly a scam. Stock photos confirmed, price >50% below market, new account, no reviews.\n\n" +
    "EXAMPLES:\n" +
    '{"verdict":"SAFE","score":90,"reasons":["Seller has 200+ reviews and 4.9 rating","Price matches market","Original photos with receipt visible"],"scamType":"none","sellerRisk":"low","imageRisk":"low"}\n' +
    '{"verdict":"SAFE","score":72,"reasons":["Seller joined 6 months ago with 3 reviews","Price is fair","Photos appear genuine"],"scamType":"none","sellerRisk":"low","imageRisk":"low"}\n' +
    '{"verdict":"CAUTION","score":52,"reasons":["Seller joined last week with no reviews","Price 20% below market","Description is very brief"],"scamType":"none","sellerRisk":"medium","imageRisk":"low"}\n' +
    '{"verdict":"SCAM","score":18,"reasons":["Image found on stock photo site","Price 60% below market","Account created 2 days ago"],"scamType":"stolen images","sellerRisk":"high","imageRisk":"high"}';

  const userPrompt = `Analyze this Carousell listing for scam risk and return ONLY valid JSON.

LISTING:
Title: ${listing.title}
Price: ${listing.price}
Description: ${listing.description}
Condition: ${listing.condition}
URL: ${listing.listingUrl}

SELLER:
Username: ${listing.sellerUsername}
Joined: ${listing.sellerJoinDate}
Reviews: ${listing.sellerReviews}
Rating: ${listing.sellerRating}

EXA WEB INTELLIGENCE:
${exaSummary || "No web intelligence available."}

PRICE ANALYSIS INSTRUCTION:
The "Market price reference" section above contains real-world price data for this item. Compare the listing price against typical market prices. If the listing price is significantly lower than market (e.g. >30% below), treat this as a scam signal and reflect it in the score.

IMAGE ANALYSIS:
Found on stock photo sites: ${imageResult ? imageResult.foundOnStockSites : "unknown"}
Found on other listings: ${imageResult ? imageResult.foundOnOtherListings : "unknown"}
Total similar image matches: ${imageResult ? imageResult.matchCount : "unknown"}
Summary: ${imageResult ? imageResult.summary : "No image analysis available."}

Return ONLY this JSON structure, no other text:
{
  "verdict": "SAFE" | "CAUTION" | "SCAM",
  "score": <0-100 integer, 0=definitely scam, 100=definitely safe>,
  "reasons": [
    "<Cover the seller: account age, review count, rating, and any reputation findings from web search>",
    "<Cover the price: how it compares to market rate, whether it seems suspiciously low or fair>",
    "<Cover the listing itself: description quality, condition accuracy, completeness of details>",
    "<Cover the images: whether they appear original, stock, or reused from other listings>",
    "<Cover any other signals: payment method risks, red flags in description, web scam reports, or positive trust signals>"
  ],
  "scamType": "none" | "fake listing" | "stolen images" | "payment redirect" | "counterfeit" | "account fraud",
  "sellerRisk": "low" | "medium" | "high",
  "imageRisk": "low" | "medium" | "high"
}

Write each reason like a knowledgeable friend giving you a straight, honest take — not a corporate risk report. Be specific and reference actual data (e.g. exact review count, price vs market, join date). Avoid starting every sentence with "The seller" or "The listing". Vary the phrasing and keep it natural.`;

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseVerdict(content);
}

// Tolerant JSON parsing — strips code fences / stray prose around the object.
function parseVerdict(raw) {
  let text = (raw || "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function analyzeListing(listing) {
  const keys = await getKeys();

  const [exaOutcome, imageOutcome] = await Promise.allSettled([
    runExaCheck(listing, keys.exa),
    runImageCheck(listing, keys.serp),
  ]);

  const exaSummary =
    exaOutcome.status === "fulfilled" ? exaOutcome.value : null;
  const imageResult =
    imageOutcome.status === "fulfilled" ? imageOutcome.value : null;

  if (exaOutcome.status === "rejected")
    console.warn("SafeSell: Exa check failed:", exaOutcome.reason);
  if (imageOutcome.status === "rejected")
    console.warn("SafeSell: image check failed:", imageOutcome.reason);

  let verdict = null;
  try {
    verdict = await runOpenAICheck(listing, exaSummary, imageResult, keys.openai);
  } catch (err) {
    console.warn("SafeSell: OpenAI check failed:", err);
  }

  const allFailed =
    exaOutcome.status === "rejected" &&
    imageOutcome.status === "rejected" &&
    !verdict;

  if (allFailed) {
    return {
      verdict: "UNAVAILABLE",
      error: "Could not reach one or more services.",
    };
  }

  // Merge OpenAI verdict with the image-check results as the final output.
  const base = verdict || {
    verdict: "CAUTION",
    score: 50,
    reasons: [
      "The AI analysis could not be completed.",
      "Verdict is based on partial signals only.",
      "Treat this listing with normal caution.",
    ],
    scamType: "none",
    sellerRisk: "medium",
    imageRisk: imageResult && imageResult.foundOnStockSites ? "high" : "low",
  };

  return {
    ...base,
    imageCheck: imageResult,
    exaAvailable: exaOutcome.status === "fulfilled",
    imageAvailable: imageOutcome.status === "fulfilled",
    aiAvailable: !!verdict,
  };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ANALYZE_LISTING") return;
  const tabId = sender?.tab?.id;

  analyzeListing(message.data)
    .then((result) => {
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: "ANALYSIS_COMPLETE", result });
      }
      sendResponse({ ok: true });
    })
    .catch((err) => {
      console.error("SafeSell: analysis crashed:", err);
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: "ANALYSIS_COMPLETE",
          result: { verdict: "UNAVAILABLE", error: String(err) },
        });
      }
      sendResponse({ ok: false, error: String(err) });
    });

  return true; // keep the message channel open for the async response
});
