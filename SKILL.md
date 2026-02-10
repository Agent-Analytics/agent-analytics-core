---
name: analytics-tracking
description: Add lightweight, privacy-friendly analytics tracking to any website. Use when the user wants to track page views, custom events, or monitor if a project is alive and growing.
---

# Agent Analytics — Add tracking to any website

You are adding analytics tracking to a website using Agent Analytics. This is a lightweight analytics platform built for developers who ship lots of projects and want their AI agent to monitor them.

## Philosophy

You are NOT Mixpanel. Don't track everything. Track only what answers: **"Is this project alive and growing?"**

For a typical site, that's 3-5 custom events max on top of automatic page views.

## Step 1: Add the tracking snippet

Add before `</body>`:

```html
<script src="https://api.agentanalytics.sh/tracker.js"
  data-project="PROJECT_NAME"
  data-token="PROJECT_TOKEN"></script>
```

This auto-tracks `page_view` events with path, referrer, browser, OS, device, screen size, and UTM params. You do NOT need to add custom page_view events.

## Step 1b: Discover existing events and properties (existing projects)

If tracking is already set up for this project, check what events and property keys are already being used so you reuse the same naming conventions:

```bash
npx agent-analytics properties-received PROJECT_NAME
```

This shows which property keys each event type uses (e.g. `cta_click → id`, `signup → method`). Match the existing naming before adding new events.

## Step 2: Add custom events to important actions

Use `onclick` handlers on the elements that matter. Pattern:

```html
<a href="..." onclick="window.aa?.track('EVENT_NAME', {id: 'ELEMENT_ID'})">
```

The `?.` operator ensures it doesn't error if the tracker hasn't loaded yet (edge case — all user-initiated clicks happen after load).

## Standard events for 80% of SaaS sites

Pick the ones that apply. Most sites need 2-4 of these:

| Event | When to fire | Properties |
|-------|-------------|------------|
| `cta_click` | User clicks a call-to-action button | `id` (which button) |
| `signup` | User creates an account | `method` (github/google/email) |
| `login` | User returns and logs in | `method` |
| `feature_used` | User engages with a core feature | `feature` (which one) |
| `checkout` | User starts a payment flow | `plan` (free/pro/etc) |
| `error` | Something went wrong visibly | `message`, `page` |

### What to track as `cta_click`

Only buttons that indicate conversion intent:
- "Get Started" / "Sign Up" / "Try Free" buttons
- "Upgrade" / "Buy" / pricing CTAs
- Primary navigation to signup/dashboard
- "View on GitHub" / "Star" (for open source projects)

### What NOT to track
- Every link or button (too noisy)
- Scroll depth (not actionable)
- Form field interactions (too granular)
- Footer links (low signal)
- Social sharing buttons (vanity metric)

## Property naming rules

- Use `snake_case`: `hero_get_started` not `heroGetStarted`
- The `id` property identifies WHICH element: short, descriptive
- Name IDs as `section_action`: `hero_signup`, `pricing_pro`, `nav_dashboard`
- Don't encode data the page_view already captures (path, referrer, browser)

## Step 3: Test immediately

After adding tracking, verify it works:

```bash
# Option A: Open browser console on your site and run:
window.aa.track('test_event', {source: 'manual_test'})

# Option B: Click around your site, then check:
npx agent-analytics events PROJECT_NAME

# You should see your events within seconds.
```

## Example: Landing page with pricing

```html
<!-- Hero CTAs -->
<a href="/signup" onclick="window.aa?.track('cta_click',{id:'hero_get_started'})">
  Get Started Free
</a>
<a href="#pricing" onclick="window.aa?.track('cta_click',{id:'hero_see_pricing'})">
  See Pricing →
</a>

<!-- Pricing CTAs -->
<a href="/signup?plan=free" onclick="window.aa?.track('cta_click',{id:'pricing_free'})">
  Try Free
</a>
<a href="/signup?plan=pro" onclick="window.aa?.track('cta_click',{id:'pricing_pro'})">
  Get Started →
</a>

<!-- Nav -->
<a href="/dashboard" onclick="window.aa?.track('cta_click',{id:'nav_dashboard'})">
  Dashboard
</a>
```

## Example: SaaS app with auth

```js
// After successful signup
window.aa?.track('signup', {method: 'github'});

// After login
window.aa?.track('login', {method: 'google'});

// When user does the main thing your app does
window.aa?.track('feature_used', {feature: 'create_project'});

// On checkout page
window.aa?.track('checkout', {plan: 'pro'});

// In error handler
window.aa?.track('error', {message: err.message, page: location.pathname});
```

## Querying the data

Your AI agent checks on your projects:

```bash
# Daily check: how's the project doing?
npx agent-analytics stats my-site --days 7

# What events are coming in?
npx agent-analytics events my-site

# What property keys exist for each event type?
npx agent-analytics properties-received my-site

# Direct API (for agents without npx):
curl "https://api.agentanalytics.sh/stats?project=my-site&days=7" \
  -H "X-API-Key: $AGENT_ANALYTICS_KEY"
```

## First-time setup (if the project doesn't exist yet)

```bash
# 1. Login (one time)
npx agent-analytics login --token aak_YOUR_API_KEY

# 2. Create the project
npx agent-analytics init my-site --domain https://mysite.com

# 3. Add the snippet from step 1 to your site

# 4. Deploy your site, click around, then verify:
npx agent-analytics events my-site
```
