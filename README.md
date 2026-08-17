# PL-300 Practice Test

PL-300 | 6 Practice Tests + 1 Dedicated DAX Test | 600+ Q's

A free, public PL-300 (Microsoft Power BI Data Analyst) practice test — no account or
password required, just a name + email to save your progress. Built as a static web app so it
can be hosted for free and reached by anyone.

## Live features

- Guest login (name + email, no password) — saves score history on this device
- Full timed practice exam, or practice one topic at a time
- Question formats: single-choice, multi-select, true/false, ordering, matching, fill-in-the-blank
- Instant explanation shown after each attempt, plus a full review screen
- Score breakdown by PL-300 exam domain
- Works on mobile and desktop (responsive, installable as a home-screen app)

## Project structure

```
index.html      Page structure / all views (welcome, dashboard, test, results)
style.css       Styling (mobile-first, responsive)
app.js          App logic: guest login, quiz engine, scoring, results rendering
questions.json  The question bank (see format below) — currently empty, content pending
manifest.json   PWA manifest (enables "Add to Home Screen")
```

## Question format

Each question in `questions.json` looks like this:

```json
{
  "id": "q1",
  "type": "single",
  "testSet": 1,
  "section": "Prepare the data",
  "text": "Question text goes here?",
  "options": [
    { "id": "a", "text": "Option A" },
    { "id": "b", "text": "Option B" }
  ],
  "correct": ["b"],
  "explanation": "Why b is correct, shown after the visitor answers."
}
```

- `type`: `single` (one correct answer), `multi` (select all that apply), `truefalse`,
  `fillblank`, or `ordering` (put items in the correct sequence — `correct` is the array of
  option ids in order).
- `section`: groups questions into topic-wise practice and the results breakdown. Must be one
  of the four official PL-300 domains (see `EXAM_WEIGHTS` in `app.js`):
  `Prepare the data`, `Model the data`, `Visualize and analyze the data`, `Manage and secure
  Power BI`.
- `testSet`: `1`–`6` for the six main 100-question practice sets, `7` for the dedicated DAX
  practice set (see `DAX_TEST_SET_ID` in `app.js`).

## Running locally

Any static file server works, e.g.:

```
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deployment

Currently a client-only static app (data is saved to the browser's `localStorage`, per device).
