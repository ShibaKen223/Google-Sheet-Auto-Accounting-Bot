# Personal Spend Analytics Dashboard
## 個人支出分析儀表板 — A Procurement-Style Spend Analytics Toolkit

![Status](https://img.shields.io/badge/status-live-success)
![Stack](https://img.shields.io/badge/built_with-Google_Apps_Script-blue)
![Result](https://img.shields.io/badge/unclassified_spend-37%25→7.2%25-brightgreen)
![Version](https://img.shields.io/badge/version-4.2-informational)
![Tests](https://img.shields.io/badge/tests-16_passing-success)

A personal expense tracker built in **Google Apps Script**, designed around corporate procurement analytics concepts. Auto-classifies transactions from credit-card emails, detects spend anomalies, analyzes vendor concentration (Pareto), and tracks MoM / YoY trends — all rendered into a single Google Sheets dashboard.

> **中文導讀**
> 一個用 Google Apps Script 寫的個人記帳工具,設計上刻意對應**企業採購 (Procurement) 的支出分析框架** — 自動分類、異常偵測、供應商集中度、月增率/年增率追蹤。所有功能整合在 Google Sheets 戰情室 (War Room) 一頁中。

---

## 📌 Why This Project / 為什麼做這個

Tracking personal expenses is a solved problem. **Reframing the same data through the lens of how a procurement team analyzes corporate spend is not.**

The technical infrastructure is identical — transactions in, structured analytics out — but the framing forces design decisions that mirror what a real Procure-to-Pay (P2P) system needs to handle: classification taxonomy, tail spend governance, vendor concentration risk, anomaly detection, and trend monitoring.

> **中文重點:**這個專案技術核心很簡單,真正有趣的是把同一份資料用「採購支出分析」的視角重新設計。每一個功能都對應企業 P2P 系統的標配 — 分類治理、長尾支出、供應商集中度、異常偵測、趨勢監控。

---

## 🎯 Procurement Concept Mapping

| Personal Finance Feature | Corporate Procurement Concept |
|---|---|
| Email auto-parsing → row insertion | Invoice ingestion in P2P system |
| 13-category keyword taxonomy | Category Management / Spend Cube |
| "Unclassified" bucket diagnostic | Tail Spend Analysis |
| Top 20% merchant analysis | Vendor Concentration / Supplier Rationalization |
| μ + 2σ outlier flagging | Spend Variance Alert / Anomaly Detection |
| MoM / YoY % change | Spend Trend Analysis |
| Re-classification tool for historical rows | Spend Cube Re-mapping after taxonomy update |

---

## 🚀 Key Features

### 1. Auto-Classification Engine
Parses Gmail for credit-card consolidated statements, extracts each transaction (date, amount, merchant), and assigns it to one of 13 categories using a keyword dictionary. Includes full-width-to-half-width normalization and quote/apostrophe stripping to handle real-world merchant name inconsistencies (e.g., `ＩＫＥＡ` → `IKEA`, `T\`WAY` → `TWAY`).

### 2. Spend Variance Alert
For each category-month, calculates μ + 2σ from that category's own historical pattern. Months exceeding the threshold are auto-highlighted in red. Statistically, this flags the top ~2.5% most extreme months — the ones a procurement reviewer would want to investigate.

Uses the sample standard deviation (n−1) and only activates once a category has at least 6 months of data (avoids small-sample false positives).

### 3. Pareto / Vendor Concentration
Computes what percentage of total spend the **top 20% of merchants** account for. In healthy procurement, this number tends toward 80% (classic Pareto). Lists the top 5 merchants with cumulative spend.

### 4. MoM / YoY Trend Tracking
Two rows under the spend matrix:
- **MoM** (Month-over-Month): captures recent shifts, but inflated by seasonality.
- **YoY** (Year-over-Year): cancels out seasonality, surfaces structural changes.

Together they let you distinguish "December is high because December is always high" from "December is genuinely escalating year over year."

### 5. Tail Spend Diagnostic
A dedicated tool that scans all unclassified transactions, ranks them by cumulative spend, and overlays a Pareto 80%-cumulative line. Tells you exactly which merchants to add to the keyword dictionary to maximize coverage gain per keyword added.

### 6. Historical Re-classification
When the taxonomy is updated, a one-click tool re-runs classification across all historical rows. Includes dry-run preview + confirmation dialog before any data is overwritten. The corporate-procurement equivalent is **Spend Cube re-mapping** after a category-taxonomy revision.

### 7. No-Code Taxonomy Overrides (V4.2)
A `📖 分類覆寫` sheet lets you add `merchant keyword → category` rules directly in the spreadsheet. Override rules are checked before the code-level keyword dictionary, so the Tail Spend Diagnostic → fix → re-classify loop no longer requires touching the script. The sheet is optional; when absent, behavior is identical to V4.1.

### 8. Ingestion Hardening (V4.1 – V4.2)
- **Idempotent email processing** — processed Gmail message IDs are remembered (ring buffer sized to stay under the Properties Service 9 KB value limit), so an interrupted run never double-books.
- **Concurrency lock** — the Gmail trigger, the iOS webhook and the re-classification tool serialize through `LockService`.
- **Secret hygiene** — the webhook token lives in Script Properties, not in source, so the code can be published as-is.
- **Failed parses are labeled** (`記帳/解析失敗`) instead of staying unread forever and being re-scanned on every run.

---

## 📈 Case Study: 37% → 7.2% Unclassified Spend in 2 Iterations

The most procurement-relevant part of this project isn't the features — it's the **process of using the system to fix itself**.

**Initial state.** After running the Tail Spend Diagnostic for the first time, 37% of total historical spend was sitting in the "Other" bucket. By corporate standards (typical KPI threshold: <5% unclassified), this was a 🔴 severity issue. Worse, the trend was deteriorating: 11% (2023) → 28.7% (2024) → 45.5% (2025) → 49.7% (2026 YTD).

**Root cause analysis.** The diagnostic's Top-30 ranking immediately surfaced three structural issues:
1. **Missing category** — travel & lodging was scattered across hotels, airlines, booking platforms, accounting for ~39% of unclassified spend on its own.
2. **Insufficient keyword depth** — a generic "Investment" category had only one keyword and missed actual investment activity (crypto on-ramps, securities deposits via 臺灣銀行 which were tuition payments).
3. **Encoding mismatch** — credit-card statements rendered some merchants in full-width characters (`ＩＫＥＡ`), but the keyword dictionary used half-width (`IKEA`). String comparison failed silently.

**Iteration 1: Structural fix.** Added 3 new categories (Travel, Insurance, Education), expanded the Investment category, and implemented a Unicode normalizer for full-width → half-width conversion. **Result: 37% → 11.4%.**

**Iteration 2: Long-tail cleanup.** Re-ran the diagnostic on the residual 11.4%. Identified one more silent failure: an apostrophe-encoding mismatch (a Korean airline merchant used backtick `` ` `` instead of straight apostrophe `'`). Generalized the normalizer to strip all quote-character variants. Added ~10 more domain-specific keywords from the new Top-30 list. **Result: 11.4% → 7.2%.**

**Decision to stop.** At 7.2% — within corporate "🟢 Good" range — the remaining tail was confirmed irreducible: one-time international travel merchants, ambiguous merchant codes, and genuinely unknowable transactions. Continuing to expand the dictionary would have entered diminishing returns. **Knowing when to stop is itself a procurement competency** — Pareto governance is about the 80/20, not about chasing 100%.

| Iteration | Unclassified % | Health Rating |
|---|---|---|
| Baseline | 37.0% | 🔴 Severe |
| Iter 1 (taxonomy + Unicode fix) | 11.4% | 🟠 Needs Work |
| Iter 2 (apostrophe fix + long-tail) | **7.2%** | **🟢 Good** |

> **中文重點:**這個專案最有意思的地方不是功能,是用功能反過來修自己。從 37% 未分類降到 7.2% 這一段過程,完整展示了「發現問題 → 拆解根因 → 系統性改善 → 知道何時收手」的迭代邏輯,也是企業採購最看重的能力。

---

## 🏗️ Architecture

```
┌──────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  iOS Shortcut    │     │  Gmail (credit  │     │  Manual Entry    │
│  (HTTP POST)     │     │  card emails)   │     │  (Sheet UI)      │
└────────┬─────────┘     └────────┬────────┘     └────────┬─────────┘
         │                        │                       │
         │   doPost()             │  processEmails()      │
         │                        │                       │
         └────────────────────────┼───────────────────────┘
                                  ▼
                    ┌─────────────────────────────┐
                    │   determineCategory()       │
                    │   • normalize (FW→HW, ‵→‘)  │
                    │   • keyword match           │
                    │   • 13 categories + tail    │
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │   Year Sheets (2023, 2024,  │
                    │   2025, 2026 — auto-created)│
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐
                    │   War Room Dashboard        │
                    │   • Spend Matrix            │
                    │   • Anomalies (red cells)   │
                    │   • MoM / YoY rows          │
                    │   • Category KPIs           │
                    │   • Pareto / Top vendors    │
                    └─────────────────────────────┘
```

---

## 🛠️ Tech Stack

- **Runtime:** Google Apps Script (V8 runtime, JavaScript)
- **Storage:** Google Sheets (one tab per year + a unified dashboard)
- **Inputs:** Gmail API (credit-card consolidation emails) + iOS Shortcuts webhook
- **Outputs:** Conditional formatting, color-coded matrix, dynamic data validation

No external dependencies. No paid APIs. The entire system runs inside the user's Google account.

---

## ⚠️ Limitations & Honest Trade-offs

This is a personal project, not a production system. A few things were intentionally **not** built:

- **No LLM-based classification.** Considered but rejected — the data is structured and the keyword approach is faster, cheaper, and more interpretable for this scale (a few thousand transactions/year). For larger taxonomies (10k+ unique merchants), LLM fallback for keyword-miss cases would make sense.
- **Deduplication is email-level, not transaction-level.** A processed Gmail message is never re-imported, but two different emails listing the same transaction, or an iOS Shortcut tapped twice, will still create duplicate rows. A production system would hash (date, amount, merchant) and reject repeats.
- **Email ingestion depends on the "unread" state.** If you open a statement email on your phone before the trigger runs, it is skipped. A label-based query (`-label:記帳/已處理`) would be more robust; it was not adopted to avoid re-importing history already booked by older versions.
- **No budget vs actual.** Skipped because it requires manual budget input and the case-study value of the existing analytics features was already strong without it.
- **Anomaly detection ignores seasonality.** μ + 2σ uses the full year's history, which means December (or other seasonally-high months) can produce false positives. A production system would compare against same-month-prior-year (a YoY-anchored anomaly detector).

---

## 📷 Screenshots

> Screenshots with **anonymized mock data** are planned for `docs/screenshots/`. Until then, the fastest way to see the dashboard is to follow *Getting Started* on a copy of your own sheet.

---

## 🚀 Getting Started

1. Create a new Google Sheet.
2. **Extensions → Apps Script** → paste the contents of [`Code.gs`](Code.gs).
3. **Project Settings → Script Properties** → add `API_TOKEN` = a long random string (30+ chars). This is what the iOS Shortcut must send as `"token"` in its JSON body. Never put it in the code.
4. Save and reload the sheet.
5. Use the **💰 記帳小幫手** (Expense Helper) menu:
   - `📩 立即抓信` — Pull credit-card emails now
   - `🔄 刷新總戰情室` — Refresh the dashboard
   - `🔍 Tail Spend 診斷` — Run unclassified-spend diagnostic
   - `📖 建立分類覆寫表` — Create the override sheet for no-code taxonomy rules
   - `♻️ 重新分類所有交易` — Re-classify historical rows after taxonomy update

Recommended triggers (Apps Script editor → Triggers):
- `processConsolidatedEmails` — time-driven, every hour or daily
- `updateUnifiedWarRoom` — time-driven, hourly (the iOS webhook writes rows but does not rebuild the dashboard, so the Shortcut returns instantly)

**Upgrading from V4.1:** move your token from `CONFIG.API_TOKEN` into Script Properties and rotate it, since the old value lived in source. Everything else is drop-in.

---

## 🧪 Tests

The pure logic (email parser, normalizer, classifier + override rules, merchant aliasing, spend matrix / MoM / YoY / Pareto / anomaly math) runs locally under Node with stubbed Apps Script services. No dependencies.

```bash
node test/run.js
```

Functions that need live Sheets or Gmail (`doPost`, email fetching, dashboard rendering) are intentionally out of scope for the harness.

---

## 📝 What This Demonstrates

For anyone reading this as part of an application:

- **Domain reframing** — taking a familiar problem (personal finance) and re-architecting it through a different professional lens (procurement analytics).
- **Iterative quantitative improvement** — the 37% → 7.2% case study isn't a "look I built something" story; it's a "look how I diagnosed and fixed it" story.
- **Trade-off literacy** — the *Limitations* section is intentional. Knowing what *not* to build is as important as knowing what to build.
- **End-to-end ownership** — ingestion (Gmail/Shortcuts), processing (classifier, normalizer), analytics (variance, Pareto, trends), presentation (formatted dashboard), and governance (re-classification tool) — all built and integrated.

---

## 🔁 Deploy Workflow (clasp + GitHub Actions)

The Apps Script project is managed with [clasp](https://github.com/google/clasp), so nothing is ever copy-pasted into the online editor.

```text
edit Code.gs  →  node test/run.js  →  git push origin main
                                            │
                          GitHub Actions (.github/workflows/deploy.yml)
                          runs the tests again, then `clasp push -f`
                                            ▼
                                   live Apps Script project
```

Local one-off deploys also work with `clasp push` from the repo root. Only `Code.gs` and `appsscript.json` are pushed; `.claspignore` keeps the test harness and docs out of the script project.

**CI setup (once):** add two repository secrets in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SCRIPT_ID` | the script ID from Apps Script → Project Settings |
| `CLASPRC_JSON` | the full contents of your local `~/.clasprc.json` after `clasp login` |

`.clasp.json` and `.clasprc.json` are git-ignored on purpose. The webhook token lives in Script Properties, so redeploying code never touches it.

---

## 📜 Version History

| Version | Highlights |
|---|---|
| **4.2** | Token moved to Script Properties; fixed processed-ID buffer exceeding the 9 KB Properties limit; cached keyword compilation; `📖 分類覆寫` override sheet; webhook amount validation; Node test harness |
| 4.1 | Webhook token auth; `LockService`; idempotent email processing; failed-parse labeling; full-line merchant capture; expanded dictionary; Pareto merchant aliasing; batch writes; sample-std-dev anomaly detection; annual income/expense block |
| 4.0 | Unified War Room dashboard, Tail Spend diagnostic, re-classification tool |

---

## License

MIT. Take it, fork it, adapt it.
