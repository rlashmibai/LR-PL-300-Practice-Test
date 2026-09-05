// PL-300 Practice Test — local prototype (localStorage-based)
// Data layer is isolated in the DB object so it can be swapped for Firebase later
// without touching the UI/quiz-engine code below.

const SECTION_TEST_MINUTES = 15;
const PASS_PERCENT = 70;
// 12 flat practice tests, each a deterministic mix of all 6 content-source
// modules (50 questions/test once the full 600-question bank is loaded).
const TEST_SET_COUNT = 12;
// 2 min/question (100 minutes for a 50-question test, per the home page's
// pacing description). Applied per-set from each set's actual question count
// so a partially-loaded set isn't over-timed. Only matters for Timed Tests —
// Practice mode uses a count-up timer with no enforced limit.
const TEST_SET_MINUTES_PER_QUESTION = 2;

// Anonymous usage beacons (no login required, no personal data sent). Both
// logTestStart and logHomePageVisit fire a single fire-and-forget beacon to a Google
// Apps Script Web App that appends one row to a private Sheet only the site owner can
// view. Never blocks or delays the page/test if the request fails or is offline.
const TEST_START_LOG_URL = "https://script.google.com/macros/s/AKfycbw9mgiX8xqx6j_1HCg4YuWZGMMkG3cNkkVG9Jlz0D4TZeQzyowrP2XyjayYm50Dxrod/exec";

// Lets the site owner tell their own testing and Claude Code's dev-server testing apart
// from real visitors in the log sheet — never sends an IP or any identifying data for
// anyone. Real visitors get no "source" field at all (this returns undefined, and
// JSON.stringify drops undefined-valued keys entirely).
function beaconSource() {
  const isDevHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (isDevHost) return "claude-dev";
  if (localStorage.getItem("lr_owner_mode") === "1") return "owner";
  return undefined;
}

function logTestStart(mode, param) {
  if (!TEST_START_LOG_URL || TEST_START_LOG_URL.startsWith("PASTE_")) return;
  try {
    const payload = JSON.stringify({ site: "PL300", event: "test_start", mode, param: String(param), source: beaconSource() });
    navigator.sendBeacon(TEST_START_LOG_URL, new Blob([payload], { type: "text/plain;charset=UTF-8" }));
  } catch (err) {
    // Logging is best-effort only — never let it block a test from starting.
  }
}

// Fires once per fresh page load when a guest lands on the home view — not on every
// in-app navigation back to it (e.g. clicking the header logo, logging out). Signed-in
// users skip straight to their dashboard on load and are never counted here.
function logHomePageVisit() {
  if (!TEST_START_LOG_URL || TEST_START_LOG_URL.startsWith("PASTE_")) return;
  try {
    const payload = JSON.stringify({ site: "PL300", event: "home_visit", source: beaconSource() });
    navigator.sendBeacon(TEST_START_LOG_URL, new Blob([payload], { type: "text/plain;charset=UTF-8" }));
  } catch (err) {
    // Logging is best-effort only — never let it block the page from loading.
  }
}

function testSetMinutes(count) {
  return Math.max(10, Math.round(count * TEST_SET_MINUTES_PER_QUESTION));
}

function testSetLabel(n) {
  return `PL300 Practice Test ${n}`;
}

// The 6 content-source modules questions are drawn from. Every question's
// "section" field is set to its own module's name directly (see
// pl300_assemble.py) — no mapping to the official PL-300 exam's domain
// structure is done anywhere in this app, by explicit instruction. Also used
// for the topic labels shown while taking a test and on the results-review
// page. Keyed by each question's "module" field (1-6).
const MODULE_NAMES = {
  1: "Get started with Microsoft data analytics",
  2: "Prepare data for analysis with Power BI",
  3: "Model data with Power BI",
  4: "Design effective reports in Power BI",
  5: "Manage and secure Power BI",
  6: "Complete DAX Mastery",
};

// ---------- Data layer (localStorage today, Firestore later) ----------
const DB = {
  getUser() {
    const raw = localStorage.getItem("pl300_user");
    return raw ? JSON.parse(raw) : null;
  },
  setUser(user) {
    localStorage.setItem("pl300_user", JSON.stringify(user));
  },
  clearUser() {
    localStorage.removeItem("pl300_user");
  },
  historyKey(email) {
    return `pl300_history_${email.toLowerCase()}`;
  },
  getHistory(email) {
    const raw = localStorage.getItem(this.historyKey(email));
    return raw ? JSON.parse(raw) : [];
  },
  saveAttempt(email, attempt) {
    const history = this.getHistory(email);
    history.unshift(attempt);
    localStorage.setItem(this.historyKey(email), JSON.stringify(history));
  },
};

// ---------- App state ----------
let ALL_QUESTIONS = [];
let session = null; // active test session

// ---------- View switching ----------
function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
  document.querySelector(".container").classList.toggle("wide", viewId === "view-test");
  // Switching views doesn't reset scroll position on its own — without this,
  // starting a test (or any other view switch) from partway down a long page
  // (e.g. the Choose Test grid) leaves the new view rendering mid-page instead
  // of at the top.
  window.scrollTo(0, 0);
}

// In-app replacement for the native window.confirm() dialog, which renders
// as an unstyled, browser-chrome popup that feels jarring and inconsistent
// with the rest of the app (especially on mobile, where it can be slow to
// register taps). Returns a Promise<boolean> — resolves true on OK, false on
// Cancel, clicking the overlay, or pressing Escape.
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirmModalOverlay");
    document.getElementById("confirmModalMessage").textContent = message;
    overlay.classList.remove("hidden");

    const okBtn = document.getElementById("confirmModalOkBtn");
    const cancelBtn = document.getElementById("confirmModalCancelBtn");

    const cleanup = (result) => {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlayClick);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(false); };
    const onKeydown = (e) => { if (e.key === "Escape") cleanup(false); };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlayClick);
    document.addEventListener("keydown", onKeydown);
  });
}

function setUserChip() {
  const user = DB.getUser();
  const chip = document.getElementById("userChip");
  chip.textContent = user ? `${user.name} · ${user.email}` : "";
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "");
}

// ---------- Explanation formatting (best-effort reconstruction of structure) ----------
// Source explanations vary: some are already written with real \n\n paragraph breaks
// (anything we authored ourselves), others got flattened into one run-on string during
// doc import (no newlines at all). This does its best to rebuild headings, numbered
// lists, and bullet lists from whatever structure survived, and auto-links bare URLs.
// IMPORTANT: never list both a word and its own prefix here (e.g. "Reference" AND
// "References") — the shorter one will re-match *inside* text the longer one already
// produced, orphaning the remainder (this caused the "R" / "eferences ..." bug).
// Colon-suffixed singular forms are safe to keep alongside colon-less plurals since
// the colon makes them distinct substrings that can't collide.
const EXPL_HEADERS = [
  "Overall explanation", "References:", "Reference:",
  // Must come before the bare "Explanation:" entry below — array order
  // matters here (each pass consumes its exact substring), so "Detailed
  // Explanation:" is extracted whole before the shorter "Explanation:"
  // gets a chance to tear it into a stray "Detailed" paragraph + heading.
  "Detailed Explanation:",
  "Explanation:",
  "Exam Tips:", "Exam Tip:",
  "Keep in Mind:", "Keep in Mind", "Study Links:", "Study links:", "Study Links", "Study links",
  "Remember,", "Remember:", "FAQ:", "Key Takeaways.", "Key Takeaway:",
  "Other Roles (Incorrect Options):", "Important Limitations to Consider:",
  "Reference Links:", "Recommended Videos:", "What Environment Maker Can Do:",
  "Environments Overview:", "Roles and Security:",
  "Features of Gallery Control.", "Use Cases of Gallery Control.",
  "PL300 Tips:", "Common Pitfalls to Avoid",
  // Added from a corpus-wide audit for genuine recurring section headings
  // (each verified to repeat 3+ times within a single explanation, matching
  // this file's own bar for "real heading, not incidental prose" — and each
  // spot-checked against its actual source context) that the general-purpose
  // detectors (formatTermList's 3+ threshold, splitEmbeddedTitle/splitGluedTitle)
  // were still missing for one structural reason or another.
  // Compound forms must come before their shorter counterpart below (same
  // "longer phrase consumed first" rule as Detailed Explanation:/Explanation:
  // above) — each confirmed present in the corpus via direct search.
  "Substitute DAX:", "VALUES DAX:", "DAX:",
  "Quick Tip:", "Tip to Remember:", "Tip:",
  "Load Behavior:", "Export Behavior:", "Behavior:",
  "Example Use Case:", "Use Case:",
  "Admin Role:", "Role:",
  "Purpose:", "Recommended Component:", "Reasoning:", "Mistake:",
  "Storage:", "Ask:", "Limitation:",
  "Situation:", "Memory Hook:", "Result:", "Consequence:",
  "Definition:", "Effect:", "Function:",
  // Added from spot-checking a batch of explanations with an option-by-option
  // "why this one's right/wrong" breakdown -- every occurrence of each of
  // these confirmed to sit right after a "\n\n" (or, for a couple, glued
  // straight onto the next word with no separator at all -- the EXPL_HEADERS
  // split-and-rejoin below inserts the blank-line break regardless, so that's
  // still handled correctly) rather than appearing mid-sentence. Deliberately
  // NOT adding a bare "Correct Answer"/"Correct Answers" (no colon): spot
  // checking those turned up real mid-sentence uses ("Data Analyst (Correct
  // Answer)", "Correct Answer is C - Using...", "Correct Answer Option A -
  // Align...") that a header-isolating split would garble.
  "Correct Answers:", "Correct Answers", "Correct Answer:",
  "Why correct:", "Why correct", "Why Correct:", "Why Correct",
  "Why wrong:", "Why wrong", "Why Wrong:", "Why Wrong",
  "Why incorrect:", "Why incorrect", "Why Incorrect:", "Why Incorrect",
];

// Recurring section-header phrases that have variable trailing content (so they
// can't just be exact strings in EXPL_HEADERS), confirmed by scanning the whole
// question bank for genuinely repeated patterns — not a generic "any Title Case
// phrase" rule, which mostly false-positives on product names like "Power
// Automate" mid-sentence. Each captures its own variable suffix (e.g. "Advantages
// of Using TLS") so the real heading text is preserved, just isolated onto its
// own line and bolded like the fixed EXPL_HEADERS.
const EXPL_HEADER_PATTERNS = [
  // Bare "Exam Tip" / "Exam Tips" (no colon) as one atomic pattern — listing
  // both forms separately in EXPL_HEADERS would have the shorter one
  // ("Exam Tip") re-match *inside* text the longer one ("Exam Tips") already
  // isolated, orphaning the trailing "s" (the exact bug that hit
  // References/Reference earlier this project). The colon-suffixed forms
  // above stay in EXPL_HEADERS since the colon makes them distinct strings.
  /\bExam Tips?\b/g,
  // Same "singular vs plural" collision as Exam Tip(s) above — "Recommended
  // Youtube Video" (no colon, bare) used to sit in EXPL_HEADERS right next to
  // the plural "Recommended Youtube Videos:", and since EXPL_HEADERS applies
  // every entry in sequence to the same text, the bare singular form would
  // re-match *inside* the plural heading after it was isolated, orphaning the
  // trailing "s" (e.g. "Recommended Youtube Videos:" -> heading "Recommended
  // Youtube Video" + a stray "s" paragraph). One atomic pattern covering
  // both cases (colon optional, singular/plural, Youtube/YouTube) avoids it.
  /Recommended [Yy]ou[Tt]ube (?:[Vv]ideos?|[Ll]inks?)\b/g,
  // Bare "References" (no colon): but ONLY right after a real sentence/clause
  // boundary (". "/": "/string start), never mid-phrase. Without this
  // restriction it also matches inside compound terms like "Connection
  // References", tearing that phrase in half every time it appears. The
  // (?<!\d) guard additionally excludes a numbered-list marker's own period
  // (e.g. "2. References to Model Objects" is one list item's title, not a
  // heading — "2." would otherwise satisfy the "[.:] " lookbehind on its own).
  // The "\n\n" alternative catches "References" landing right after a
  // heading EXPL_HEADERS already isolated above (e.g. "Exam Tips:" leaves
  // "\n\nExam Tips\n\n   References ..." — the colon itself is gone by now).
  /(?:^|(?<=(?<!\d)[.:]\s+)|(?<=\n\n\s*))References\b/g,
  /Why (?:the )?Other[s]?(?: Answers?| Options?)?\s*(?:Are|Is)\s*(?:Correct|Incorrect|Wrong|Right)\b/gi,
  // Same idea, but naming specific option letters instead of saying "other"
  // ("Why D and E are incorrect", "Why C is correct") — common when this
  // aside sits mid-list, between one lettered item's body and the next.
  /Why [A-H](?:\s*(?:and|,)\s*[A-H])*\s+(?:is|are)\s+(?:correct|incorrect|wrong|right)\b/gi,
  /Advantages of (?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|with|using)(?:\s(?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|with|using)){0,6}(?=\s[A-Z][a-z]|:|\.)/g,
  /Benefits of (?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|with|using)(?:\s(?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|with|using)){0,6}(?=\s[A-Z][a-z]|:|\.)/g,
  /Challenges (?:in|of|with) (?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or)(?:\s(?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or)){0,4}(?=\s[A-Z][a-z]|:|\.)/g,
  /Potential Downsides(?: to (?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|all)(?:\s(?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or|all)){0,12})?(?=\s[A-Z][a-z]|:|\.)/g,
  /Key Focus Area\b/g,
  /Common Confusion(?: to Avoid)?\b/g,
  /Why (?:It|This) Matters\b/g,
  /Simple Example\b/g,
];

function linkify(text) {
  // Some explanations already contain real <a href="..."> links (recovered
  // straight from the source docs), and some of THOSE have the raw URL itself
  // as the visible label rather than a nice title. A lookbehind on href="
  // alone only protects the attribute value — it does nothing for a bare URL
  // sitting as an anchor's own inner text, which this regex would happily
  // wrap in a second, nested <a>. So pull out every existing <a>...</a> tag
  // first (protecting both its href AND its label) and only linkify what's
  // left, regardless of what shape the pre-existing links take.
  const anchors = [];
  const withoutLinks = text.replace(/<a\s[^>]*>.*?<\/a>/g, (m) => {
    anchors.push(m);
    return `\x00LINK${anchors.length - 1}\x00`;
  });
  const linked = withoutLinks.replace(/(https?:\/\/[^\s<"]+)/g, (url) => {
    const clean = url.replace(/[.,;:)]+$/, "");
    const trailing = url.slice(clean.length);
    let label = clean.replace(/^https?:\/\//, "");
    if (label.length > 55) label = label.slice(0, 52) + "...";
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${label}</a>${trailing}`;
  });
  return linked.replace(/\x00LINK(\d+)\x00/g, (_, i) => anchors[Number(i)]);
}

// Detects " * item * item * item" style bullets within a block of text.
function formatBullets(text) {
  // Allow the very first "*" marker to sit at the start of the string (no
  // leading intro text) too — not just after a preceding space — since a
  // heading that gets isolated onto its own paragraph upstream (EXPL_HEADERS/
  // EXPL_HEADER_PATTERNS) can leave the bullet text starting right at "* Item"
  // with nothing before it to anchor the original \s requirement to.
  const parts = text.split(/(?:^|\s)\*\s(?=\S)/);
  if (parts.length < 3) return null; // need at least 2 real bullet items
  const before = parts.shift().trim();
  return (before ? `<p>${linkify(before)}</p>` : "") + `<ul>${parts.map((p) => `<li>${linkify(p.trim())}</li>`).join("")}</ul>`;
}

// Detects "1. foo 2. bar 3. baz" style numbered lists within a block of text.
// The source data sometimes loses the leading "1." (it got consumed elsewhere
// during import), leaving a list that reads "2. ... 3. ... 4. ..." — still a
// real list, just missing its first marker — so this only requires 3+ RUNS of
// consecutive integers, not that the run starts at 1.
function formatNumbered(text) {
  const matches = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s/g)];
  const nums = matches.map((m) => parseInt(m[1], 10));
  const sequential = nums.length >= 3 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  if (!sequential) return null;

  const before = text.slice(0, matches[0].index).trim();
  const itemTexts = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    return text.slice(start, end).trim();
  });

  // Each numbered item's own text can start with a title glued onto its
  // description (see splitEmbeddedTitle/splitGluedTitle) — an already-grouped
  // list like this is a much stronger signal than free prose, so even two
  // items sharing the shape is enough to trust it.
  const itemSplits = itemTexts.map((t) => splitEmbeddedTitle(t) || splitGluedTitle(t));
  const useSplits = itemSplits.filter(Boolean).length >= 2;

  const items = itemTexts.map((itemText, i) => {
    const split = useSplits ? itemSplits[i] : null;
    if (split) {
      const prefixPart = split.prefix ? `${linkify(split.prefix)}<br>` : "";
      return `<li>${prefixPart}<strong>${linkify(split.title)}</strong><br>${linkify(split.rest.trim())}</li>`;
    }
    return formatBullets(itemText) || `<li>${linkify(itemText)}</li>`;
  });
  // formatBullets() already returns full <ul> markup for items that contain sub-bullets;
  // wrap plain items in <li>, leave sub-list items as-is inside their own <li>.
  const html = items
    .map((it) => (it.startsWith("<ul>") || it.startsWith("<p>") ? `<li>${it}</li>` : it))
    .join("");
  // Recursively format the lead-in text too (it's often itself a run of short
  // "Term - definition." clauses that read much better one per line) instead
  // of dumping it into one dense paragraph.
  return (before ? formatSentences(before) : "") + `<ol>${html}</ol>`;
}

// Detects "A. foo B. bar D. baz" style lettered lists within a block of text
// (common where an explanation discusses several answer options by letter).
// Letters don't need to be perfectly consecutive — a discussion might skip a
// letter whose option didn't need explaining — just increasing, and each
// marker must be followed by a capitalized word so a stray "A." mid-sentence
// can't false-trigger this.
function formatLettered(text) {
  const matches = [...text.matchAll(/(?:^|\s)([A-H])[.)]\s(?=[A-Z])/g)];
  if (matches.length < 2) return null;
  const codes = matches.map((m) => m[1].charCodeAt(0));
  const increasing = codes.every((c, i) => i === 0 || c > codes[i - 1]);
  if (!increasing) return null;

  const before = text.slice(0, matches[0].index).trim();
  const itemTexts = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    return text.slice(start, end).trim();
  });

  // Same glued-title check as formatNumbered — a lettered list is just as
  // tightly grouped, so the same "2+ items share the shape" threshold applies.
  const itemSplits = itemTexts.map((t) => splitEmbeddedTitle(t) || splitGluedTitle(t));
  const useSplits = itemSplits.filter(Boolean).length >= 2;

  const items = matches.map((m, i) => {
    const split = useSplits ? itemSplits[i] : null;
    if (split) {
      const prefixPart = split.prefix ? `${linkify(split.prefix)}<br>` : "";
      return `<li><strong>${m[1]}.</strong> ${prefixPart}<strong>${linkify(split.title)}</strong><br>${linkify(split.rest.trim())}</li>`;
    }
    return `<li><strong>${m[1]}.</strong> ${linkify(itemTexts[i])}</li>`;
  });
  return (before ? formatSentences(before) : "") + `<ul class="lettered-list">${items.join("")}</ul>`;
}

// Detects a short (1-4 word) Title Case phrase glued directly onto the
// sentence that follows it by \xa0 (non-breaking space) instead of a real
// line break — a real, if easy to miss, structural signal preserved from the
// source docs. \xa0 also shows up throughout this content for perfectly
// ordinary spacing though, so this alone isn't trusted as proof of a heading;
// see the 3+ occurrence check in formatSentences below.
function splitEmbeddedTitle(sentence) {
  // Anchored at start-of-string OR right after ": "/". " so a leading intro
  // clause (e.g. "10 Use Cases for X: Troubleshooting Assistance The chatbot...")
  // doesn't hide the first item's title from matching — only what comes after
  // that point needs to look like a title, not the whole sentence.
  const m = sentence.match(/(?:^|[:.]\s)((?:[A-Z][a-zA-Z]*)(?:\s(?:[A-Z][a-zA-Z]*|and|of|for|the|in|to|on|or)|\s\([A-Z]{2,6}\)){0,4})\xa0(?=[A-Z][a-z])([\s\S]*)$/);
  if (!m) return null;
  const title = m[1].trim();
  const words = title.split(/\s+/);
  if (words.length === 1 && ["A", "An", "The", "I", "It", "This", "That"].includes(words[0])) return null;
  const titleStart = sentence.indexOf(title, m.index);
  return { prefix: sentence.slice(0, titleStart).trim(), title, rest: m[2] };
}

// Known camelCase brand/product/property names that must never be treated as
// a lost line break (e.g. "SharePoint", "PowerShell", "TabIndex") — without
// this list, a generic "lowercase immediately followed by uppercase" search
// mostly just matches these instead of real glued-together text, since a
// letter case change inside a single stylized word is far more common in
// this content than an actual missing space.
const GLUED_TITLE_SAFE_WORDS = [
  "SharePoint", "OneDrive", "ServiceNow", "PowerApps", "PowerAutomate", "PowerBI", "PowerPoint",
  "YouTube", "LinkedIn", "GitHub", "WordPress", "DevOps", "OneNote", "PayPal", "WebAPI", "iPhone",
  "iPad", "eBay", "MacBook", "LogicApps", "WebApp", "GraphQL", "OAuth", "JavaScript",
  "TypeScript", "NodeJS", "FedEx", "DocuSign", "QuickBooks",
  "AppSource", "TabIndex", "PowerFx", "DataSource", "OnSelect", "OnStart", "OnChange", "OnVisible",
  "PowerShell", "MySql", "MySQL", "iFrames", "iFrame", "OpenWeather", "AccessibleLabel", "ContextAware",
  "CrossPlatform", "OnClick", "OnHover",
];

// Same idea as splitEmbeddedTitle, but for the more common case where the
// title and body are glued with NO separator at all (not even \xa0) —
// e.g. "Business RulesBusiness Rules allow you to enforce...". Only trusted
// alongside the same 3+ occurrence check, and skips any match that falls
// inside a known safe word rather than a real word boundary.
function splitGluedTitle(sentence) {
  // The body normally starts with an ordinary Title-Case word ([A-Z][a-z]),
  // but sometimes it's an acronym instead ("...Policies" glued directly onto
  // "DLP policies control...") — [A-Z]{2,} catches that case too, but only
  // when a lowercase letter comes right before it (a genuine word boundary):
  // without that guard, the lazy word-match below stops after a single
  // letter anywhere INSIDE an existing acronym like "SQL" (matching "S" as a
  // "title" and misreading "QL" as the start of a new acronym).
  // Lazy (*?) on each word so it stops at the first valid boundary — a real
  // space between title words, or the lookahead below — instead of greedily
  // swallowing straight through a glued word into the acronym that follows
  // it (turning "Policies" + "DLP" into the single garbled word "PoliciesD").
  const m = sentence.match(/(?:^|[:.]\s)((?:[A-Z][a-zA-Z]*?)(?:\s(?:[A-Z][a-zA-Z]*?|and|of|for|the|in|to|on|or)|\s\([A-Z]{2,6}\)){0,4})(?=[A-Z][a-z]|(?<=[a-z])[A-Z]{2,})/);
  if (!m) return null;
  const title = m[1].trim();
  const words = title.split(/\s+/);
  if (words.length === 1 && ["A", "An", "The", "I", "It", "This", "That"].includes(words[0])) return null;

  const bodyStart = m.index + m[0].length;
  const window = sentence.slice(Math.max(0, bodyStart - 15), bodyStart + 15);
  if (GLUED_TITLE_SAFE_WORDS.some((w) => window.includes(w))) return null;

  const titleStart = sentence.indexOf(title, m.index);
  return { prefix: sentence.slice(0, titleStart).trim(), title, rest: sentence.slice(bodyStart) };
}

// Splits a run of prose into one <p> per sentence, so a long explanation reads
// as short, scannable lines instead of one dense paragraph. Existing <a> tags
// are pulled out first so a period inside a link's own visible text (rare,
// but possible) can never split the tag itself in half.
// Detects "Lead-in clause: Item one. Item two. Item three." — a short
// bulleted list flattened into plain sentences on import, with the items
// only separated from their intro by a colon (no period, so the normal
// sentence splitter leaves the intro and first item glued together). Only
// trusted when the colon clause is followed by 3+ more short sentences
// running to the end of the block — a single short "Note: one thing." aside
// isn't a list and is left as plain prose.
function extractColonList(sentences) {
  for (let i = 0; i < sentences.length; i++) {
    const m = sentences[i].match(/^(.*?:)\s+(\S.*)$/);
    if (!m) continue;
    const items = [m[2], ...sentences.slice(i + 1)];
    const isShort = (s) => s.split(/\s+/).length <= 18;
    if (items.length >= 3 && items.every(isShort)) {
      return { before: sentences.slice(0, i), intro: m[1], items };
    }
  }
  return null;
}

function formatSentences(text) {
  const anchors = [];
  const safe = text.replace(/<a [^>]*>.*?<\/a>/g, (m) => {
    anchors.push(m);
    return `\x00A${anchors.length - 1}\x00`;
  });
  // Uppercase is included alongside lowercase/digit here so a sentence
  // ending in an acronym ("...Knowledge Sources = Q&A.") still splits before
  // the next one — by this point formatLettered has already claimed any
  // genuine "A. ... B. ..." list (2+ increasing letters), so a lone
  // "X." here is essentially never a real list marker. Two abbreviation
  // shapes are excluded outright: "vs." (never a sentence end — "Standard
  // vs. Custom Tables" must stay one phrase), and a single capital letter
  // followed by a period used as an inline answer reference ("...B.
  // Microsoft 365 admin centre" must stay one phrase, not split after "B.").
  // A third shape: a bare numbered-list marker ("1.", "2." ... up to 2 digits)
  // that starts a paragraph on its own, with the item's actual title/content
  // sitting right after it on the same logical line — e.g. "1. DAX Operators
  // - A. Used to perform..." must stay one phrase, not split right after "1."
  // and orphan the marker onto its own paragraph.
  const sentences = safe
    .split(/(?<!\bvs\.)(?<!\b[A-Z]\.)(?<!\b\d{1,2}\.)(?<=[a-zA-Z0-9\)"']\.)\s+(?=[A-Z])/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length < 2) return `<p>${linkify(text)}</p>`;

  const restore = (s) => linkify(s.replace(/\x00A(\d+)\x00/g, (_, i2) => anchors[Number(i2)]));

  const colonList = extractColonList(sentences);
  if (colonList) {
    const beforeHtml = colonList.before.map((s) => `<p>${restore(s)}</p>`).join("");
    const introHtml = `<p><strong>${restore(colonList.intro)}</strong></p>`;
    const itemsHtml = `<ul>${colonList.items.map((it) => `<li>${restore(it)}</li>`).join("")}</ul>`;
    return beforeHtml + introHtml + itemsHtml;
  }

  // Named-list detection: if the same "Title glued to Sentence" shape (with
  // or without \xa0 between them) shows up 3+ times in this one explanation,
  // it's a deliberate list of named items (e.g. "10 Use Cases..." or
  // "Business Rules...") whose structure got flattened on import — put each
  // title on its own bold line, with the description starting fresh on the
  // next line. A single match elsewhere is left untouched, since on its own
  // it's far more likely an incidental product name than a real heading.
  const splits = sentences.map((s) => splitEmbeddedTitle(s) || splitGluedTitle(s));
  const titleCount = splits.filter(Boolean).length;

  return sentences
    .map((s, i) => {
      const split = titleCount >= 3 ? splits[i] : null;
      if (!split) return `<p>${restore(s)}</p>`;
      const prefixPart = split.prefix ? `<p>${restore(split.prefix)}</p>` : "";
      return `${prefixPart}<p><strong>${restore(split.title)}</strong></p><p>${restore(split.rest.trim())}</p>`;
    })
    .join("");
}

// Detects a run of 3+ "Term: Description" items marked by a colon right after
// a short (1-4 word) Title Case term — either a plain colon or one preceded
// by \xa0 (e.g. "Polling Trigger\xa0: ...", "Customizable Layout: ...") — and
// renders them as a real bulleted list, one <li> per term. Common for
// definition-style content that got flattened into one dense paragraph on
// import, especially where several items in a row have no period separating
// them at all. Only trusted at 3+ matches so an incidental single "Note: ..."
// aside is left as plain prose.
function formatTermList(text) {
  // Protect any existing <a> tags first — the term regex below scans for
  // "Word: " boundaries anywhere in the text, and without this a link's own
  // visible label (e.g. "...Power Platform DLP Policy: Everything...") could
  // get sliced in half right through the tag.
  const anchors = [];
  const safe = text.replace(/<a [^>]*>.*?<\/a>/g, (m) => {
    anchors.push(m);
    return `\x00A${anchors.length - 1}\x00`;
  });
  // Reinsert the real anchor tags (no re-linkifying — formatSentences/linkify
  // downstream already handle that on their own inputs).
  const reinsertAnchors = (s) => s.replace(/\x00A(\d+)\x00/g, (_, i2) => anchors[Number(i2)]);
  const restore = (s) => linkify(reinsertAnchors(s));

  // The first word must be capitalized; later words may be Title-Case too
  // ("Polling Trigger:") or plain lowercase ("Task management:") — both
  // conventions show up in the source. The 3+ match requirement below is what
  // keeps this safe: a single lowercase-tailed clause before a colon is far
  // too common in ordinary prose to trust on its own.
  // "Example:" is excluded from matching as its own term — it always reads
  // better folded into the item it illustrates than broken out as its own
  // bullet.
  const termRe =
    /(?:^|(?<=[.\s]))(?!Example\b)([A-Z][a-zA-Z]*(?:-[a-zA-Z]+)*(?:[\s\xa0][a-zA-Z][a-zA-Z]*(?:-[a-zA-Z]+)*){0,3}(?:\s\([A-Za-z][A-Za-z ]*\))?)\xa0?:\s(?=[A-Z0-9])/g;
  const matches = [...safe.matchAll(termRe)];
  if (matches.length < 3) return null;

  const before = safe.slice(0, matches[0].index).trim();
  const items = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : safe.length;
    const term = m[1].replace(/\xa0/g, " ").trim();
    const body = safe.slice(start, end).trim();
    return { term, body };
  });

  const beforeHtml = before ? formatSentences(reinsertAnchors(before)) : "";

  // An item whose body comes up empty (its colon was immediately followed by
  // the NEXT item's term, with nothing of its own in between — e.g. "Key
  // Points: Power Automate for Desktop: ...") is actually a plain lead-in
  // label for the items that follow, not a real bullet. Render it as its own
  // paragraph instead of an empty <li>, splitting the list at that point —
  // this can happen more than once, and not only at the very start.
  const segments = [];
  let group = [];
  for (const it of items) {
    if (!it.body) {
      if (group.length) {
        segments.push({ type: "ul", items: group });
        group = [];
      }
      segments.push({ type: "p", text: it.term });
    } else {
      group.push(it);
    }
  }
  if (group.length) segments.push({ type: "ul", items: group });

  // A lead-in label kept its colon (not forced into a period) and is bolded —
  // it's introducing the group that follows, not ending a sentence, so "Owner:"
  // stays "Owner:" rather than becoming the confusing "Owner."
  const segmentsHtml = segments
    .map((seg) =>
      seg.type === "p"
        ? `<p><strong>${restore(seg.text)}:</strong></p>`
        : `<ul>${seg.items.map((it) => `<li><strong>${restore(it.term)}</strong>: ${restore(it.body)}</li>`).join("")}</ul>`
    )
    .join("");

  return beforeHtml + segmentsHtml;
}

function formatBlock(p) {
  return formatNumbered(p) || formatLettered(p) || formatBullets(p) || formatTermList(p) || formatSentences(p);
}

// Splits one side of a matching question ("A. Item, B. Item" or "item; item; item")
// into individual {marker, text} entries, preferring explicit letter/number
// markers when present and falling back to semicolon- or comma-separated items.
function splitMatchItems(raw) {
  const letterMatches = [...raw.matchAll(/(?:^|\s)([A-Z])[.)]\s(?=[A-Za-z])/g)];
  if (letterMatches.length >= 2) {
    return letterMatches.map((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < letterMatches.length ? letterMatches[i + 1].index : raw.length;
      return { marker: m[1], text: raw.slice(start, end).replace(/[,.;]\s*$/, "").trim() };
    });
  }
  const numMatches = [...raw.matchAll(/(?:^|\s)(\d{1,2})[.)]\s(?=[A-Za-z])/g)];
  if (numMatches.length >= 2) {
    return numMatches.map((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < numMatches.length ? numMatches[i + 1].index : raw.length;
      return { marker: m[1], text: raw.slice(start, end).replace(/[,.;]\s*$/, "").trim() };
    });
  }
  const parts = raw.includes(";") ? raw.split(";") : raw.split(",");
  return parts
    .map((s) => s.replace(/\.\s*$/, "").trim())
    .filter(Boolean)
    .map((t) => ({ marker: null, text: t }));
}

// "Match each X to Y" stems name exactly two lists ("Types: A. ... B. ..." /
// "Descriptions: ... ; ...") — this pulls those two lists apart and lays them
// out as a real two-column table, one row per item, IN THE ORDER GIVEN (never
// cross-matched to the correct answer — that would hand out the answer before
// you've attempted the question). Only fires when there are exactly two
// "Label:" sections and both sides have the same, matchable item count;
// anything messier falls back to the simple line-per-item layout below, which
// is always safe.
function formatMatchingTable(text) {
  const labelMatches = [...text.matchAll(/\b([A-Z][a-zA-Z]*(?:\s[a-zA-Z]+){0,2}):\s/g)];
  if (labelMatches.length !== 2) return null;

  const introText = text.slice(0, labelMatches[0].index).trim();
  const leftLabel = labelMatches[0][1];
  const leftRaw = text.slice(labelMatches[0].index + labelMatches[0][0].length, labelMatches[1].index).trim();
  const rightLabel = labelMatches[1][1];
  const rightRaw = text.slice(labelMatches[1].index + labelMatches[1][0].length).trim();

  const leftItems = splitMatchItems(leftRaw);
  const rightItems = splitMatchItems(rightRaw);
  if (leftItems.length < 2 || rightItems.length < 2 || leftItems.length !== rightItems.length) return null;

  const rows = leftItems
    .map((l, i) => {
      const r = rightItems[i];
      const leftMark = l.marker || String.fromCharCode(65 + i);
      const rightMark = r.marker || String(i + 1);
      return `<tr><td><strong>${leftMark}.</strong> ${l.text}</td><td><strong>${rightMark}.</strong> ${r.text}</td></tr>`;
    })
    .join("");

  return `
    ${introText ? `<p class="match-intro">${introText}</p>` : ""}
    <table class="match-table">
      <thead><tr><th>Left: ${leftLabel}</th><th>Right: ${rightLabel}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// "Arrange the steps in the correct order" / "Put the following steps in the
// correct order" stems have the exact same problem as "match the" ones --
// a dense run-on paragraph ending in "A. Step one B. Step two C. Step
// three" -- just with one list to lay out instead of two. Requiring the
// imperative verb ("arrange"/"put") together with "steps" and "order"
// keeps this from firing on an ordinary "which represents the correct
// order of steps" question whose lettered choices live in the options
// array, not the stem itself (that phrasing has "order" before "steps"
// and no "arrange"/"put").
const ORDER_STEPS_RE = /\b(arrange|put)\b[\s\S]*\bsteps?\b[\s\S]*\border\b/i;

// "Match each X to Y" question stems arrive as one dense run-on paragraph
// ("Apps: Power Apps, Power Automate. Scenarios: A. ... B. ... C. ...").
// Tries the real two-column table first; if the text doesn't cleanly split
// into two equal-length lists, falls back to one line per label/item instead,
// still far more readable than the original run-on, just not a table.
// Only ever called for question text containing "match the"/"match each"
// or the step-ordering phrasing above (not just at the very start, since
// some stems lead with a short scenario sentence first), and always falls
// back to the untouched original if neither approach finds real list
// structure, so it can never make an ordinary question worse.
function formatMatchingQuestionText(text) {
  if (!/\bmatch (the|each)\b/i.test(text) && !ORDER_STEPS_RE.test(text)) return text;

  const table = formatMatchingTable(text);
  if (table) return table;

  let working = text;
  working = working.replace(/\s*\b([A-Z][a-zA-Z]*(?:\s[a-zA-Z]+){0,2}):\s/g, "\n$1: ");
  working = working.replace(/\s([A-H])\.\s(?=[A-Z])/g, "\n$1. ");
  working = working.replace(/\s(\d{1,2})\.\s(?=[A-Z])/g, "\n$1. ");
  working = working.replace(/;\s*/g, "\n");
  // Some stems are a run of standalone "Which X does Y?" clauses with no
  // label/marker at all (the answer choices live entirely in the options,
  // each a full candidate sequence) — break after each "? " so every
  // question reads on its own line instead of running into the next.
  working = working.replace(/\?\s+(?=[A-Z])/g, "?\n");
  let lines = working
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // Same idea, but the run-on clauses are plain statements ending in "."
  // rather than "?" (no marker/label at all). Only apply this looser split
  // as a last resort — when nothing else found real list structure yet, and
  // there are several roughly sentence-length segments — since blindly
  // splitting on every period is too aggressive for ordinary prose.
  if (lines.length < 3) {
    const bySentence = text
      .split(/\.\s+(?=[A-Z])/)
      .map((s) => s.trim().replace(/\.$/, "") + ".")
      .filter((s) => s.length > 3);
    if (bySentence.length >= 4 && bySentence.every((s) => s.length < 200)) {
      lines = bySentence;
    }
  }
  if (lines.length < 3) return text;
  // Bold just the label — a bare "Tasks:"/"Places:" line in full, or the
  // "1."/"A." marker at the start of an item line — not the whole line
  // (the surrounding .question-text is already bold by default; without
  // this every line would render fully bold, including the descriptions).
  return lines
    .map((l) => {
      const bareLabel = l.match(/^([A-Za-z][A-Za-z ]*:)$/);
      // Extra top margin (via match-section) so the left-column list and the
      // right-column list read as two visually distinct groups, not one
      // continuous run of lines: matters most on longer 5-6 item matches.
      if (bareLabel) return `<div class="match-line match-section"><strong>${bareLabel[1]}</strong></div>`;
      const marker = l.match(/^((?:[A-H]|\d{1,2})\.)\s(.*)$/);
      if (marker) return `<div class="match-line"><strong>${marker[1]}</strong> ${marker[2]}</div>`;
      return `<div class="match-line">${l}</div>`;
    })
    .join("");
}

// "For each statement, decide Yes or No: A; B; C." question stems run every
// statement together in one dense sentence, which is hard to scan against a
// "Yes / No / Yes" style answer option. Numbers each statement onto its own
// line so it's obvious which answer slot maps to which claim.
function formatYesNoQuestionText(text) {
  const m = text.match(/^([\s\S]*?for each statement\b[^:]*?decide\s+yes\s+or\s+no\s*:\s*)([\s\S]+)$/i);
  if (!m) return null;
  const intro = m[1].trim();
  const items = m[2]
    .split(/(?:\d+\)\s*|;\s*)/)
    .map((s) => s.replace(/^[;\s]+|[;\s]+$/g, "").replace(/\.\s*$/, "").trim())
    .filter(Boolean);
  if (items.length < 2) return null;
  const itemsHtml = items.map((it, i) => `<div class="match-line"><strong>${i + 1}.</strong> ${it}.</div>`).join("");
  return `<p class="match-intro">${intro}</p>${itemsHtml}`;
}

// Sentence-ending abbreviations whose period must never be mistaken for the
// end of a sentence by breakLongParagraph() below.
const SENTENCE_ABBREVIATIONS = [
  "e\\.g", "i\\.e", "etc", "vs", "Mr", "Mrs", "Ms", "Dr", "Inc", "Ltd", "approx",
  "No", "Fig", "St", "Ave", "U\\.S", "U\\.K", "a\\.m", "p\\.m", "Jan", "Feb", "Mar",
  "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
];
const SENTENCE_ABBREV_RE = new RegExp("\\b(" + SENTENCE_ABBREVIATIONS.join("|") + ")\\.", "g");

// Shared by breakLongParagraph() and formatCuedStatementList() below: splits
// text into an array of real sentences, protecting decimal numbers ("3.5"),
// digit-preceded periods in general (also protects list markers like "1."),
// ellipses, and common abbreviations (e.g., etc., Mr., U.S., ...) from being
// mistaken for a sentence boundary.
function splitIntoSentences(text) {
  let working = text.replace(/\.\.\./g, "\x00\x00\x00");
  working = working.replace(SENTENCE_ABBREV_RE, (m) => m.slice(0, -1) + "\x02");
  working = working.replace(/(?<=[a-zA-Z)"'”])([.!?])\s+(?=[A-Z0-9"'(“])/g, "$1\x03");
  working = working.replace(/\x02/g, ".").replace(/\x00\x00\x00/g, "...");
  return working.split("\x03");
}

// Long, dense narrative stems (scenario setups running several sentences
// before the actual question) read as one wall of text — breaks each real
// sentence onto its own line so they scan like a scenario instead of a
// paragraph. Deliberately conservative: only touches text long enough that
// this actually helps, bails out entirely on anything that already has its
// own structure (a match-table, an image, a link, an existing <br>) or that
// looks like it embeds a lettered/numbered list ("A. ... B. ...", "1. ... 2.
// ...") since a blind sentence-break would mistake each marker for a tiny
// one-word sentence and shred the list. Never breaks a period preceded by a
// digit at all (protects both decimal numbers like "3.5" and list markers),
// which means a sentence that happens to end on a bare number won't get a
// break at that exact spot -- a missed touch-up, never a corruption.
// `rawText` (the text as authored, before formatQuestionText's own <br>-
// inserting substitutions) is what the "already has structure" check runs
// against, so a stem that only picked up a <br> from the mid-sentence
// "true or false:" rewrite above still gets its long run of statements
// broken up rather than being mistaken for already-structured content.
function breakLongParagraph(text, rawText) {
  if (text.length < 350) return text;
  if (/<img|<a\s|<table|<br/i.test(rawText !== undefined ? rawText : text)) return text;
  const letterMarkers = (text.match(/\b[A-Z]\.\s/g) || []).length;
  const numMarkers = (text.match(/\b\d{1,2}\.\s/g) || []).length;
  if (letterMarkers >= 2 || numMarkers >= 2) return text;
  return splitIntoSentences(text).join("<br><br>");
}

// A stem opening with "Choose Right or Wrong."/"State True or False:" etc.
// lists several separate claims to judge one at a time -- numbers each one
// (1., 2., 3., ...) instead of just breaking them onto separate lines, so
// it's unambiguous which numbered claim a numbered True/False in the
// matching answer option (see formatTrueFalseOptionText below) refers to.
// Runs regardless of overall length, since the whole point of the stem is
// one claim per line even when the combined text is fairly short.
const MULTI_STATEMENT_CUE_RE = /^(state|choose|evaluate)\b.{0,30}\b(true or false|right or wrong)\b/i;

function formatCuedStatementList(text) {
  const m = text.match(/^([\s\S]*?(?:true or false|right or wrong)\s*[:.]?\s*(?:<br\s*\/?>){0,4})([\s\S]*)$/i);
  if (!m) return null;
  const intro = m[1];
  const statements = splitIntoSentences(m[2])
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length < 2) return null;
  const items = statements.map((s, i) => `<div class="match-line"><strong>${i + 1}.</strong> ${s}</div>`).join("");
  return intro + items;
}

// The answer-option equivalent of a "State True or False"/"Choose Right or
// Wrong" stem: each option restates every claim right next to the verdict
// for it ("Claim one. - True Claim two. - False ..."), all run into one
// paragraph. Splits on whichever marker order the source uses -- a leading
// "True - "/"False - " before each claim, or a trailing "- True"/"- False"
// (also accepting the abbreviated "- T"/"- F") after it -- and numbers each
// claim to match formatCuedStatementList()'s numbering of the stem itself.
// Strips any pre-existing <br> first so a source that only had some claims
// manually broken (never all of them) still comes out consistently
// formatted rather than half-fixed. Returns the original text untouched if
// fewer than two markers are found, so a short option like "True, False,
// True" (no restated claims) or one already wrapped in <pre> is never
// touched.
function formatTrueFalseOptionText(text) {
  return escapeStrayAngleBrackets(formatTrueFalseOptionTextInner(text));
}
function formatTrueFalseOptionTextInner(text) {
  if (/<pre[\s>]/i.test(text)) return text;
  const clean = text.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
  const normalizeMark = (raw) => (/^t/i.test(raw) ? "True" : "False");

  // A bare comma-separated verdict sequence ("True, False, True, ...") has
  // no restated claim to split on -- just a numbered answer key matching the
  // stem's own numbered claims one-for-one -- so it's handled separately
  // from the two restated-claim shapes below.
  const bareTokens = clean.split(",").map((s) => s.trim());
  if (bareTokens.length >= 2 && bareTokens.every((t) => /^(True|False|T|F|Right|Wrong)$/i.test(t))) {
    const normalizeBare = (t) => (/^t/i.test(t) ? "True" : /^f/i.test(t) ? "False" : t[0].toUpperCase() + t.slice(1).toLowerCase());
    return bareTokens.map((t, i) => `<div class="match-line"><strong>${i + 1}.</strong> ${normalizeBare(t)}</div>`).join("");
  }

  // Same idea, but the bare answer key is space-separated pairs like
  // "1 - B 2 - A 3 - C ..." (a numbered-scenario question's option, one
  // letter per numbered item) instead of a comma list.
  const keyPairRe = /\b(\d{1,2})\s*-\s*([A-Za-z])\b/g;
  const keyPairMatches = [...clean.matchAll(keyPairRe)];
  if (keyPairMatches.length >= 2 && keyPairMatches.map((m) => m[0]).join(" ") === clean) {
    return keyPairMatches
      .map((m) => `<div class="match-line"><strong>${m[1]}.</strong> ${m[2].toUpperCase()}</div>`)
      .join("");
  }

  // Same idea again, but each pair carries a parenthetical description too:
  // "1 – f (Exponentiation) 2 – e (Sign – negative or positive) ...". The
  // dash between the number and letter may be a plain hyphen or an en dash,
  // and the description itself can contain an en dash -- matched greedily
  // up to the first closing paren so an embedded dash never confuses the
  // split between pairs.
  const descKeyRe = /(\d{1,2})\s*[-–]\s*([A-Za-z])\s*(\([^)]*\))/g;
  const descKeyMatches = [...clean.matchAll(descKeyRe)];
  if (descKeyMatches.length >= 2 && descKeyMatches.map((m) => m[0]).join(" ") === clean) {
    return descKeyMatches
      .map((m) => `<div class="match-line"><strong>${m[1]}.</strong> ${m[2].toUpperCase()} ${m[3]}</div>`)
      .join("");
  }

  const leadingRe = /\b(True|False)\s*-\s*/g;
  const leadingMatches = [...clean.matchAll(leadingRe)];
  const trailingRe = /-\s*(True|False|T|F)\.?(?=\s|$)/g;
  const trailingMatches = [...clean.matchAll(trailingRe)];

  let items = null;
  if (leadingMatches.length >= 2 && leadingMatches.length >= trailingMatches.length) {
    items = leadingMatches
      .map((m, i) => {
        const start = m.index + m[0].length;
        const end = i + 1 < leadingMatches.length ? leadingMatches[i + 1].index : clean.length;
        return { mark: normalizeMark(m[1]), text: clean.slice(start, end).trim() };
      })
      .filter((it) => it.text);
  } else if (trailingMatches.length >= 2) {
    items = [];
    let cursor = 0;
    for (const m of trailingMatches) {
      const stmt = clean.slice(cursor, m.index).trim();
      if (stmt) items.push({ mark: normalizeMark(m[1]), text: stmt });
      cursor = m.index + m[0].length;
    }
  }
  if (!items || items.length < 2) return text;
  return items.map((it, i) => `<div class="match-line"><strong>${i + 1}.</strong> ${it.text} - <strong>${it.mark}</strong></div>`).join("");
}

// A source explanation or question stem occasionally embeds a DAX-doc-style
// placeholder in angle brackets ("DATEADD(<dates>, <number_of_intervals>,
// <interval>)") or a bare comparison operator ("Sales[Amount] < 2500") --
// once injected via innerHTML, the browser parses either as the start of an
// HTML tag. A placeholder's name becomes the (never-rendered) tag name, so
// it silently vanishes; a bare "<" is worse, since the browser keeps
// consuming characters looking for the closing ">" and can swallow a large
// stretch of legitimate content in between (including, in a <pre> block,
// content right up to the real closing tag).
//
// Applied as a FINAL pass over each formatter's finished HTML output, never
// as pre-processing on the raw source -- a stem like q144's, which legitimately
// lists bare "<"/">" as the literal DAX comparison operators being described,
// needs those characters intact for the matching-table/list-splitting logic
// upstream (label detection, item counts) to work correctly; escaping too
// early would corrupt that structure instead of just sanitizing display.
// Protects every real tag this codebase's formatters actually emit (plus the
// handful the source data itself uses) first, then escapes every remaining
// "<"/">" so a placeholder or operator displays as literal text instead of
// disappearing or eating its neighbors.
const REAL_TAG_RE = /<\/?(?:img|a|br|pre|strong|div|table|thead|tbody|tr|th|td|h[1-6]|p|ul|ol|li|span)(?:\s[^>]*)?>/gi;
function escapeStrayAngleBrackets(text) {
  const protectedTags = [];
  let working = text.replace(REAL_TAG_RE, (m) => {
    protectedTags.push(m);
    return `\x00TAG${protectedTags.length - 1}\x00`;
  });
  working = working.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return working.replace(/\x00TAG(\d+)\x00/g, (_, i) => protectedTags[Number(i)]);
}

function formatQuestionText(text) {
  return escapeStrayAngleBrackets(formatQuestionTextInner(text));
}
function formatQuestionTextInner(text) {
  const rawText = text;
  text = text.replace(/→|➔|➡/g, "-");
  // A handful of true/false stems bury "true or false" mid-sentence after a
  // narrative setup instead of leading with it — hard to scan since the
  // actual claim being judged blends into the setup. Only fires when
  // something real comes before it (never at the very start, where "True or
  // false:" already reads fine as the first thing in the stem) and always
  // renders the same way: capitalized, on its own line, with the claim
  // starting fresh on the next.
  text = text.replace(/(\S)\s+true or false\s*[:,]\s*/i, "$1<br><br>True or False:<br><br>");
  if (/\bmatch (the|each)\b/i.test(text) || ORDER_STEPS_RE.test(text)) return formatMatchingQuestionText(text);
  if (MULTI_STATEMENT_CUE_RE.test(rawText)) {
    const cued = formatCuedStatementList(text);
    if (cued) return cued;
  }
  return formatYesNoQuestionText(text) || breakLongParagraph(text, rawText);
}

function formatExplanation(raw) {
  return escapeStrayAngleBrackets(formatExplanationInner(raw));
}
function formatExplanationInner(raw) {
  if (!raw) return "";

  // Arrow characters (from source docx bullets like "Manager -> Approves") render
  // inconsistently across fonts/platforms; a plain ASCII arrow is more reliable.
  raw = raw.replace(/→|➔|➡/g, "-");

  // A handful of explanations start with a stray literal "Explanation" word
  // before the actual content (e.g. "Explanation Everyone must approve: ...")
  // — pure noise, since this text already renders under its own "EXPLANATION"
  // heading in the UI.
  raw = raw.replace(/^Explanation\s+(?=[A-Z])/, "");

  // Pull out any embedded <img> tags so they don't get mangled, restore them after.
  // The placeholder uses \x00 (a character .trim()/whitespace regexes never touch)
  // rather than plain spaces — an image sitting at the very end of a paragraph would
  // otherwise have its trailing space stripped by the .trim() below, leaving the
  // restore regex with nothing to match and a literal " IMG0" leaking into the output.
  const imgTags = [];
  let text = raw.replace(/<img[^>]*>/g, (m) => {
    imgTags.push(m);
    return `\x00IMG${imgTags.length - 1}\x00`;
  });

  // Same idea for <pre class="dax-code">...</pre> blocks (multi-line DAX
  // formulas quoted in an explanation) — without this, the paragraph
  // splitter below wraps the whole block in a <p>, which is invalid HTML
  // nesting for a block-level <pre>, and the sentence-splitting heuristics
  // would otherwise break mid-formula on any "." inside the code.
  const preTags = [];
  text = text.replace(/<pre class="dax-code">[\s\S]*?<\/pre>/g, (m) => {
    preTags.push(m);
    return `\x00PRE${preTags.length - 1}\x00`;
  });

  // Break known section headers onto their OWN isolated paragraph (blank line on both
  // sides) so they render as sub-headings rather than getting merged into body text.
  const headerNames = new Set(EXPL_HEADERS.map((h) => h.replace(/:$/, "")));
  EXPL_HEADERS.forEach((h) => {
    text = text.split(h).join(`\n\n${h.replace(/:$/, "")}\n\n`);
  });

  // Same idea for headers with variable trailing content ("Advantages of Using
  // TLS", "Why Other Options Are Incorrect") — isolate onto their own paragraph,
  // wrapped in a \x02...\x02 sentinel since the captured text varies per match
  // and can't be looked up in the fixed headerNames set below.
  EXPL_HEADER_PATTERNS.forEach((re) => {
    text = text.replace(re, (m) => `\n\n\x02${m.trim()}\x02\n\n`);
  });

  // A source header like "Why the other options are incorrect:" has its
  // trailing colon (or, for the variable-content patterns, a trailing period
  // or — when the source phrased the heading as a question, "Why others are
  // wrong?" — a question mark) fall just outside the pattern match above
  // (only the heading phrase itself is captured) — strip that dangling
  // punctuation so it doesn't become its own orphaned ":", ".", or "?"
  // paragraph (a lone "?" starting the very next sentence, exactly this
  // spot, is always this leftover — never a real mid-sentence "?").
  text = text.replace(/(\x02\n\n)\s*[:.?]\s*/g, "$1");

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // A paragraph becomes a heading if its entire (trimmed) content is exactly one
  // of the known header names, or the whole thing is a \x02-wrapped dynamic
  // header — never just "the first character of any paragraph" (that was the
  // earlier bug: every paragraph got its first letter sliced off).
  let html = paragraphs
    .map((p) => {
      if (headerNames.has(p)) return `<h4 class="expl-heading">${p}</h4>`;
      const dynamicHeading = p.match(/^\x02(.+)\x02$/);
      if (dynamicHeading) return `<h4 class="expl-heading">${dynamicHeading[1]}</h4>`;
      // A paragraph that's ENTIRELY one <pre> placeholder (own blank-line-
      // separated block, not mixed with other prose) must come out bare —
      // wrapping it in <p> here would nest a block-level <pre> inside a <p>
      // once the placeholder is restored below, which is invalid HTML.
      if (/^\x00PRE\d+\x00$/.test(p)) return p;
      return formatBlock(p);
    })
    .join("");

  html = html.replace(/\x00IMG(\d+)\x00/g, (_, i) => imgTags[Number(i)]);
  html = html.replace(/\x00PRE(\d+)\x00/g, (_, i) => preTags[Number(i)]);

  // Consecutive reference links separated by only a space (common in
  // "References"/"Recommended Video" sections with several links in a row)
  // have touching underlines with no visible gap, reading as one merged link.
  // Break each back-to-back link onto its own line.
  html = html.replace(/<\/a>\s+(?=<a )/g, "</a><br>");

  return html;
}

// Builds "why each option is right/wrong" + the Overall Explanation card,
// shared by Practice mode's post-check reveal and the Results review list.
// Per-option explanations only exist for single/multi/truefalse questions
// re-matched back to their source doc; anything else (or a question with no
// recovered per-option text) just falls back to the Overall Explanation alone.
function renderExplanationBreakdown(q, given) {
  // Per-option breakdown is supported for these 3 types regardless of whether
  // any option actually has recovered per-option text — a question where NONE
  // of its options have one still gets the breakdown UI, just with a generic
  // "This is not the right option" fallback on each wrong answer instead of a
  // blank card, so every question looks consistent rather than some silently
  // having no breakdown at all.
  const supportsOptionExpl = (q.type === "single" || q.type === "multi" || q.type === "truefalse") && Array.isArray(q.options);

  let optionsHtml = "";
  if (supportsOptionExpl) {
    optionsHtml =
      `<div class="option-breakdown">` +
      q.options
        .map((opt) => {
          const isCorrect = q.correct.includes(opt.id);
          const wasGiven = given.includes(opt.id);
          let cls = "option-expl-item";
          if (isCorrect) cls += " correct";
          else if (wasGiven) cls += " incorrect";
          const tag = isCorrect ? "Correct answer" : wasGiven ? "Your answer" : "";
          const mark = isCorrect ? "✓" : wasGiven ? "✗" : "";
          const explBody = opt.explanation
            ? formatExplanation(opt.explanation)
            : isCorrect
            ? ""
            : "<p>This is not the right option.</p>";
          return `
            <div class="${cls}">
              <div class="option-expl-label">${mark ? `<span class="option-expl-mark">${mark}</span> ` : ""}<span class="option-expl-label-text">${formatTrueFalseOptionText(opt.text)}</span>${
                tag ? `<span class="option-expl-tag">${tag}</span>` : ""
              }</div>
              ${explBody ? `<div class="option-expl-text">${explBody}</div>` : ""}
            </div>`;
        })
        .join("") +
      `</div>`;
  }

  return `
    ${optionsHtml}
    <div class="explanation-card">
      <div class="explanation-title">${supportsOptionExpl ? "Overall Explanation" : "Explanation"}</div>
      <div class="explanation-body">${formatExplanation(q.explanation)}</div>
    </div>
  `;
}

// ---------- Boot ----------
// Deter casual copying of question content: block the context menu, text
// selection, and copy/cut/paste. Not a real security boundary (view-source
// still works), just friction against right-click-and-copy.
document.addEventListener("contextmenu", (e) => e.preventDefault());
const inField = (e) => e.target.closest && e.target.closest("input, textarea");
document.addEventListener("selectstart", (e) => { if (!inField(e)) e.preventDefault(); });
document.addEventListener("copy", (e) => { if (!inField(e)) e.preventDefault(); });
document.addEventListener("cut", (e) => { if (!inField(e)) e.preventDefault(); });
document.addEventListener("paste", (e) => { if (!inField(e)) e.preventDefault(); });

async function boot() {
  // One-time opt-in so the site owner's own manual testing on the live site can be told
  // apart from real visitors in the test-start log, without collecting anything (no IP,
  // no login) from anyone else. ?lrtest=owner sets it; ?lrtest=clear removes it.
  const lrtestParam = new URLSearchParams(location.search).get("lrtest");
  if (lrtestParam === "owner") localStorage.setItem("lr_owner_mode", "1");
  else if (lrtestParam === "clear") localStorage.removeItem("lr_owner_mode");

  // Load the question bank defensively: if this fetch fails or the response is
  // malformed (flaky connection, offline, etc.), fall back to an empty array
  // instead of throwing — an uncaught rejection here would abort boot() before
  // ANY event listener below got wired up, silently breaking every button on
  // the site (not just test-taking), including nav that doesn't even need
  // question data. A visible banner tells the visitor to refresh instead.
  let questionsLoadFailed = false;
  try {
    const res = await fetch("questions.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ALL_QUESTIONS = await res.json();
  } catch (err) {
    console.error("Failed to load questions.json:", err);
    ALL_QUESTIONS = [];
    questionsLoadFailed = true;
  }

  const user = DB.getUser();
  if (user) {
    setUserChip();
    renderDashboard();
    show("view-dashboard");
  } else {
    show("view-home");
    logHomePageVisit();
  }

  // Header brand name doubles as a home link from anywhere in the app
  const goHome = () => {
    if (session && document.getElementById("view-test").classList.contains("active")) {
      goHomeFromTest();
    } else {
      show(DB.getUser() ? "view-dashboard" : "view-home");
      if (DB.getUser()) renderDashboard();
    }
  };
  document.getElementById("appHomeLink").addEventListener("click", goHome);

  // Header About / Contact links, available from anywhere in the app
  document.getElementById("headerAboutBtn").addEventListener("click", () => show("view-about"));
  document.getElementById("headerContactBtn").addEventListener("click", () => show("view-contact"));
  document.getElementById("aboutGoHomeBtn").addEventListener("click", goHome);
  document.getElementById("contactGoHomeBtn").addEventListener("click", goHome);
  document.getElementById("contactForm").addEventListener("submit", onContactSubmit);
  document.getElementById("reportModalCancelBtn").addEventListener("click", closeReportModal);
  document.getElementById("reportModalSubmitBtn").addEventListener("click", onReportSubmit);

  // Footer legal pages, available from anywhere in the app
  document.getElementById("footerDisclaimerBtn").addEventListener("click", () => show("view-disclaimer"));
  document.getElementById("footerPrivacyBtn").addEventListener("click", () => show("view-privacy"));
  document.getElementById("footerCookieBtn").addEventListener("click", () => show("view-cookies"));
  document.getElementById("disclaimerGoHomeBtn").addEventListener("click", goHome);
  document.getElementById("privacyGoHomeBtn").addEventListener("click", goHome);
  document.getElementById("cookiesGoHomeBtn").addEventListener("click", goHome);

  document.getElementById("welcomeForm").addEventListener("submit", onWelcomeSubmit);
  document.getElementById("logoutBtn").addEventListener("click", () => {
    DB.clearUser();
    setUserChip();
    show("view-home");
  });

  // Home page -> Choose Test page (no sign-in required to start any test)
  const goToChooseTest = () => {
    renderTestGrid("chooseTimedGrid", "deferred");
    renderTestGrid("choosePracticeGrid", "immediate");
    show("view-choose-test");
  };
  document.getElementById("homeReadyBtn").addEventListener("click", goToChooseTest);
  document.getElementById("homeGoToLoginBtn").addEventListener("click", () => show("view-welcome"));
  // Same two buttons repeated at the bottom of the home page (after the
  // screenshots, above the copyright note) so a visitor who scrolls all the
  // way down doesn't have to scroll back up to start.
  document.getElementById("homeReadyBtnBottom").addEventListener("click", goToChooseTest);
  document.getElementById("homeGoToLoginBtnBottom").addEventListener("click", () => show("view-welcome"));
  document.getElementById("chooseTestGoHomeBtn").addEventListener("click", () => show("view-home"));
  document.getElementById("chooseTestLoginBtn").addEventListener("click", () => show("view-welcome"));

  document.getElementById("submitTestBtn").addEventListener("click", onSubmitTest);
  document.getElementById("prevQBtn").addEventListener("click", () => gotoQuestion(session.index - 1));
  // On the last question this button's label switches to "Submit Test →" (see
  // renderQuestion), but it was still wired to gotoQuestion(index + 1) — an
  // out-of-bounds index gotoQuestion silently ignores, so the click did
  // nothing at all. Route to onSubmitTest() whenever there's no next question.
  document.getElementById("nextQBtn").addEventListener("click", () => {
    if (session.index >= session.questions.length - 1) {
      onSubmitTest();
    } else {
      gotoQuestion(session.index + 1);
    }
  });

  // Up/Down arrows move between questions during a test, so you don't have
  // to reach for the mouse every single question — but only once the learner
  // has actively clicked into the question's answer options. Without this
  // "armed" gate, Up/Down would hijack the arrow keys' normal job (scrolling
  // the page) everywhere on the test view, all the time. Clicking anywhere
  // outside the answer options disarms it again, so plain page scrolling
  // with the arrow keys works normally there.
  let arrowNavArmed = false;
  // Capture phase (not bubble) — clicking an option synchronously re-renders
  // the question and wipes #questionBody's contents (including the clicked
  // element itself) before a bubble-phase listener here would ever run,
  // which would make e.target.closest() fail to find its now-detached
  // ancestor. Capturing on the way down sees the DOM before that happens.
  document.addEventListener(
    "click",
    (e) => {
      arrowNavArmed = !!e.target.closest("#questionBody");
    },
    true
  );
  // Ignored while typing in a fill-in-the-blank field (or any other input) so
  // arrow keys still work normally there, and only active while the test
  // view is actually showing.
  document.addEventListener("keydown", (e) => {
    if (!session || !document.getElementById("view-test").classList.contains("active")) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!arrowNavArmed) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    if (e.key === "ArrowDown") gotoQuestion(session.index + 1);
    else gotoQuestion(session.index - 1);
  });
  document.getElementById("testCancelBtn").addEventListener("click", () => cancelTest());
  document.getElementById("backToDashBtn").addEventListener("click", () => {
    if (DB.getUser()) {
      renderDashboard();
      show("view-dashboard");
    } else {
      show("view-home");
    }
    // The results page can be scrolled well down (full question review);
    // switching views doesn't reset scroll position on its own, so without
    // this the destination view renders starting mid-page instead of at top.
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  if (questionsLoadFailed) {
    const banner = document.createElement("div");
    banner.className = "card load-error-banner";
    banner.innerHTML = `⚠️ The question bank didn't load (connection hiccup). <button id="reloadQuestionsBtn" class="btn small">Refresh</button>`;
    document.querySelector(".container").prepend(banner);
    document.getElementById("reloadQuestionsBtn").addEventListener("click", () => location.reload());
  } else if (ALL_QUESTIONS.length === 0) {
    const banner = document.createElement("div");
    banner.className = "card load-error-banner";
    banner.innerHTML = `📝 Questions are coming soon. The site is live, content is on its way.`;
    document.querySelector(".container").prepend(banner);
  }

  // Floating back-to-top button — shows once you've scrolled, works on every page
  const backToTopBtn = document.getElementById("backToTopBtn");
  window.addEventListener("scroll", () => {
    backToTopBtn.classList.toggle("visible", window.scrollY > 400);
  });
  backToTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

async function goHomeFromTest() {
  if (!(await showConfirm("Leave this test? Your progress on this attempt will be lost."))) return;
  clearInterval(session && session.timerHandle);
  show(DB.getUser() ? "view-dashboard" : "view-home");
  if (DB.getUser()) renderDashboard();
}

async function cancelTest() {
  if (!(await showConfirm("Cancel this test? Your progress on this attempt will be lost."))) return;
  clearInterval(session && session.timerHandle);
  if (DB.getUser()) {
    renderDashboard();
    show("view-dashboard");
  } else {
    show("view-home");
  }
}

// ---------- Welcome / guest login ----------
function onWelcomeSubmit(e) {
  e.preventDefault();
  const name = document.getElementById("nameInput").value.trim();
  const email = document.getElementById("emailInput").value.trim();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
    alert("Please enter your name and a valid email address.");
    return;
  }
  DB.setUser({ name, email });
  setUserChip();
  renderDashboard();
  show("view-dashboard");
}

// ---------- Contact form (delivered via FormSubmit.co — free, no backend needed) ----------
async function onContactSubmit(e) {
  e.preventDefault();
  const name = document.getElementById("contactName").value.trim();
  const email = document.getElementById("contactEmail").value.trim();
  const message = document.getElementById("contactMessage").value.trim();
  const status = document.getElementById("contactStatus");
  const btn = document.getElementById("contactSubmitBtn");

  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !message) {
    status.textContent = "Please fill in your name, a valid email, and a message.";
    status.className = "contact-status error";
    return;
  }

  btn.disabled = true;
  status.textContent = "Sending...";
  status.className = "contact-status sending";

  try {
    const res = await fetch("https://formsubmit.co/ajax/rlashmibai@gmail.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        email,
        message,
        _subject: `LR PL300 Practice Test: feedback from ${name}`,
      }),
    });
    if (!res.ok) throw new Error("Request failed");
    status.textContent = "Thanks! Your message has been sent.";
    status.className = "contact-status ok";
    document.getElementById("contactForm").reset();
  } catch (err) {
    status.textContent = "Something went wrong sending that. Please try again in a moment.";
    status.className = "contact-status error";
  } finally {
    btn.disabled = false;
  }
}

// ---------- Report a question issue (same FormSubmit.co delivery as the contact form) ----------
let reportTargetQuestion = null; // set when the modal opens; the question currently being reported

function openReportModal(q) {
  reportTargetQuestion = q;
  document.getElementById("reportDetails").value = "";
  document.querySelectorAll("#reportModalOverlay input[type=checkbox]").forEach((cb) => (cb.checked = false));
  document.getElementById("reportStatus").textContent = "";
  document.getElementById("reportStatus").className = "report-status";
  document.getElementById("reportModalOverlay").classList.remove("hidden");
}

function closeReportModal() {
  document.getElementById("reportModalOverlay").classList.add("hidden");
  reportTargetQuestion = null;
}

async function onReportSubmit() {
  const reasons = [...document.querySelectorAll("#reportModalOverlay input[type=checkbox]:checked")].map((cb) => cb.value);
  const details = document.getElementById("reportDetails").value.trim();
  const status = document.getElementById("reportStatus");

  if (!reasons.length) {
    status.textContent = "Please select at least one reason.";
    status.className = "report-status error";
    return;
  }
  if (!reportTargetQuestion) return; // shouldn't happen, but never send a report with no question attached

  const q = reportTargetQuestion;
  status.textContent = "Sending...";
  status.className = "report-status sending";

  try {
    const res = await fetch("https://formsubmit.co/ajax/rlashmibai@gmail.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        _subject: `LR PL300 Practice Test: question report (${q.id})`,
        site: "PL300",
        questionId: q.id,
        testSet: q.testSet,
        section: q.section,
        questionText: stripHtml(q.text).slice(0, 300),
        reasons: reasons.join(", "),
        details: details || "(none)",
      }),
    });
    if (!res.ok) throw new Error("Request failed");
    status.textContent = "Thanks! Your report has been sent.";
    status.className = "report-status ok";
    setTimeout(closeReportModal, 1200);
  } catch (err) {
    status.textContent = "Something went wrong sending that. Please try again.";
    status.className = "report-status error";
  }
}

// ---------- Dashboard ----------
function getSections() {
  return [...new Set(ALL_QUESTIONS.map((q) => q.section))];
}

// Renders the 12 test-set buttons (shared by the no-login Choose Test page and the
// signed-in Dashboard) into the given container element id.
function renderTestGrid(containerId, feedbackMode) {
  const grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = "";
  for (let n = 1; n <= TEST_SET_COUNT; n++) {
    const count = ALL_QUESTIONS.filter((q) => q.testSet === n).length;
    const btn = document.createElement("button");
    btn.className = "test-tile";
    if (count === 0) {
      // No content loaded yet for this set — render it visibly disabled instead
      // of letting a click drop the visitor into a broken, question-less test view.
      btn.classList.add("test-tile-disabled");
      btn.disabled = true;
      btn.innerHTML = `<div class="test-tile-num">${testSetLabel(n)}</div><div class="test-tile-sub">Coming soon</div>`;
    } else {
      btn.innerHTML = `<div class="test-tile-num">${testSetLabel(n)}</div><div class="test-tile-sub">${count} questions</div>`;
      btn.addEventListener("click", () => startTest("testset", n, feedbackMode));
    }
    grid.appendChild(btn);
  }
}

function renderDashboard() {
  const user = DB.getUser();
  document.getElementById("dashGreeting").textContent = `Welcome back, ${user.name}!`;

  renderTestGrid("dashTimedGrid", "deferred");
  renderTestGrid("dashPracticeGrid", "immediate");

  // Section buttons — topic practice always uses immediate (practice-test) feedback
  const sections = getSections();
  const list = document.getElementById("sectionList");
  list.innerHTML = "";
  sections.forEach((sec) => {
    const count = ALL_QUESTIONS.filter((q) => q.section === sec).length;
    const row = document.createElement("div");
    row.className = "section-item";
    row.innerHTML = `
      <div>
        <div>${sec}</div>
        <div class="count">${count} question${count === 1 ? "" : "s"}</div>
      </div>
      <button class="btn secondary" data-section="${sec}">Practice this topic</button>
    `;
    row.querySelector("button").addEventListener("click", () => startTest("section", sec, "immediate"));
    list.appendChild(row);
  });

  // History table
  const history = DB.getHistory(user.email);
  const tbody = document.getElementById("historyBody");
  tbody.innerHTML = "";
  if (history.length === 0) {
    document.getElementById("historyEmpty").style.display = "block";
    document.getElementById("historyTable").style.display = "none";
  } else {
    document.getElementById("historyEmpty").style.display = "none";
    document.getElementById("historyTable").style.display = "table";
    history.forEach((a) => {
      const tr = document.createElement("tr");
      const pct = Math.round((a.score / a.total) * 100);
      tr.innerHTML = `
        <td>${new Date(a.date).toLocaleDateString()} ${new Date(a.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
        <td>${a.mode}</td>
        <td>${a.score}/${a.total}</td>
        <td><span class="badge ${pct >= PASS_PERCENT ? "pass" : "fail"}">${pct}%</span></td>
        <td>${formatDuration(a.timeTakenSec)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

// ---------- Scoring helper ----------
// "ordering" questions are order-sensitive; every other type is a set comparison
// (so answer order for multi-select doesn't matter, but sequence does for ordering).
function isAnswerCorrect(q, given) {
  if (!given || given.length === 0) return false;
  if (q.type === "ordering") {
    return given.length === q.correct.length && given.every((v, i) => v === q.correct[i]);
  }
  if (q.type === "fillblank") {
    return given[0].trim().toLowerCase() === q.correct[0].trim().toLowerCase();
  }
  const a = [...given].sort();
  const b = [...q.correct].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------- Test engine ----------
// feedbackMode: "deferred" (Timed Test — answers/explanations shown only at the end)
//            or "immediate" (Practice Test — check each answer as you go)
function startTest(mode, param, feedbackMode) {
  logTestStart(mode, param);
  let questions;
  let minutes;
  let modeLabel;
  let testName;

  if (mode === "testset") {
    // Fixed order (sorted by id, same numeric sort the admin panel uses) rather
    // than shuffled, so "Question #N" always refers to the same question every
    // attempt and matches the same question's position in the admin panel.
    questions = sortById(ALL_QUESTIONS.filter((q) => q.testSet === param));
    minutes = testSetMinutes(questions.length);
    testName = testSetLabel(param);
    modeLabel = `${testName} (${feedbackMode === "immediate" ? "Practice" : "Timed"})`;
  } else {
    questions = shuffle(ALL_QUESTIONS.filter((q) => q.section === param));
    minutes = SECTION_TEST_MINUTES;
    testName = param;
    modeLabel = param;
  }

  session = {
    mode: modeLabel,
    feedbackMode, // "deferred" | "immediate"
    questions,
    index: 0,
    answers: {}, // qid -> array of selected option ids (order matters for "ordering" type)
    checked: {}, // qid -> true once "Check Answer" has been clicked (immediate mode only)
    flagged: new Set(),
    visited: new Set(), // qid -> seen at least once; visited-but-unanswered = "skipped", never-visited = blank
    startedAt: Date.now(),
    timerMode: feedbackMode === "immediate" ? "countup" : "countdown",
    durationSec: minutes * 60,
    remainingSec: minutes * 60,
    elapsedSec: 0,
    timerHandle: null,
  };

  document.getElementById("modeBadge").textContent = feedbackMode === "immediate" ? "Practice mode" : "Timed exam mode";
  document.getElementById("modeBadge").className = "mode-badge " + (feedbackMode === "immediate" ? "practice" : "timed");
  document.getElementById("testNameLabel").textContent = testName;

  renderQuestionSidebar();
  renderNavGrid();
  renderQuestion();
  startTimer();
  show("view-test");
}

// Numeric-aware sort by id (q2 before q10, not after) — this is the fixed
// order each of the 7 numbered tests uses, so "Question #N" stays stable
// across attempts.
function sortById(arr) {
  return [...arr].sort((a, b) => {
    const aNum = parseInt((a.id.match(/\d+/) || [0])[0], 10);
    const bNum = parseInt((b.id.match(/\d+/) || [0])[0], 10);
    return aNum - bNum || a.id.localeCompare(b.id);
  });
}

function shuffle(arr) {
  arr = [...arr];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startTimer() {
  updateTimerDisplay();
  session.timerHandle = setInterval(() => {
    if (session.timerMode === "countdown") {
      session.remainingSec--;
      updateTimerDisplay();
      if (session.remainingSec <= 0) {
        clearInterval(session.timerHandle);
        finishTest();
      }
    } else {
      session.elapsedSec++;
      updateTimerDisplay();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById("timerDisplay");
  const sec = session.timerMode === "countdown" ? session.remainingSec : session.elapsedSec;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  el.textContent = `${m}:${String(s).padStart(2, "0")}`;
  el.classList.toggle("low", session.timerMode === "countdown" && session.remainingSec <= 60);
}

// ---------- Question sidebar (replaces the old numbered grid) ----------
function renderQuestionSidebar() {
  const list = document.getElementById("questionSidebarList");
  list.innerHTML = "";
  session.questions.forEach((q, i) => {
    const row = document.createElement("div");
    row.className = "sidebar-q-row";
    const preview = stripHtml(q.text);
    row.innerHTML = `
      <span class="sidebar-q-flag">🔖</span>
      <div class="sidebar-q-text">
        <div class="sidebar-q-num">Question ${i + 1}</div>
        <div class="sidebar-q-preview">${preview.length > 70 ? preview.slice(0, 70) + "…" : preview}</div>
      </div>
    `;
    row.addEventListener("click", () => gotoQuestion(i));
    list.appendChild(row);
  });
  updateQuestionSidebar();
}

function updateQuestionSidebar() {
  const list = document.getElementById("questionSidebarList");
  [...list.children].forEach((row, i) => {
    const q = session.questions[i];
    const given = session.answers[q.id];
    const answered = given && given.length > 0;
    row.className = "sidebar-q-row";
    if (i === session.index) row.classList.add("current");
    if (session.feedbackMode === "immediate" && session.checked[q.id]) {
      row.classList.add(isAnswerCorrect(q, given) ? "correct" : "incorrect");
    } else if (answered) {
      row.classList.add("answered");
    } else if (session.visited.has(q.id) && i !== session.index) {
      row.classList.add("skipped");
    }
    if (session.flagged.has(q.id)) row.classList.add("flagged");
  });

  const total = session.questions.length;
  document.getElementById("progressCount").textContent = `${session.index + 1}/${total}`;
  document.getElementById("progressBarFill").style.width = `${Math.round(((session.index + 1) / total) * 100)}%`;

  updateNavGrid();
}

// ---------- Compact overview grid (right side): complete / skipped / flagged ----------
function renderNavGrid() {
  const grid = document.getElementById("navGrid");
  grid.innerHTML = "";
  session.questions.forEach((q, i) => {
    const btn = document.createElement("button");
    btn.textContent = i + 1;
    btn.addEventListener("click", () => gotoQuestion(i));
    grid.appendChild(btn);
  });
  updateNavGrid();
}

function updateNavGrid() {
  const grid = document.getElementById("navGrid");
  [...grid.children].forEach((btn, i) => {
    const q = session.questions[i];
    const given = session.answers[q.id];
    const answered = given && given.length > 0;
    btn.className = "";
    if (i === session.index) btn.classList.add("current");
    if (answered) btn.classList.add("complete");
    else if (session.visited.has(q.id) && i !== session.index) btn.classList.add("skipped");
    if (session.flagged.has(q.id)) btn.classList.add("flagged");
  });
}

function gotoQuestion(i) {
  if (i < 0 || i >= session.questions.length) return;
  session.index = i;
  renderQuestion();
  // Next/Skip/Prev can be pressed after scrolling down to read the previous
  // question's explanation — without this, the new question renders off the
  // top of the viewport and the page just looks blank until the user scrolls
  // back up themselves. On mobile, the verbose question-preview list is
  // hidden and the compact overview strip is reordered above the question
  // (see the max-width: 900px block in style.css), so scrolling to the page
  // top now lands right above the question instead of behind a long list.
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderQuestion() {
  const q = session.questions[session.index];
  session.visited.add(q.id);
  document.getElementById("qTopicBar").textContent = MODULE_NAMES[q.module] || q.section;
  document.getElementById("qNumberLabel").textContent = `Question #${session.index + 1}`;
  // innerHTML (not textContent) so a question can include an <img> if needed
  document.getElementById("questionText").innerHTML = formatQuestionText(q.text);

  const body = document.getElementById("questionBody");
  body.innerHTML = "";

  const selected = session.answers[q.id] || [];
  const locked = session.feedbackMode === "immediate" && session.checked[q.id];

  if (q.type === "single" || q.type === "truefalse") {
    q.options.forEach((opt) => {
      const div = document.createElement("div");
      let cls = "option";
      if (selected.includes(opt.id)) cls += " selected";
      if (locked) {
        cls += " locked";
        if (q.correct.includes(opt.id)) cls += " correct";
        else if (selected.includes(opt.id)) cls += " incorrect";
      }
      div.className = cls;
      div.innerHTML = `<input type="radio" ${selected.includes(opt.id) ? "checked" : ""} disabled /> <span class="option-text">${formatTrueFalseOptionText(opt.text)}</span>`;
      if (!locked) {
        div.addEventListener("click", () => {
          session.answers[q.id] = [opt.id];
          renderQuestion();
          updateQuestionSidebar();
        });
      }
      body.appendChild(div);
    });
  } else if (q.type === "multi") {
    const hint = document.createElement("div");
    hint.className = "question-meta";
    hint.style.marginBottom = "8px";
    hint.textContent = "Select all that apply";
    body.appendChild(hint);
    q.options.forEach((opt) => {
      const div = document.createElement("div");
      let cls = "option";
      if (selected.includes(opt.id)) cls += " selected";
      if (locked) {
        cls += " locked";
        if (q.correct.includes(opt.id)) cls += " correct";
        else if (selected.includes(opt.id)) cls += " incorrect";
      }
      div.className = cls;
      div.innerHTML = `<input type="checkbox" ${selected.includes(opt.id) ? "checked" : ""} disabled /> <span class="option-text">${formatTrueFalseOptionText(opt.text)}</span>`;
      if (!locked) {
        div.addEventListener("click", () => {
          const set = new Set(selected);
          set.has(opt.id) ? set.delete(opt.id) : set.add(opt.id);
          session.answers[q.id] = [...set];
          renderQuestion();
          updateQuestionSidebar();
        });
      }
      body.appendChild(div);
    });
  } else if (q.type === "fillblank") {
    if (q.clue) {
      const clue = document.createElement("div");
      clue.className = "question-meta";
      clue.style.marginBottom = "8px";
      clue.textContent = `Clue: ${q.clue}`;
      body.appendChild(clue);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type your answer";
    input.value = selected[0] || "";
    input.disabled = locked;
    if (locked) {
      input.classList.add(isAnswerCorrect(q, selected) ? "correct-input" : "incorrect-input");
    }
    input.addEventListener("input", () => {
      session.answers[q.id] = [input.value];
      updateQuestionSidebar();
      const checkBtn = document.querySelector("#checkAnswerArea button");
      if (checkBtn) checkBtn.disabled = input.value.trim().length === 0;
    });
    body.appendChild(input);
  } else if (q.type === "ordering") {
    const hint = document.createElement("div");
    hint.className = "question-meta";
    hint.style.marginBottom = "8px";
    hint.textContent = locked ? "Correct order shown below" : "Use the arrows to put these in the correct order";
    body.appendChild(hint);

    // Initialize order with option order the first time it's viewed
    let order = selected.length ? selected : q.options.map((o) => o.id);
    session.answers[q.id] = order;

    const ul = document.createElement("ul");
    ul.className = "order-list";
    order.forEach((optId, idx) => {
      const opt = q.options.find((o) => o.id === optId);
      const li = document.createElement("li");
      if (locked) li.className = optId === q.correct[idx] ? "correct" : "incorrect";
      li.innerHTML = `
        <span>${idx + 1}. ${opt.text}</span>
        ${
          locked
            ? ""
            : `<span class="order-btns">
                <button type="button" data-dir="up" ${idx === 0 ? "disabled" : ""}>↑</button>
                <button type="button" data-dir="down" ${idx === order.length - 1 ? "disabled" : ""}>↓</button>
              </span>`
        }
      `;
      if (!locked) {
        li.querySelector('[data-dir="up"]').addEventListener("click", () => moveOrderItem(q, idx, -1));
        li.querySelector('[data-dir="down"]').addEventListener("click", () => moveOrderItem(q, idx, 1));
      }
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  // Flag toggle (checkbox — checked state is intrinsic, so no re-render needed here)
  const flagEl = document.getElementById("flagToggle");
  flagEl.checked = session.flagged.has(q.id);
  flagEl.onchange = () => {
    session.flagged.has(q.id) ? session.flagged.delete(q.id) : session.flagged.add(q.id);
    updateQuestionSidebar();
  };

  // Report Question button — rebound each render so it always reports the
  // question currently on screen.
  document.getElementById("reportQuestionBtn").onclick = () => openReportModal(q);

  // Check-answer / instant-feedback area (Practice Test mode only)
  const checkArea = document.getElementById("checkAnswerArea");
  checkArea.innerHTML = "";
  if (session.feedbackMode === "immediate") {
    if (!locked) {
      const hasAnswer = selected.length > 0;
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Check Answer";
      btn.disabled = !hasAnswer;
      btn.addEventListener("click", () => {
        session.checked[q.id] = true;
        renderQuestion();
        updateQuestionSidebar();
      });
      checkArea.appendChild(btn);
    } else {
      const given = session.answers[q.id] || [];
      const correct = isAnswerCorrect(q, given);
      const correctText =
        q.type === "fillblank"
          ? q.correct[0]
          : q.options.filter((o) => q.correct.includes(o.id)).map((o) => o.text).join(", ");
      const hasOptionExpl =
        (q.type === "single" || q.type === "multi" || q.type === "truefalse") &&
        Array.isArray(q.options) &&
        q.options.some((o) => o.explanation);
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <div class="verdict-banner ${correct ? "correct" : "incorrect"}">
          <div class="verdict-title">${correct ? "✓ Correct" : "✗ Incorrect"}</div>
          ${!correct && q.type !== "ordering" && !hasOptionExpl ? `<div class="verdict-answer">Correct answer: ${correctText}</div>` : ""}
        </div>
        ${renderExplanationBreakdown(q, given)}
      `;
      checkArea.appendChild(wrap);
    }
  }

  // Prev/Next/Submit — always available. You can skip a question (answered, flagged,
  // or blank) and come back to it later via the sidebar, same as the real exam.
  const isLast = session.index === session.questions.length - 1;
  document.getElementById("prevQBtn").disabled = session.index === 0;
  document.getElementById("nextQBtn").textContent = isLast ? "Submit Test →" : "Skip / Next →";
  document.getElementById("nextQBtn").disabled = false;

  updateQuestionSidebar();
}

function moveOrderItem(q, idx, delta) {
  const order = session.answers[q.id];
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  renderQuestion();
}

async function onSubmitTest() {
  const unanswered = session.questions.filter((q) => !session.answers[q.id] || session.answers[q.id].length === 0).length;
  const msg = unanswered > 0
    ? `You have ${unanswered} unanswered question(s). Submit anyway?`
    : "Submit this test now?";
  if (!(await showConfirm(msg))) return;
  finishTest();
}

function finishTest() {
  clearInterval(session.timerHandle);

  let correctCount = 0;
  const reviewItems = session.questions.map((q) => {
    const given = session.answers[q.id] || [];
    const isCorrect = isAnswerCorrect(q, given);
    if (isCorrect) correctCount++;
    return { question: q, given, isCorrect };
  });

  const timeTakenSec =
    session.timerMode === "countdown" ? session.durationSec - session.remainingSec : session.elapsedSec;

  const attempt = {
    date: Date.now(),
    mode: session.mode,
    score: correctCount,
    total: session.questions.length,
    timeTakenSec,
    review: reviewItems.map((r) => ({
      qid: r.question.id,
      given: r.given,
      isCorrect: r.isCorrect,
    })),
  };

  const user = DB.getUser();
  if (user) {
    DB.saveAttempt(user.email, attempt);
  } // else: guest session (started from the home page with no sign-in) — score still shows, just isn't saved

  renderResults(reviewItems, attempt);
  show("view-results");
}

function renderResults(reviewItems, attempt) {
  const pct = Math.round((attempt.score / attempt.total) * 100);
  document.getElementById("scorePct").textContent = `${pct}%`;
  document.getElementById("scoreDetail").textContent =
    `${attempt.score} / ${attempt.total} correct · ${attempt.mode} · ${formatDuration(attempt.timeTakenSec)}`;
  const badge = document.getElementById("passBadge");
  badge.textContent = pct >= PASS_PERCENT ? "Pass" : "Below passing (70%)";
  badge.className = "badge " + (pct >= PASS_PERCENT ? "pass" : "fail");

  document.getElementById("backToDashBtn").textContent = DB.getUser()
    ? "Back to dashboard"
    : "Done - Move to Next Test";

  // Section breakdown
  const bySection = {};
  reviewItems.forEach((r) => {
    const sec = r.question.section;
    bySection[sec] = bySection[sec] || { correct: 0, total: 0 };
    bySection[sec].total++;
    if (r.isCorrect) bySection[sec].correct++;
  });
  const secBody = document.getElementById("sectionBreakdownBody");
  secBody.innerHTML = "";
  Object.entries(bySection).forEach(([sec, s]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${sec}</td><td>${s.correct}/${s.total}</td>`;
    secBody.appendChild(tr);
  });

  // Full review
  const reviewList = document.getElementById("reviewList");
  reviewList.innerHTML = "";
  reviewItems.forEach((r, i) => {
    const q = r.question;
    const div = document.createElement("div");
    div.className = "review-item";
    const givenText =
      q.type === "fillblank"
        ? r.given[0] || "(no answer)"
        : q.options.filter((o) => r.given.includes(o.id)).map((o) => o.text).join(", ") || "(no answer)";
    const correctText =
      q.type === "fillblank"
        ? q.correct[0]
        : q.options.filter((o) => q.correct.includes(o.id)).map((o) => o.text).join(", ");
    const hasOptionExpl =
      (q.type === "single" || q.type === "multi" || q.type === "truefalse") &&
      Array.isArray(q.options) &&
      q.options.some((o) => o.explanation);
    div.innerHTML = `
      <div class="question-meta">Question ${i + 1} · ${MODULE_NAMES[q.module] || q.section}</div>
      <div class="question-text" style="font-size:0.98rem;">${formatQuestionText(q.text)}</div>
      <div class="verdict-banner ${r.isCorrect ? "correct" : "incorrect"}">
        <div class="verdict-title">${r.isCorrect ? "✓ Correct" : "✗ Incorrect"}</div>
        <div class="verdict-answer">Your answer: ${givenText}</div>
        ${!r.isCorrect && !hasOptionExpl ? `<div class="verdict-answer">Correct answer: ${correctText}</div>` : ""}
      </div>
      ${renderExplanationBreakdown(q, r.given || [])}
      <div class="btn-row" style="justify-content:flex-end;">
        <button class="btn ghost small report-question-btn" type="button">⚠️ Report Question</button>
      </div>
    `;
    div.querySelector(".report-question-btn").addEventListener("click", () => openReportModal(q));
    reviewList.appendChild(div);
  });
}

boot();
