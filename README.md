# SafeOrScam (SoS)

> A Chrome extension that tells you whether a Carousell listing is **safe or a scam** — before you pay — by combining semantic web search, reverse image search, and LLM reasoning into a single trust verdict.

---

## Motivation

Second-hand marketplaces like Carousell are where millions of people in Southeast Asia buy and sell. They're also where scammers thrive: stolen product photos, prices that are too good to be true, brand-new "ghost" accounts, and chats that quietly steer you off-platform to an "easy bank transfer." The signals that an experienced buyer learns to spot — *is this photo reused? is this price realistic? does this seller exist anywhere else online?* — take time, multiple browser tabs, and a healthy dose of paranoia to check.

Most people don't do that work. They see a good deal, they pay, and they get burned.

## Aim

**SafeOrScam does the paranoid due-diligence for you, automatically, the moment you open a listing.** It reads the listing, searches the open web for the seller's reputation and the item's real market price, reverse-searches the photos to catch stolen or stock images, and feeds all of it to an LLM that returns a plain-English verdict and a 0–100 trust score. No new app, no copy-pasting — it lives in a sidebar right on the Carousell page you're already looking at.

---

## How it works

SafeOrScam is a Manifest V3 Chrome extension. When you open a listing (`carousell.sg/p/...`), a content script scrapes the listing and seller details and hands them to a background service worker that orchestrates a multi-engine analysis:

| Step | Engine | What it does |
|------|--------|--------------|
| **1. Reputation & price grounding** | **Exa** | Runs parallel semantic searches for the seller's profile, scam/fraud complaints, listing-level scam reports, and the item's *real* market price across the web. |
| **2. Image provenance** | **SerpAPI** | Google reverse-image-searches the first listing photo to detect stock-photo sites and images reused on other listings. |
| **3. Reasoning & verdict** | **OpenAI (GPT-4o-mini)** | Synthesizes everything above into a structured JSON verdict — `SAFE` / `CAUTION` / `SCAM`, a 0–100 trust score, and specific, human-readable reasons covering seller, price, listing quality, and images. |
| **4. Cheaper & safer alternatives** | **Exa** | If the verdict is `CAUTION` or `SCAM`, Exa surfaces comparable, more trustworthy listings so you're not left empty-handed. |

On top of the per-listing verdict, SoS adds four more surfaces:

- **Search-page badges** — a coloured safety dot is injected onto every card in Carousell search results, so risky listings are flagged before you even click in (cached for 30 minutes to stay fast and cheap).
- **Chat red-flag monitor** — while you're chatting with a seller, new messages are quietly checked by OpenAI for classic scam patterns (off-platform payment, urgency, "send deposit first") and a warning banner appears if something looks off.
- **Comprehensive seller report** — an on-demand deep dive that fetches the seller's profile, runs dedicated Exa reputation intelligence, and builds a **cross-platform digital footprint** (Instagram, GitHub, LinkedIn, etc.) using SerpAPI + Exa + direct GitHub and Instagram profile probes. A real seller usually has a verifiable presence; a scammer usually doesn't.
- **Community votes** — buyers can sign in (Google OAuth) and vote on listings, with verdicts stored in **Supabase** so the community's experience compounds over time.

---

## Tech stack

SafeOrScam is deliberately framework-free — vanilla JS, HTML, and CSS in a Manifest V3 extension — so the intelligence lives in the APIs, not in a heavy client.

**Sponsor tech (used centrally, not bolted on):**

- **OpenAI API (GPT-4o-mini)** — the reasoning core. It's not a thin wrapper around a chat box: it's given a carefully engineered scoring rubric and the *fused output* of web search and image forensics, and it returns strict structured JSON that drives the entire UI (verdict, score, gauge, reasons, scam type, per-dimension risk). The same model powers the chat red-flag monitor and the narrative seller report.
- **Exa API** — semantic/neural web search is what makes the verdict *grounded in reality* rather than vibes. Exa is used in four distinct roles: seller reputation, scam-report discovery, **live market-price grounding** (so "30% below market" is a fact, not a guess), and surfacing safer alternative listings. Exa also drives the cross-platform footprint search in the seller report.
- **Cursor** — the entire extension was built in Cursor. The MV3 service-worker architecture (no DOM, regex-based HTML parsing, CORS-safe network isolation, PKCE OAuth in a background worker) is fiddly, multi-file plumbing; Cursor's agentic editing was used to scaffold, refactor across files, and debug the message-passing between content scripts, the sidebar iframe, and the worker.

**Supporting infrastructure:**

- **SerpAPI** — Google reverse image search for photo provenance, plus an extra search lane for the seller's cross-platform footprint.
- **Supabase** — Postgres + Auth backing the community-vote layer and Google OAuth sign-in (via a minimal REST client, since the full SDK doesn't run in MV3 service workers).

---

## Problem fit & market value

**The problem is real, large, and growing.** Online marketplace fraud is one of the most common forms of consumer scam, and second-hand platforms like Carousell are a prime target precisely because transactions happen peer-to-peer, payment often moves off-platform, and there's no built-in identity guarantee. The victims aren't careless — they're ordinary buyers who saw a fair-looking deal and had no fast way to check it. The user is anyone about to transfer money to a stranger, which is a huge and clearly-defined audience.

**SoS attacks the problem at the exact moment of risk.** Most anti-scam advice ("check reviews," "reverse-search the photo," "be wary of low prices") is sound but never gets done, because doing it means opening five tabs and knowing what to look for. SoS collapses all of that into a verdict that appears automatically, in context, the instant you open a listing — turning expert-level due diligence into something that requires zero effort and zero expertise from the buyer.

**It targets the specific mechanics scammers rely on.** Rather than a generic "looks sketchy" guess, each surface of the extension counters a concrete fraud tactic:

- **Stolen / stock photos** — reverse image search flags images reused from other listings or lifted from stock sites.
- **Too-good-to-be-true pricing** — live market-price grounding means "30% below market" is established from real web data, not assumed.
- **Ghost / throwaway accounts** — the cross-platform footprint check asks whether the seller exists anywhere else online; genuine sellers usually leave a verifiable trail, scammers usually don't.
- **Off-platform payment pressure** — the chat monitor watches for the classic "pay a deposit first / let's move to bank transfer" patterns and warns before money moves.
- **Known bad actors** — Exa surfaces existing scam and fraud reports tied to the seller or listing.

**It's built for public good and gets stronger at scale.** The protection is free at the point of use and arrives before a payment is made, where it can actually prevent harm. The community-vote layer means every buyer's experience compounds into a shared signal — the more people use it, the better the warnings get. And it's commercially durable: a freemium model (free verdicts, paid deep seller reports or higher limits) or a B2B trust-API that marketplaces embed natively are both natural paths beyond the extension itself.

---

## Setup

SafeOrScam is loaded as an **unpacked extension** in Chrome. You will need to supply your own **OpenAI, Exa, and SerpAPI keys** via the Options page before the analysis will run.

### 1. Get the code

Download / clone this repo. The extension itself lives in the **`safesell/`** folder — that's the folder you'll load into Chrome.

### 2. Load the extension into Chrome

1. Open Chrome and navigate to **`chrome://extensions`**.
2. Toggle **Developer mode** **ON** (top-right corner).
3. Click **Load unpacked**.
4. In the folder picker, select the **`safesell/`** folder (the one containing `manifest.json`) and click **Select / Open**.
5. SafeOrScam now appears in your extensions list. Pin it for convenience.

### 3. Add your API keys

Open the SafeOrScam **Options** page — on the card in `chrome://extensions`, click **Details → Extension options**, or right-click the pinned icon → **Options** — paste your **OpenAI**, **Exa**, and **SerpAPI** keys, and click **Save keys**. Keys are stored locally in `chrome.storage.local` and are only ever sent to their respective provider APIs.

| Key | Where to get one | Used for |
|-----|-----------------|----------|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | GPT-4o-mini reasoning, chat monitor, seller report |
| **Exa** | [dashboard.exa.ai/api-keys](https://dashboard.exa.ai) | Semantic web search, price grounding, footprint |
| **SerpAPI** | [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key) | Reverse image search, footprint search |

### 4. Try it

Open any Carousell listing (a URL with `/p/` in it, e.g. `https://www.carousell.sg/p/...`). Within a couple of seconds the SafeOrScam sidebar slides in from the right with the trust gauge and verdict.

If the sidebar doesn't appear, try refreshing the page and waiting 5 seconds — it should pop up.

### (Optional) Community votes via Supabase

The community-vote and Google sign-in features use Supabase. A demo project is pre-wired in `supabase-client.js`. To point it at your own project, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (in the file or via `chrome.storage.local`) and allowlist the extension's OAuth redirect URL in **Supabase → Auth → URL Configuration → Redirect URLs** (the exact value is logged to the service-worker console when you attempt sign-in).

---

## Troubleshooting

**The sidebar doesn't pop up on a listing page.**
This is almost always caused by **multiple Carousell tabs open at once**. Close all other active Carousell tabs, keep only the listing you want analysed, and reload the page. The sidebar should appear.

**"Extension context invalidated" errors / nothing reacts after I reloaded the extension.**
Whenever you reload or update the extension from `chrome://extensions`, any Carousell tabs that were already open are running the *old* content script. **Refresh those tabs** to re-inject the current version.

**The verdict shows "UNAVAILABLE" or seems thin.**
One or more API calls failed. Open the service-worker console (`chrome://extensions` → SafeOrScam → **Inspect views: service worker**) to see which provider returned an error. The pipeline is resilient — if only one engine fails you'll still get a partial verdict, and "UNAVAILABLE" only appears if all of them fail at once.

**Reverse image search returns nothing.**
SerpAPI needs the listing's first image URL to be publicly fetchable. Some listings hot-link images that block external access; in that case the image check is skipped and the verdict relies on the Exa + OpenAI signals only.

**Search-page badges aren't appearing.**
Badges only run on Carousell search/browse pages (not listing pages), and they require valid keys. Results are cached for 30 minutes per listing, so after the first pass they load instantly; a hard refresh re-checks.

**Google sign-in fails with "Authorization page could not be loaded."**
The extension's OAuth redirect URL isn't allowlisted in Supabase, **or** the unpacked extension ID changed (this happens if you reload from a different folder path). The exact redirect URL to allowlist is printed to the service-worker console when you click sign-in — copy that value into **Supabase → Auth → URL Configuration → Redirect URLs**.

**The chat red-flag banner never shows.**
It only activates on Carousell chat pages (`/chat/...`) and only fires when new messages contain scam-like patterns. No banner means nothing suspicious was detected.

---

## Project structure

```
safesell/
├── manifest.json          # MV3 config, permissions, content-script matches
├── background.js          # Service worker: orchestrates Exa + SerpAPI + OpenAI
├── content.js             # Scrapes listing pages, injects the sidebar iframe
├── sidebar.html/.css/.js  # The verdict sidebar UI (gauge, reasons, alternatives)
├── search-badges.js       # Safety dots on search-result cards
├── chat-monitor.js        # Red-flag detection in Carousell chat
├── report.html/.css/.js   # Full seller trust report + digital footprint
├── supabase-client.js     # Minimal Supabase REST client (auth + votes)
├── options.html/.js        # API-key settings page
├── onboarding.html/.js    # First-run welcome
└── icons/
```

---

*SafeOrScam — check before you pay.*
