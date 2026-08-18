# Security Policy

## About This Project

LR PL-300 Practice Test is a static website (HTML, CSS, JavaScript) with no backend server and no database. It doesn't collect passwords, doesn't store personal data on any server, and doesn't process payments. Optional sign-in (name and email, to save score history) is stored only in the visitor's own browser via `localStorage`, never transmitted anywhere.

Because of this, many typical web app vulnerability categories (SQL injection, auth bypass, server-side data leaks) don't apply here. That said, we still take reports of anything that could put visitors at risk seriously, including:

- Cross-site scripting (XSS) or other content-injection issues in how question content, explanations, or user input are rendered
- Any exposed credential, API key, or webhook URL that shouldn't be public
- Any way the site's Content Security or service worker behavior could be abused to serve malicious content to visitors

## Supported Versions

This project is a single, continuously-updated website with no version branches, only `main`. Security fixes are applied directly to `main` and go live automatically via GitHub Pages, typically within a few minutes of a fix being merged.

## Reporting a Vulnerability

If you find a security issue, please **do not open a public GitHub issue** for it. Instead, email **rlashmibai@gmail.com** directly with:

- A description of the issue and its potential impact
- Steps to reproduce it, if possible

You should expect an acknowledgment within a few days. Since this is a personal, unpaid project, there's no bug bounty, but genuine reports are appreciated and will be credited (with permission) once fixed.
