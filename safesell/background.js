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
    "SCORING GUIDE — the score is a TRUST/SAFETY score where 100 = very safe and 0 = almost certainly a scam. Higher is better. Use the full 0–100 range:\n" +
    "80–100: Clearly legitimate. Strong trust signals: established seller, good reviews/rating, fair price, original photos, detailed description.\n" +
    "60–79: Looks fine. This is the DEFAULT for an ordinary listing. Limited information (new seller, few/no reviews, average description) belongs here as long as there are NO concrete red flags.\n" +
    "40–59: Mixed. At least one genuine, concrete concern (e.g. price clearly below market, reused images, a real complaint/scam mention) alongside some reassurance.\n" +
    "20–39: Probably a scam. Several concrete red flags: stock/stolen images, price well below market, suspicious history, payment-redirect requests.\n" +
    "0–19: Almost certainly a scam. Confirmed stock photos, price >50% below market, brand-new account, known scam reports.\n\n" +
    "IMPORTANT — do NOT be overly punishing. Missing information is NOT itself a scam signal. A new account, few reviews, or a short description, on their own, should score in the 60–79 range, NOT the caution band. Only drop below 60 when there is at least one CONCRETE risk signal. When in doubt with no real red flags, lean toward 70.\n\n" +
    "EXAMPLES:\n" +
    '{"verdict":"SAFE","score":92,"reasons":["Seller has 200+ reviews and 4.9 rating","Price matches market","Original photos with receipt visible"],"scamType":"none","sellerRisk":"low","imageRisk":"low"}\n' +
    '{"verdict":"SAFE","score":74,"reasons":["Newer seller with only a few reviews, but nothing concerning","Price is fair for the item","Photos look genuine and original"],"scamType":"none","sellerRisk":"low","imageRisk":"low"}\n' +
    '{"verdict":"CAUTION","score":48,"reasons":["Price is ~30% below typical market rate","Brand-new account with no reviews","Description is unusually brief for the item"],"scamType":"none","sellerRisk":"medium","imageRisk":"low"}\n' +
    '{"verdict":"SCAM","score":15,"reasons":["Image found on a stock photo site","Price 60% below market","Account created 2 days ago"],"scamType":"stolen images","sellerRisk":"high","imageRisk":"high"}';

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

// ---------------------------------------------------------------------------
// Check 4 — Alternative listings (Exa, only for CAUTION/SCAM verdicts)
// ---------------------------------------------------------------------------
async function runAlternativesSearch(listing, exaKey) {
  if (!exaKey) throw new Error("Missing Exa API key");

  // Strip condition/adjectives to get a cleaner item name for search.
  const title = (listing.title || "").replace(/\b(brand new|like new|used|lightly used|well used|new)\b/gi, "").trim();
  const query = `${title} for sale Singapore site:carousell.sg`;

  const res = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": exaKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: 6,
      useAutoprompt: false,
      includeDomains: ["carousell.sg"],
      contents: { text: true, image: true, livecrawl: "fallback" },
    }),
  });
  if (!res.ok) throw new Error(`Exa alternatives ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const priceRe = /(S?\$|SGD)\s?([\d,]+)/i;
  const currentUrl = (listing.listingUrl || "").split("?")[0];

  const alternatives = [];
  for (const item of (data.results || [])) {
    // Skip the listing itself.
    if ((item.url || "").split("?")[0] === currentUrl) continue;
    if (!/carousell\.sg\/p\//i.test(item.url || "")) continue;

    const text = item.text || "";
    const match = text.match(priceRe);
    const price = match ? `S$${match[2]}` : null;

    alternatives.push({
      title: item.title || "Listing",
      url: item.url,
      price,
      image: item.image || null,
    });

    if (alternatives.length >= 3) break;
  }

  return alternatives;
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

  let alternatives = [];
  if (base.verdict === "CAUTION" || base.verdict === "SCAM") {
    try {
      alternatives = await runAlternativesSearch(listing, keys.exa);
    } catch (err) {
      console.warn("SafeSell: alternatives search failed:", err);
    }
  }

  return {
    ...base,
    alternatives,
    imageCheck: imageResult,
    exaAvailable: exaOutcome.status === "fulfilled",
    imageAvailable: imageOutcome.status === "fulfilled",
    aiAvailable: !!verdict,
  };
}

// ---------------------------------------------------------------------------
// Comprehensive seller report (on-demand)
// ---------------------------------------------------------------------------

// Strip a fetched HTML document down to readable text + any embedded review
// data. Service workers have no DOM parser, so we do this with regex.
function htmlToText(html) {
  if (!html) return "";
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

// Try to pull embedded JSON state (e.g. __NEXT_DATA__ / window.__data) that
// often contains structured review info on SPA pages.
function extractEmbeddedJsonText(html) {
  if (!html) return "";
  const blobs = [];
  const nextData = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextData) blobs.push(nextData[1]);
  const stateAssign = html.match(
    /window\.__(?:NUXT|INITIAL_STATE|data|APOLLO_STATE)__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i
  );
  if (stateAssign) blobs.push(stateAssign[1]);
  // Keep only review-relevant slices to stay within token budget.
  const joined = blobs.join(" ");
  if (!joined) return "";
  const reviewBits = joined.match(/[^{}]*review[^{}]{0,400}/gi) || [];
  return reviewBits.slice(0, 40).join(" ").slice(0, 6000);
}

async function fetchSellerProfile(listing) {
  const candidates = [];
  if (listing.sellerProfileUrl) {
    candidates.push(listing.sellerProfileUrl);
    const base = listing.sellerProfileUrl.replace(/\/$/, "");
    candidates.push(`${base}/reviews/`);
  }
  if (!candidates.length) return { pageText: "", reviewData: "" };

  let pageText = "";
  let reviewData = "";
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { "Accept": "text/html" },
      });
      if (!res.ok) continue;
      const html = await res.text();
      reviewData += " " + extractEmbeddedJsonText(html);
      pageText += " " + htmlToText(html).slice(0, 8000);
    } catch (err) {
      console.warn("SafeSell: profile fetch failed for", url, err);
    }
  }
  return {
    pageText: pageText.trim().slice(0, 10000),
    reviewData: reviewData.trim().slice(0, 6000),
  };
}

// Dedicated Exa search focused on seller reviews / reputation.
async function exaSellerIntel(listing, exaKey) {
  if (!exaKey) throw new Error("Missing Exa API key");
  const res = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": exaKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `${listing.sellerUsername || "seller"} Carousell reviews reputation scam complaints Singapore`,
      numResults: 6,
      useAutoprompt: true,
      contents: { text: true },
    }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const results = (data && data.results) || [];
  if (!results.length) return "No relevant web results found.";
  return results
    .slice(0, 6)
    .map((item, i) => {
      const title = item.title || "Untitled";
      const text = (item.text || "").replace(/\s+/g, " ").trim().slice(0, 320);
      return `${i + 1}. ${title}${text ? ` — ${text}` : ""}`;
    })
    .join("\n");
}

// Map the listing verdict (the number shown in the sidebar) to a seller
// trust level so the two views can never contradict each other.
// NOTE: score is a TRUST/SAFETY score — higher is better (100 = safe, 0 = scam).
function scoreOf(verdict) {
  if (!verdict) return null;
  if (Number.isFinite(verdict.score)) return Math.max(0, Math.min(100, verdict.score));
  if (verdict.verdict === "SCAM") return 15;
  if (verdict.verdict === "SAFE") return 85;
  if (verdict.verdict === "CAUTION") return 50;
  return null;
}
// Thresholds mirror the sidebar badge (>=65 safe/green, 40-64 caution/amber, <40 scam/red).
function trustFromScore(score) {
  if (score == null) return null;
  if (score >= 65) return "trusted";
  if (score >= 40) return "mixed";
  return "risky";
}

async function sellerReportOpenAI(listing, profile, exaIntel, openaiKey, verdict, footprintCandidates) {
  if (!openaiKey) throw new Error("Missing OpenAI API key");

  const footprintBlock =
    footprintCandidates && footprintCandidates.length
      ? footprintCandidates
          .map((c, i) => `${i + 1}. [${c.platform}] ${c.url}${c.snippet ? ` — ${c.snippet}` : ""} (via ${c.source})`)
          .join("\n")
      : "No candidate profiles were found on other platforms.";

  const vScore = scoreOf(verdict);
  const forcedTrust = trustFromScore(vScore);
  const verdictContext =
    vScore != null
      ? `\nALREADY-COMPUTED LISTING VERDICT (you MUST stay consistent with this):
Overall verdict: ${verdict.verdict} — trust/safety score ${vScore}/100 (higher = safer; 100 = very safe, 0 = scam)
Seller risk: ${verdict.sellerRisk || "unknown"}, Image risk: ${verdict.imageRisk || "unknown"}
Set "trustLevel" to "${forcedTrust}" and make your headline/assessment consistent with this. Only call the seller "trusted" when the score is 65+; if the score is below 40, treat them as risky.\n`
      : "";

  const systemPrompt =
    "You are a scam-detection and marketplace-trust analyst for Carousell, a major Southeast Asian marketplace. " +
    "You write clear, specific, evidence-grounded seller reports for buyers. " +
    "Only state trends that are supported by the provided review text, profile data, or web intelligence. " +
    "If evidence is thin, say so honestly rather than inventing details. Return ONLY valid JSON.";

  const reviewMaterial = [
    listing.reviewSnippets && listing.reviewSnippets.length
      ? "Review snippets from the listing page:\n- " + listing.reviewSnippets.join("\n- ")
      : "",
    profile.reviewData ? "Structured review data from profile page:\n" + profile.reviewData : "",
    profile.pageText ? "Seller profile page text:\n" + profile.pageText : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12000) || "No on-page review text could be retrieved.";

  const userPrompt = `Produce a comprehensive trust report on this Carousell seller. Return ONLY the JSON object described at the end.
${verdictContext}
SELLER:
Username: ${listing.sellerUsername || "unknown"}
Joined: ${listing.sellerJoinDate || "unknown"}
Reviews count: ${listing.sellerReviews || "unknown"}
Star rating: ${listing.sellerRating || "unknown"}
Profile URL: ${listing.sellerProfileUrl || "unknown"}

CURRENT LISTING (for context):
Title: ${listing.title}
Price: ${listing.price}
Condition: ${listing.condition}

REVIEW & PROFILE MATERIAL:
${reviewMaterial}

WEB INTELLIGENCE (Exa search on this seller):
${exaIntel || "No web intelligence available."}

CANDIDATE PROFILES ON OTHER PLATFORMS (found by searching the seller's handle/name — may include false matches for common names):
${footprintBlock}

For "webPresence": decide which candidate profiles plausibly belong to THIS seller (same name/handle, consistent location like Singapore, or matching niche such as the listing's product type). Assign a confidence to each. A consistent presence across multiple platforms is a mild positive credibility signal; absence is NOT itself suspicious (many legitimate people are private). Never let web presence alone mark someone as a scam.

Return ONLY this JSON structure, no other text:
{
  "headline": "<one-sentence overall take on this seller>",
  "trustLevel": "trusted" | "mixed" | "risky" | "unknown",
  "activity": "<2-4 sentences on seller activity & history: how long active, how established, listing/transaction activity, responsiveness if known>",
  "assessment": "<2-4 sentences explaining specifically WHY this seller is considered good or bad, grounded in the evidence>",
  "reviewTrends": {
    "summary": "<1 short sentence summary of what buyers commonly say>",
    "positives": [{ "label": "<2-4 word theme, e.g. 'Fast delivery'>", "detail": "<short supporting phrase>" }],
    "complaints": [{ "label": "<2-4 word theme, e.g. 'Slow replies'>", "detail": "<short supporting phrase>" }]
  },
  "webIntel": "<1-2 sentences summarizing notable online mentions, scam reports, or 'No notable mentions found online.'>",
  "redFlags": [{ "label": "<2-5 word red flag>", "detail": "<short supporting phrase>" }],
  "safetyTips": [{ "label": "<2-5 word tip>", "detail": "<short supporting phrase>" }],
  "webPresence": {
    "identitySignal": "strong" | "some" | "weak" | "none",
    "summary": "<1 short sentence on the seller's cross-platform presence>",
    "platforms": [
      { "platform": "instagram|linkedin|twitter|tiktok|facebook|github|marketplace|website", "url": "<profile url>", "confidence": "high" | "medium" | "low", "note": "<why it likely matches this seller>" }
    ]
  },
  "evidenceQuality": "strong" | "moderate" | "weak"
}

Keep every "label" to 2-5 words so it can be shown as an icon tile. Put any longer explanation in "detail". Return [] for any list with no evidence.`;

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseVerdict(data?.choices?.[0]?.message?.content || "");
}

// ---------------------------------------------------------------------------
// Digital footprint — does this seller's identity exist on other platforms?
// A consistent cross-platform presence is a soft credibility signal.
// ---------------------------------------------------------------------------

// Classify a URL into a known platform bucket (or null if irrelevant).
function classifyPlatform(url) {
  const u = (url || "").toLowerCase();
  if (/(^|\.)instagram\.com\//.test(u)) return "instagram";
  if (/(^|\.)linkedin\.com\/(in|pub|company)\//.test(u)) return "linkedin";
  if (/(^|\.)(twitter|x)\.com\//.test(u)) return "twitter";
  if (/(^|\.)tiktok\.com\//.test(u)) return "tiktok";
  if (/(^|\.)facebook\.com\//.test(u)) return "facebook";
  if (/(^|\.)github\.com\//.test(u)) return "github";
  if (/(^|\.)(depop|etsy|ebay|shopee|mercari|poshmark|grailed|reverb|vinted)\./.test(u))
    return "marketplace";
  return null;
}

// Pull profile-ish links out of a search engine result set.
function harvestLinks(items, getUrl, getSnippet) {
  const out = [];
  for (const it of items || []) {
    const url = getUrl(it);
    if (!url) continue;
    const platform = classifyPlatform(url);
    if (!platform) continue;
    out.push({ platform, url, snippet: (getSnippet(it) || "").slice(0, 200), source: "search" });
  }
  return out;
}

async function serpFootprint(handle, name, serpKey) {
  if (!serpKey) throw new Error("Missing SerpAPI key");
  const queries = [];
  if (name) queries.push(`"${name}" (instagram OR linkedin OR tiktok OR twitter OR facebook OR depop OR etsy)`);
  if (handle && handle !== name) queries.push(`"${handle}" profile`);
  if (!queries.length) return [];

  const runs = await Promise.allSettled(
    queries.map((q) =>
      fetchWithTimeout(
        `https://serpapi.com/search.json?engine=google&num=20&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(serpKey)}`
      ).then(async (r) => {
        if (!r.ok) throw new Error(`SerpAPI ${r.status}`);
        return r.json();
      })
    )
  );

  const links = [];
  for (const run of runs) {
    if (run.status !== "fulfilled") continue;
    links.push(
      ...harvestLinks(run.value.organic_results, (it) => it.link, (it) => it.snippet)
    );
  }
  return links;
}

async function exaFootprint(handle, name, exaKey) {
  if (!exaKey) throw new Error("Missing Exa API key");
  const query = `${name || ""} ${handle || ""} social media profile (instagram linkedin tiktok twitter)`.trim();
  const res = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": exaKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: 10, useAutoprompt: true, contents: { text: true } }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const data = await res.json();
  return harvestLinks(
    data.results,
    (it) => it.url,
    (it) => (it.text || it.title || "")
  );
}

// Direct probe: GitHub's public API is bot-friendly and gives a clean signal.
async function githubProbe(handle) {
  if (!handle) return null;
  const clean = handle.replace(/[^a-zA-Z0-9-]/g, "");
  if (!clean) return null;
  const res = await fetchWithTimeout(`https://api.github.com/users/${encodeURIComponent(clean)}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return {
    platform: "github",
    url: data.html_url,
    snippet: [data.name, data.bio, data.location].filter(Boolean).join(" · ").slice(0, 200),
    source: "direct",
  };
}

// Direct probe: Instagram still exposes og:title (name + @handle) on public
// profile pages even behind the login wall. Best-effort — may be rate-limited.
async function instagramProbe(handle) {
  if (!handle) return null;
  const clean = handle.replace(/[^a-zA-Z0-9._]/g, "");
  if (!clean) return null;
  try {
    const res = await fetchWithTimeout(`https://www.instagram.com/${encodeURIComponent(clean)}/`, {
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (!og) return null;
    return {
      platform: "instagram",
      url: `https://www.instagram.com/${clean}/`,
      snippet: og[1].slice(0, 200),
      source: "direct",
    };
  } catch (e) {
    return null;
  }
}

async function collectFootprint(listing, keys) {
  const handle = (listing.sellerUsername || "").trim();
  const name = (listing.sellerUsername || "").trim(); // display name == username on listing
  if (!handle && !name) return [];

  const outcomes = await Promise.allSettled([
    serpFootprint(handle, name, keys.serp),
    exaFootprint(handle, name, keys.exa),
    githubProbe(handle),
    instagramProbe(handle),
  ]);

  const candidates = [];
  for (const o of outcomes) {
    if (o.status !== "fulfilled" || !o.value) continue;
    if (Array.isArray(o.value)) candidates.push(...o.value);
    else candidates.push(o.value);
  }

  // Dedupe by platform+url, prefer direct probes over search hits.
  const seen = new Map();
  for (const c of candidates) {
    const key = `${c.platform}|${c.url}`;
    if (!seen.has(key) || c.source === "direct") seen.set(key, c);
  }
  return Array.from(seen.values()).slice(0, 25);
}

async function generateSellerReport(listing, verdict) {
  const keys = await getKeys();

  // Profile fetch + Exa intel + cross-platform footprint all run in parallel;
  // each may fail independently.
  const [profileOutcome, exaOutcome, footprintOutcome] = await Promise.allSettled([
    fetchSellerProfile(listing),
    exaSellerIntel(listing, keys.exa),
    collectFootprint(listing, keys),
  ]);

  const footprintCandidates =
    footprintOutcome.status === "fulfilled" ? footprintOutcome.value : [];
  if (footprintOutcome.status === "rejected")
    console.warn("SafeSell: footprint collection failed:", footprintOutcome.reason);

  const profile =
    profileOutcome.status === "fulfilled"
      ? profileOutcome.value
      : { pageText: "", reviewData: "" };
  const exaIntel = exaOutcome.status === "fulfilled" ? exaOutcome.value : "";

  if (profileOutcome.status === "rejected")
    console.warn("SafeSell: profile fetch failed:", profileOutcome.reason);
  if (exaOutcome.status === "rejected")
    console.warn("SafeSell: seller Exa failed:", exaOutcome.reason);

  const report = await sellerReportOpenAI(
    listing,
    profile,
    exaIntel,
    keys.openai,
    verdict,
    footprintCandidates
  );

  // Force the trust level to agree with the sidebar verdict when we have one,
  // so the two views never show conflicting seller statuses.
  const vScore = scoreOf(verdict);
  const forcedTrust = trustFromScore(vScore);

  return {
    ...report,
    trustLevel: forcedTrust || report.trustLevel || "unknown",
    score: vScore,
    verdict: verdict ? verdict.verdict : undefined,
    sellerUsername: listing.sellerUsername,
    sellerRating: listing.sellerRating,
    sellerReviews: listing.sellerReviews,
    sellerJoinDate: listing.sellerJoinDate,
    sellerProfileUrl: listing.sellerProfileUrl,
    sources: {
      profilePage: profileOutcome.status === "fulfilled" && !!profile.pageText,
      webSearch: exaOutcome.status === "fulfilled",
      footprint: footprintOutcome.status === "fulfilled" && footprintCandidates.length > 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (message?.type === "ANALYZE_LISTING") {
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
    return true; // async response
  }

  // Store the listing and open the standalone report page in a new tab.
  if (message?.type === "OPEN_REPORT_TAB") {
    console.debug("[SafeSell] bg: OPEN_REPORT_TAB received");
    chrome.storage.local.set(
      {
        safesell_report_listing: {
          listing: message.data,
          verdict: message.verdict || null,
          ts: Date.now(),
        },
      },
      () => {
        const url = chrome.runtime.getURL("report.html");
        chrome.tabs.create({ url }, (tab) => {
          if (chrome.runtime.lastError) {
            console.error("[SafeSell] bg: tabs.create failed:", chrome.runtime.lastError.message);
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            console.debug("[SafeSell] bg: opened report tab", tab && tab.id, url);
            sendResponse({ ok: true, tabId: tab && tab.id });
          }
        });
      }
    );
    return true; // async response
  }

  // Generate the seller report and return it directly to the caller (the
  // report tab uses the sendResponse callback).
  if (message?.type === "SELLER_REPORT") {
    generateSellerReport(message.data, message.verdict)
      .then((report) => sendResponse({ ok: true, report }))
      .catch((err) => {
        console.error("SafeSell: seller report failed:", err);
        sendResponse({ ok: true, report: { error: String(err) } });
      });
    return true; // async response
  }
});
