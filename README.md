# SafeSell

A Chrome extension (Manifest V3) that detects scam listings on **Carousell**. When you open a Carousell listing page, SafeSell scrapes the page, runs a multi-signal scam analysis, and shows a verdict in a sidebar injected into the page.

## How it works

Three signals run in the background service worker and are merged into one verdict:

1. **Exa** — semantic web search for seller reputation and listing/scam reports.
2. **SerpAPI** — Google reverse image search to detect stolen / stock listing photos.
3. **OpenAI (GPT-4o-mini)** — reasons over the listing, the Exa results, and the image findings to produce a structured JSON verdict.

The sidebar shows a color-coded verdict:

- 🟢 **LIKELY SAFE** — score 0–39
- 🟡 **CAUTION** — score 40–69
- 🔴 **LIKELY SCAM** — score 70–100

### Full seller report

From the verdict, click **"View full seller report"** to open a dedicated, full-width report page in a **new browser tab** (cleaner than the cramped 340px sidebar). It is generated **on demand** and is laid out **pictorially** — review trends, red flags, and safety tips are shown as icon tiles (e.g. 🚚 Fast delivery, ✨ Good quality) rather than long paragraphs. It covers:

- **Hero** — seller name, a Trusted / Mixed / Risky badge, one-line headline, and stat tiles (rating, reviews, joined, evidence quality)
- **What buyers love** / **Common complaints** — icon tiles summarizing review trends
- **Red flags** and **How to stay safe** — icon tiles
- **Seller activity & history** and **Why this rating** — short narrative cards
- **Web intelligence** — online mentions / scam reports (Exa), with a link to the seller's profile

The report combines two data sources: the background worker fetches the seller's Carousell profile/reviews page (extracting review text where available) **and** runs a dedicated Exa web search, then OpenAI synthesizes the structured report. It only states trends supported by retrieved evidence and reports its own evidence quality.

> The report opens via `report.html` (a standalone extension page). The clicked listing is passed through `chrome.storage.local`, and the page renders once the background worker returns the synthesized report.

## Project layout

```
safesell/
├── manifest.json     # MV3 config: permissions, host perms, CSP
├── background.js     # service worker — all API calls (Exa, SerpAPI, OpenAI)
├── content.js        # scrapes the listing DOM, injects the sidebar, SPA handling
├── sidebar.html      # sidebar UI markup (loading / verdict / error states)
├── sidebar.css       # sidebar styles
├── sidebar.js        # sidebar UI logic
├── options.html      # settings page to store API keys
├── options.js        # options logic
└── icons/icon128.png # toolbar icon
```

## API keys (required)

The extension needs **three** keys to run the full analysis:

| Service | Used for | Get a key |
|---|---|---|
| OpenAI | GPT-4o-mini reasoning | https://platform.openai.com/api-keys |
| Exa | Semantic web search | https://dashboard.exa.ai |
| SerpAPI | Reverse image search | https://serpapi.com/manage-api-key |

You can provide the keys in **either** of two ways:

- **Recommended — Options page (no code edits):** after loading the extension, right-click the SafeSell toolbar icon → *Options* (or go to `chrome://extensions` → SafeSell → *Details* → *Extension options*). Paste the keys and click **Save**. They are stored in `chrome.storage.local`.
- **Or hard-code them:** edit the constants at the top of `safesell/background.js`. Keys saved from the Options page always take precedence over these constants.

> Note: each check fails gracefully on its own. If you only supply an OpenAI key, you'll still get a verdict — just without the web-search and image signals (the sidebar shows a "partial result" note). If all three checks fail, the sidebar shows an error state.

## Loading the extension

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `safesell/` folder.
4. Open the Options page and paste your API keys (see above).
5. Visit any Carousell listing, e.g. `https://www.carousell.com/p/<some-listing>`. The sidebar appears with a loading spinner, then the verdict.

## Notes & limitations

- **Carousell is a SPA.** SafeSell re-runs analysis on in-app navigation (patched `pushState`/`replaceState`, `popstate`, and a `MutationObserver`).
- **Dynamic / hashed class names.** Carousell ships obfuscated CSS classes that change between builds, so `content.js` scrapes using semantic structure (`h1`, currency/text anchors, image heuristics, regex over visible text) rather than brittle class selectors. If Carousell changes its markup and fields come back empty, update the heuristics in `content.js` (`scrapeListing` and its helpers).
- **CORS.** All network requests are made from `background.js`; the content script never calls the APIs directly.
- **Costs.** Exa, SerpAPI, and OpenAI calls are billable. Analysis runs once per unique listing view (de-duplicated per URL + title + price).
```
