# Tarsee UI Overhaul — Claude Desktop Feel + PWA Enhancement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Tarsee's vanilla HTML/CSS/JS frontend from "functional but janky" to Claude Desktop-level polish — mobile-first, consistent spacing, proper typography, smooth transitions, enhanced PWA — without a framework rewrite.

**Architecture:** Add Tailwind CSS via CDN `<script>` tag for utility classes. Adopt shadcn/ui design tokens (CSS variables) mapped to Claude Desktop's warm charcoal palette. Rewrite all 6 CSS files from scratch using a proper design system. Move all 67+ inline styles from HTML to CSS. Fix every JS-created inline style. Enhance PWA with proper offline page, better caching, and full icon set.

**Tech Stack:** Tailwind CSS (CDN), vanilla CSS custom properties (shadcn-style tokens), vanilla JS (unchanged logic), PWA Service Worker v2.

---

## File Structure

### Files to Create
- `src/public/css/tokens.css` — Design system tokens (colors, spacing, typography, radius, shadows, z-index, animations)
- `src/public/css/utilities.css` — Utility classes for common patterns (display toggles, spacing, text styles)
- `src/public/offline.html` — Offline fallback page for PWA

### Files to Rewrite (full replacement)
- `src/public/css/style.css` — Main layout, sidebar, topbar, buttons, forms, settings, login, welcome, responsive
- `src/public/css/chat.css` — Session bar, messages, tool blocks, thinking, streaming, command palette, attachments
- `src/public/css/voice.css` — Voice panel, orb, conversation bubbles, waveform
- `src/public/css/console.css` — Console panel, entries, toolbar
- `src/public/css/files.css` — File manager panel
- `src/public/manifest.json` — Enhanced PWA manifest
- `src/public/sw.js` — Service Worker v2 with proper caching + offline page

### Files to Modify
- `src/public/index.html` — Add Tailwind CDN, link new CSS files, remove all inline styles, add semantic classes
- `src/public/js/chat.js` — Remove inline styles from HTML templates, use CSS classes instead
- `src/public/js/voice.js` — Remove inline styles from dynamic elements
- `src/public/js/console.js` — Remove inline style from system messages
- `src/public/js/files.js` — Remove inline styles from templates
- `src/public/js/settings.js` — Remove inline style color assignments
- `src/public/js/app.js` — Remove inline style for menu button, use CSS class toggle
- `src/public/js/sw-register.js` — Add cache-busting version parameter

---

## Design System Reference

### Claude Desktop Palette (Dark Mode)
```
Background:      #1a1a1a (deep charcoal, warm)
Surface:         #2b2a27 (card/elevated)  
Surface Hover:   #353430 (interactive)
Border:          #3a3935 (subtle, warm)
Border Light:    #2f2e2b (ultra subtle)

Text:            #ececec (primary)
Text Secondary:  #a8a8a0 (muted body)
Text Muted:      #6b6b63 (hints, labels)

Accent:          #c45a35 (terracotta orange — Claude brand)
Accent Hover:    #d4663d
Accent Subtle:   rgba(196, 90, 53, 0.12)
Accent Glow:     rgba(196, 90, 53, 0.25)

Success:         #34d399
Warning:         #fbbf24
Danger:          #f87171
Info:            #60a5fa

Thinking:        #a78bfa (purple)
Tool Call:       #60a5fa (blue)
Tool Response:   #4ade80 (green)
```

### Typography Scale
```
--text-xs:   11px   (badges, timestamps)
--text-sm:   12px   (captions, labels)
--text-base: 14px   (body text)
--text-md:   15px   (chat messages)
--text-lg:   16px   (input, mobile body)
--text-xl:   18px   (section headers)
--text-2xl:  22px   (page titles)
--text-3xl:  26px   (settings h2)

Line heights: 1.4 (tight), 1.5 (normal), 1.6 (relaxed)
```

### Spacing Scale (4px base)
```
--space-0:  0
--space-1:  4px
--space-2:  8px
--space-3:  12px
--space-4:  16px
--space-5:  20px
--space-6:  24px
--space-8:  32px
--space-10: 40px
--space-12: 48px
```

### Radius Scale
```
--radius-sm:   6px   (small pills, badges)
--radius-md:   8px   (buttons, inputs)
--radius-lg:   12px  (cards, sections)
--radius-xl:   16px  (composer, modals)
--radius-2xl:  20px  (large panels)
--radius-full: 9999px (circles, pills)
```

### Z-Index Scale
```
--z-base:     0
--z-sticky:   10   (topbar)
--z-overlay:  20   (drag-over)
--z-console:  40   (console panel)
--z-sidebar:  50   (mobile sidebar + overlay)
--z-panels:   60   (agents panel)
--z-files:    70   (file manager)
--z-voice:    80   (voice panel)
--z-toast:    100  (notifications)
--z-modal:    200  (delete modal, dialogs)
```

### Animation Tokens
```
--duration-fast:   100ms
--duration-normal: 150ms
--duration-slow:   300ms
--duration-spring: 500ms

--ease-default: cubic-bezier(0.4, 0, 0.2, 1)
--ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1)
--ease-ios:     cubic-bezier(0.32, 0.72, 0, 1)
```

---

## Dynamic Classes Reference (from JS audit — CSS MUST support all of these)

```
Sidebar:        .open (sidebar), .active (overlay)
Voice Orb:      .idle, .listening, .processing, .speaking, .drag-cancel
Voice Panel:    .active
Messages:       .message.user, .message.assistant, .grouped, .streaming-cursor
Input:          .stop-mode, .voice-active, .voice-transcribing, .drag-cancel
Chat Area:      .drag-over
Tool Blocks:    .tool-indicator.running/.success/.error
Thinking:       .chat-thinking, .block-thinking, .block-streaming-indicator
Command:        .command-palette-item.active
Console:        .open, .maximized, .active (badge + toggle btn)
Settings:       .settings-page.open, .settings-tab.active, .settings-tab-panel.active
Save Status:    .save-status.saving, .save-status.saved
Delete Modal:   .delete-modal-overlay (dynamically created)
Toast:          .toast, .toast.error, .toast.success, .toast.info
Drag Upload:    .clone-upload.dragover
```

---

## Tasks

### Task 1: Design Tokens Foundation

**Files:**
- Create: `src/public/css/tokens.css`

- [ ] **Step 1: Create tokens.css with full design system**

```css
/* ===== Tarsee Design Tokens — Claude Desktop Aesthetic ===== */

:root {
  /* === Colors === */
  --bg: #1a1a1a;
  --bg-surface: #2b2a27;
  --bg-surface-hover: #353430;
  --bg-elevated: #2b2a27;
  --bg-input: #1f1e1b;
  --bg-sidebar: #1e1e1c;

  --border: #3a3935;
  --border-light: #2f2e2b;
  --border-hover: #4a4945;

  --text: #ececec;
  --text-secondary: #a8a8a0;
  --text-muted: #6b6b63;
  --text-inverse: #1a1a1a;

  --accent: #c45a35;
  --accent-hover: #d4663d;
  --accent-subtle: rgba(196, 90, 53, 0.12);
  --accent-glow: rgba(196, 90, 53, 0.25);

  --success: #34d399;
  --success-subtle: rgba(52, 211, 153, 0.12);
  --warning: #fbbf24;
  --warning-subtle: rgba(251, 191, 36, 0.12);
  --danger: #f87171;
  --danger-hover: #ef4444;
  --danger-subtle: rgba(248, 113, 113, 0.12);
  --info: #60a5fa;
  --info-subtle: rgba(96, 165, 250, 0.12);

  --thinking: #a78bfa;
  --thinking-subtle: rgba(167, 139, 250, 0.12);
  --thinking-border: rgba(167, 139, 250, 0.25);
  --tool-call: #60a5fa;
  --tool-call-subtle: rgba(96, 165, 250, 0.12);
  --tool-call-border: rgba(96, 165, 250, 0.25);
  --tool-response: #4ade80;
  --tool-response-subtle: rgba(74, 222, 128, 0.12);
  --tool-response-border: rgba(74, 222, 128, 0.25);

  /* === Typography === */
  --font-body: 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;

  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 14px;
  --text-md: 15px;
  --text-lg: 16px;
  --text-xl: 18px;
  --text-2xl: 22px;
  --text-3xl: 26px;

  --leading-tight: 1.4;
  --leading-normal: 1.5;
  --leading-relaxed: 1.6;

  --tracking-tight: -0.3px;
  --tracking-normal: 0;
  --tracking-wide: 0.5px;

  /* === Spacing (4px base) === */
  --space-0: 0;
  --space-px: 1px;
  --space-0-5: 2px;
  --space-1: 4px;
  --space-1-5: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* === Radius === */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;
  --radius-full: 9999px;

  /* === Shadows (warm, not cold blue-black) === */
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.25);
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.4);
  --shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.5);

  /* === Z-Index === */
  --z-base: 0;
  --z-sticky: 10;
  --z-overlay: 20;
  --z-console: 40;
  --z-sidebar: 50;
  --z-sidebar-overlay: 49;
  --z-panels: 60;
  --z-files: 70;
  --z-voice: 80;
  --z-toast: 100;
  --z-modal: 200;

  /* === Motion === */
  --duration-fast: 100ms;
  --duration-normal: 150ms;
  --duration-slow: 300ms;
  --duration-spring: 500ms;

  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-ios: cubic-bezier(0.32, 0.72, 0, 1);

  /* === Layout === */
  --sidebar-width: 260px;
  --topbar-height: 52px;
  --topbar-height-mobile: 48px;
  --input-max-width: 740px;
  --message-max-width: 740px;
  --settings-sidebar-width: 180px;
  --console-height: 340px;
}

/* === Global Keyframes === */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fadeOut {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(8px); }
}

@keyframes slideIn {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); }
  50% { box-shadow: 0 0 0 8px transparent; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* === Reduced Motion === */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: Verify file created correctly**

Run: `wc -l src/public/css/tokens.css`
Expected: ~160 lines

- [ ] **Step 3: Commit**

```bash
git add src/public/css/tokens.css
git commit -m "feat: add design tokens — Claude Desktop palette, spacing, typography"
```

---

### Task 2: Utility Classes

**Files:**
- Create: `src/public/css/utilities.css`

- [ ] **Step 1: Create utilities.css**

```css
/* ===== Tarsee Utilities — Common patterns as classes ===== */

/* --- Display --- */
.hidden { display: none !important; }
.flex { display: flex; }
.inline-flex { display: inline-flex; }
.grid { display: grid; }
.block { display: block; }

/* --- Visibility (for JS toggle without layout shift) --- */
.invisible { visibility: hidden; }
.visible { visibility: visible; }

/* --- Flex shortcuts --- */
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.justify-between { justify-content: space-between; }
.flex-col { flex-direction: column; }
.flex-1 { flex: 1; }
.flex-shrink-0 { flex-shrink: 0; }
.flex-wrap { flex-wrap: wrap; }
.gap-1 { gap: var(--space-1); }
.gap-2 { gap: var(--space-2); }
.gap-3 { gap: var(--space-3); }
.gap-4 { gap: var(--space-4); }
.gap-6 { gap: var(--space-6); }

/* --- Spacing (margins) --- */
.mt-1 { margin-top: var(--space-1); }
.mt-2 { margin-top: var(--space-2); }
.mt-3 { margin-top: var(--space-3); }
.mt-4 { margin-top: var(--space-4); }
.mt-6 { margin-top: var(--space-6); }
.mb-1 { margin-bottom: var(--space-1); }
.mb-2 { margin-bottom: var(--space-2); }
.mb-3 { margin-bottom: var(--space-3); }
.mb-4 { margin-bottom: var(--space-4); }
.mb-6 { margin-bottom: var(--space-6); }

/* --- Spacing (padding) --- */
.p-2 { padding: var(--space-2); }
.p-3 { padding: var(--space-3); }
.p-4 { padding: var(--space-4); }
.p-6 { padding: var(--space-6); }
.px-3 { padding-left: var(--space-3); padding-right: var(--space-3); }
.px-4 { padding-left: var(--space-4); padding-right: var(--space-4); }
.py-2 { padding-top: var(--space-2); padding-bottom: var(--space-2); }
.py-3 { padding-top: var(--space-3); padding-bottom: var(--space-3); }

/* --- Text --- */
.text-xs { font-size: var(--text-xs); }
.text-sm { font-size: var(--text-sm); }
.text-base { font-size: var(--text-base); }
.text-md { font-size: var(--text-md); }
.text-lg { font-size: var(--text-lg); }
.text-xl { font-size: var(--text-xl); }
.text-2xl { font-size: var(--text-2xl); }

.font-medium { font-weight: 500; }
.font-semibold { font-weight: 600; }
.font-bold { font-weight: 700; }

.text-primary { color: var(--text); }
.text-secondary { color: var(--text-secondary); }
.text-muted { color: var(--text-muted); }
.text-accent { color: var(--accent); }
.text-danger { color: var(--danger); }
.text-success { color: var(--success); }

.font-mono { font-family: var(--font-mono); }
.uppercase { text-transform: uppercase; }
.tracking-wide { letter-spacing: var(--tracking-wide); }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whitespace-nowrap { white-space: nowrap; }

/* --- Width/Height --- */
.w-full { width: 100%; }
.h-full { height: 100%; }
.min-w-0 { min-width: 0; }

/* --- Overflow --- */
.overflow-hidden { overflow: hidden; }
.overflow-y-auto { overflow-y: auto; }
.overflow-x-auto { overflow-x: auto; }

/* --- Border --- */
.border { border: 1px solid var(--border); }
.border-light { border: 1px solid var(--border-light); }
.border-b { border-bottom: 1px solid var(--border); }
.border-b-light { border-bottom: 1px solid var(--border-light); }
.rounded-sm { border-radius: var(--radius-sm); }
.rounded-md { border-radius: var(--radius-md); }
.rounded-lg { border-radius: var(--radius-lg); }
.rounded-xl { border-radius: var(--radius-xl); }
.rounded-full { border-radius: var(--radius-full); }

/* --- Backgrounds --- */
.bg-base { background: var(--bg); }
.bg-surface { background: var(--bg-surface); }
.bg-elevated { background: var(--bg-elevated); }
.bg-accent-subtle { background: var(--accent-subtle); }

/* --- Cursor --- */
.cursor-pointer { cursor: pointer; }

/* --- Transitions --- */
.transition { transition: all var(--duration-normal) var(--ease-default); }
.transition-fast { transition: all var(--duration-fast) var(--ease-default); }
.transition-slow { transition: all var(--duration-slow) var(--ease-default); }

/* --- Object fit (for avatar images) --- */
.object-cover { object-fit: cover; }

/* --- Accessibility --- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* --- Safe area padding (iOS PWA) --- */
.safe-top { padding-top: env(safe-area-inset-top, 0px); }
.safe-bottom { padding-bottom: env(safe-area-inset-bottom, 0px); }
```

- [ ] **Step 2: Commit**

```bash
git add src/public/css/utilities.css
git commit -m "feat: add utility classes — spacing, text, layout helpers"
```

---

### Task 3: HTML Cleanup — Remove Inline Styles + Add Tailwind CDN

**Files:**
- Modify: `src/public/index.html`

This is the biggest HTML task. Every inline `style=""` must be removed and replaced with either a CSS class from tokens/utilities or a named component class. Also adds Tailwind CDN and new CSS file links.

- [ ] **Step 1: Update `<head>` — add Tailwind CDN + new CSS files**

In `index.html`, replace the current CSS link block (lines 17-22) with:

```html
  <!-- Design System -->
  <link rel="stylesheet" href="/css/tokens.css">
  <link rel="stylesheet" href="/css/utilities.css">
  <!-- Tailwind CDN (utility classes) -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            surface: '#2b2a27',
            'surface-hover': '#353430',
            accent: { DEFAULT: '#c45a35', hover: '#d4663d', subtle: 'rgba(196,90,53,0.12)' },
          },
          fontFamily: {
            body: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
            mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'monospace'],
          },
        },
      },
    }
  </script>
  <!-- Component Styles -->
  <link rel="stylesheet" href="/css/style.css">
  <link rel="stylesheet" href="/css/chat.css">
  <link rel="stylesheet" href="/css/voice.css">
  <link rel="stylesheet" href="/css/console.css">
  <link rel="stylesheet" href="/css/files.css">
  <!-- Icons -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.1/src/regular/style.css">
  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

Also update `<meta name="theme-color">` to `#1a1a1a` (new bg color).

- [ ] **Step 2: Remove ALL inline styles from HTML elements**

Go through every element with `style=""` and replace with CSS classes. Key replacements:

| Inline style | Replace with |
|---|---|
| `style="display:none"` | class `hidden` (JS toggles this) |
| `style="width:100%;height:100%;object-fit:cover;border-radius:inherit"` | class `avatar-img` (define in style.css) |
| `style="width:100%; padding:12px; font-size:15px; margin-top:8px"` | class `btn btn-primary btn-block` |
| `style="padding: 10px 12px; border-top: 1px solid var(--border-light)"` | class `sidebar-footer` |
| `style="font-family: var(--font-mono); font-size: 12px"` | class `textarea-mono` |
| `style="margin-bottom:8px"` / `style="margin-top:12px"` etc | Tailwind: `class="mb-2"` / `class="mt-3"` |
| `style="display:flex;gap:4px"` | Tailwind: `class="flex gap-1"` |
| `style="color:var(--text-muted);font-size:13px"` | class `text-muted text-sm` |
| `style="display:none; border:1px solid..."` (skill dialog) | class `skill-dialog hidden` |

- [ ] **Step 3: Add semantic classes where inline styles were layout-critical**

Add these classes to elements that need them:
- `.sidebar-footer` on the settings button wrapper div
- `.avatar-img` on all logo/avatar `<img>` tags
- `.btn-block` for full-width buttons
- `.textarea-mono` for all monospace textareas
- `.settings-hint` for hint text with margin
- `.skill-dialog` for the skill create/edit dialog

- [ ] **Step 4: Verify no inline styles remain**

Run: `grep -c 'style=' src/public/index.html`
Expected: 0 (or only the hidden `display:none` elements that JS toggles — these are OK to keep for initial state)

Actually — `style="display:none"` on elements JS toggles (login, setup, app, chat, input, settings panels) must stay because JS uses `element.style.display`. But change all others.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "refactor: remove inline styles from HTML, add Tailwind CDN + design tokens"
```

---

### Task 4: Rewrite style.css — Core Layout & Components

**Files:**
- Rewrite: `src/public/css/style.css`

This is the largest task. Rewrite the entire file using design tokens. Mobile-first approach: base styles are mobile, `@media (min-width: 769px)` adds desktop layout.

- [ ] **Step 1: Write reset + base styles**

```css
/* ===== Tarsee — Core Styles (Claude Desktop Aesthetic) ===== */
/* Uses tokens from tokens.css — never hardcode values */

/* --- Reset --- */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: var(--leading-relaxed);
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow: hidden;
}

/* Prevent iOS double-tap zoom */
* { touch-action: manipulation; }

/* --- Scrollbars --- */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.08); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.15); }
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) transparent; }

::selection { background: var(--accent-glow); color: #fff; }
```

- [ ] **Step 2: Write mobile-first layout (app grid, sidebar, topbar)**

```css
/* --- App Layout (mobile-first: single column) --- */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  padding-top: env(safe-area-inset-top, 0px);
  overflow: hidden;
}

/* --- Sidebar (mobile: off-canvas drawer) --- */
.sidebar {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--sidebar-width);
  max-width: 85vw;
  padding-top: env(safe-area-inset-top, 0px);
  z-index: var(--z-sidebar);
  transform: translateX(-100%);
  transition: transform var(--duration-slow) var(--ease-ios);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-light);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar.open {
  transform: translateX(0);
  box-shadow: 8px 0 40px rgba(0, 0, 0, 0.4);
}

.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: var(--z-sidebar-overlay);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-slow) var(--ease-ios);
  -webkit-tap-highlight-color: transparent;
}

.sidebar-overlay.active {
  opacity: 1;
  pointer-events: auto;
}

.sidebar-header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-light);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}

.sidebar-header .logo {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  overflow: hidden;
}

.sidebar-header h1 {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text);
  letter-spacing: var(--tracking-tight);
}

.sidebar-footer {
  padding: var(--space-3);
  border-top: 1px solid var(--border-light);
}

/* --- Channel List --- */
.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
}

.channel-section-label {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  padding: var(--space-3) var(--space-3) var(--space-1);
}

.channel-section-label:first-child { padding-top: var(--space-2); }

.channel-item {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  margin-bottom: var(--space-0-5);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  min-height: 44px; /* iOS touch target */
}

.channel-item:hover {
  background: var(--bg-surface-hover);
  color: var(--text);
}

.channel-item.active {
  background: var(--accent-subtle);
  color: var(--text);
  font-weight: 500;
}

.channel-item .channel-icon {
  font-size: var(--text-lg);
  width: 20px;
  text-align: center;
  flex-shrink: 0;
}

.channel-item .channel-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
}

.channel-item .channel-time {
  font-size: var(--text-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.channel-item .channel-delete {
  display: none;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-lg);
  cursor: pointer;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-normal) var(--ease-default);
}

.channel-item:hover .channel-delete { display: flex; }
.channel-item:hover .channel-time { display: none; }
.channel-item .channel-delete:hover {
  background: var(--danger-subtle);
  color: var(--danger);
}

/* --- Topbar --- */
.topbar {
  height: var(--topbar-height-mobile);
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg);
  flex-shrink: 0;
  z-index: var(--z-sticky);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.topbar-title {
  font-size: var(--text-md);
  font-weight: 600;
  letter-spacing: var(--tracking-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  max-width: 160px;
}

.topbar-icon-btn {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-normal) var(--ease-default);
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}

.topbar-icon-btn:hover {
  background: var(--bg-surface-hover);
  color: var(--text);
}

/* --- Main Content --- */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
  overflow: hidden;
}
```

- [ ] **Step 3: Write desktop layout media query**

```css
/* ===== Desktop (769px+) — sidebar visible, grid layout ===== */
@media (min-width: 769px) {
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    grid-template-areas: "sidebar content";
    padding-top: 0;
  }

  .sidebar {
    position: relative;
    transform: none;
    z-index: auto;
    padding-top: 0;
    box-shadow: none;
    max-width: none;
  }

  .sidebar-overlay { display: none; }

  .main { grid-area: content; }

  .topbar {
    height: var(--topbar-height);
    padding: 0 var(--space-5);
  }

  .topbar-title { max-width: none; }

  #menuBtn { display: none !important; }
}
```

- [ ] **Step 4: Write button system**

```css
/* --- Buttons --- */
.btn {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  font-family: var(--font-body);
  line-height: 1;
  -webkit-tap-highlight-color: transparent;
}

.btn:hover {
  background: var(--bg-surface-hover);
  border-color: var(--border-hover);
}

.btn:active { transform: scale(0.97); }

.btn-primary {
  background: var(--accent);
  color: var(--text-inverse);
  border-color: var(--accent);
  font-weight: 600;
}

.btn-primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  box-shadow: 0 4px 12px var(--accent-glow);
}

.btn-danger {
  background: var(--danger);
  color: white;
  border-color: var(--danger);
}

.btn-danger:hover { background: var(--danger-hover); }

.btn-sm {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
}

.btn-ghost {
  border: none;
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover {
  background: var(--bg-surface-hover);
  color: var(--text);
}

.btn-block { width: 100%; justify-content: center; }
```

- [ ] **Step 5: Write welcome screen, login, setup wizard**

```css
/* --- Welcome Screen --- */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--space-10) var(--space-6);
  gap: var(--space-3);
}

.welcome .logo-large {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin-bottom: var(--space-1);
}

.welcome h2 {
  font-size: var(--text-2xl);
  font-weight: 700;
  color: var(--text);
  letter-spacing: var(--tracking-tight);
}

.welcome p {
  color: var(--text-secondary);
  max-width: 380px;
  font-size: var(--text-md);
  line-height: var(--leading-relaxed);
}

.welcome-suggestions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  width: 100%;
  max-width: 320px;
}

.welcome-suggestion {
  padding: var(--space-3) var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  text-align: left;
}

.welcome-suggestion:hover {
  border-color: var(--border-hover);
  color: var(--text);
  background: var(--bg-surface-hover);
}

@media (min-width: 769px) {
  .welcome-suggestions {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 520px;
  }
  .welcome-suggestion {
    text-align: center;
    width: auto;
  }
}

/* --- Login Screen --- */
.login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-5);
  background: var(--bg);
}

.login-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-lg);
  padding: var(--space-10) var(--space-8);
  width: 100%;
  max-width: 380px;
  text-align: center;
  animation: fadeIn var(--duration-slow) var(--ease-default);
}

.login-card .logo-large {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-lg);
  margin: 0 auto var(--space-4);
  overflow: hidden;
}

.login-card h1 {
  font-size: var(--text-2xl);
  font-weight: 700;
  margin-bottom: var(--space-1-5);
  letter-spacing: var(--tracking-tight);
}

.login-card p {
  color: var(--text-muted);
  margin-bottom: var(--space-6);
  font-size: var(--text-base);
}

.login-card .error {
  background: var(--danger-subtle);
  color: var(--danger);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  margin-bottom: var(--space-4);
  display: none;
  border: 1px solid rgba(248, 113, 113, 0.15);
}

/* --- Setup Wizard --- */
.setup-wizard {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-5);
  background: var(--bg);
}

.setup-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 420px;
  overflow: hidden;
  animation: fadeIn var(--duration-slow) var(--ease-default);
}

.setup-card-header {
  background: var(--accent);
  padding: var(--space-6) var(--space-8);
  text-align: center;
  color: white;
}

.setup-card-header h2 {
  font-size: var(--text-2xl);
  font-weight: 700;
  color: white;
}

.setup-card-body {
  padding: var(--space-6) var(--space-8);
}
```

- [ ] **Step 6: Write input area, messages (mobile-first)**

```css
/* --- Input Area --- */
.input-area {
  position: relative;
  padding: var(--space-2) var(--space-3) calc(env(safe-area-inset-bottom, 8px) + var(--space-1));
  background: var(--bg);
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}

.input-container {
  max-width: var(--input-max-width);
  margin: 0 auto;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-1);
  display: flex;
  align-items: flex-end;
  gap: var(--space-0-5);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--duration-normal) var(--ease-default),
              box-shadow var(--duration-normal) var(--ease-default);
}

.input-container:focus-within {
  border-color: rgba(196, 90, 53, 0.4);
  box-shadow: 0 0 0 3px rgba(196, 90, 53, 0.1), var(--shadow-sm);
}

.input-container textarea {
  flex: 1;
  border: none;
  outline: none;
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-body);
  font-size: var(--text-lg); /* 16px prevents iOS zoom */
  line-height: var(--leading-normal);
  resize: none;
  min-height: 24px;
  max-height: 200px;
  background: transparent;
  color: var(--text);
}

.input-container textarea::placeholder {
  color: var(--text-muted);
}

.input-btn {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-normal) var(--ease-default);
  flex-shrink: 0;
  background: transparent;
  color: var(--text-muted);
  -webkit-tap-highlight-color: transparent;
}

.input-btn:hover {
  background: var(--bg-surface-hover);
  color: var(--text);
}

.input-btn.send {
  background: var(--accent);
  color: white;
  border-radius: var(--radius-md);
}

.input-btn.send:hover {
  background: var(--accent-hover);
  transform: scale(1.05);
}

.input-btn.send:active { transform: scale(0.97); }

.input-btn.send:disabled {
  background: var(--bg-surface-hover);
  color: var(--text-muted);
  cursor: not-allowed;
  transform: none;
}

.input-btn.send.stop-mode { background: var(--danger); }
.input-btn.send.stop-mode:hover { background: var(--danger-hover); }
.input-btn.send.stop-mode svg { display: none; }
.input-btn.send.stop-mode::after { content: "■"; font-size: var(--text-base); }

.input-btn.voice-active {
  background: var(--danger);
  color: white;
  animation: breathe 1.5s infinite;
}

.input-btn.voice-transcribing {
  background: var(--accent);
  color: var(--text-inverse);
  animation: breathe 1.2s infinite;
}

.input-btn.drag-cancel {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  animation: none;
  opacity: 0.5;
}

@media (min-width: 769px) {
  .input-area {
    padding: var(--space-3) var(--space-6) var(--space-5);
    background: linear-gradient(to top, var(--bg) 60%, transparent);
    border-top: none;
  }
}

/* --- Chat Area --- */
.chat-area {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-3) var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
}

@media (min-width: 769px) {
  .chat-area {
    padding: var(--space-6) var(--space-6) var(--space-2);
  }
}

/* --- Messages --- */
.message {
  max-width: var(--message-max-width);
  width: 100%;
  margin: 0 auto;
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  animation: fadeIn 200ms var(--ease-default);
  transition: background var(--duration-normal) var(--ease-default);
  position: relative;
}

.message:hover { background: var(--bg-surface-hover); }

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: 700;
  overflow: hidden;
}

.message.user .message-avatar {
  background: var(--bg-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
}

.message.assistant .message-avatar {
  background: var(--accent);
  color: white;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}

.message-content {
  flex: 1;
  min-width: 0;
}

.message-role {
  font-size: var(--text-sm);
  font-weight: 600;
  margin-bottom: var(--space-0-5);
  color: var(--text);
}

.message.user .message-role { color: var(--text-secondary); }

.message-text {
  font-size: var(--text-md);
  line-height: var(--leading-relaxed);
  word-wrap: break-word;
  color: var(--text);
}

.message.user .message-text { color: var(--text-secondary); }

/* Grouped messages */
.message.grouped {
  padding-top: var(--space-0-5);
  padding-bottom: var(--space-0-5);
}
.message.grouped .message-avatar { visibility: hidden; }
.message.grouped .message-role { display: none; }

@media (min-width: 769px) {
  .message {
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
  }
  .message-avatar { width: 36px; height: 36px; }
}
```

- [ ] **Step 7: Write forms, settings, modals**

```css
/* --- Forms --- */
.form-group {
  margin-bottom: 0;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-light);
}

.form-group:last-child { border-bottom: none; }

.form-group label {
  display: block;
  font-size: var(--text-base);
  font-weight: 500;
  margin-bottom: var(--space-1-5);
  color: var(--text);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  font-size: var(--text-base);
  font-family: var(--font-body);
  color: var(--text);
  background: var(--bg);
  transition: border-color var(--duration-normal) var(--ease-default),
              box-shadow var(--duration-normal) var(--ease-default);
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-subtle);
}

.form-group input::placeholder,
.form-group textarea::placeholder {
  color: var(--text-muted);
}

.form-group select {
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%236b6b63' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right var(--space-3) center;
  padding-right: var(--space-8);
  background-color: var(--bg);
}

.form-group select option {
  background: var(--bg-surface);
  color: var(--text);
}

.textarea-mono {
  font-family: var(--font-mono) !important;
  font-size: var(--text-sm) !important;
}

.form-group .hint,
.settings-hint {
  font-size: var(--text-sm);
  color: var(--text-muted);
  margin-top: var(--space-1-5);
  line-height: var(--leading-normal);
}

.form-group .secret-input { -webkit-text-security: disc; }

/* --- Settings Page --- */
.settings-page {
  flex: 1;
  display: none;
  flex-direction: column;
  overflow: hidden;
  animation: fadeIn 200ms var(--ease-default);
}

.settings-page.open { display: flex; }

/* Mobile: horizontal scrolling tabs on top */
.settings-tabs {
  width: 100%;
  flex-shrink: 0;
  flex-direction: row;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-2);
  gap: var(--space-1);
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-sidebar);
  display: flex;
}

.settings-tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 500;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
  text-align: left;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}

.settings-tab:hover { background: var(--bg-surface-hover); color: var(--text); }

.settings-tab.active {
  background: var(--accent-subtle);
  color: var(--accent);
  font-weight: 600;
}

.settings-tab svg { flex-shrink: 0; opacity: 0.7; }
.settings-tab.active svg { opacity: 1; }

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-5) var(--space-4);
  min-width: 0;
  max-width: 700px;
}

.settings-content h2 {
  font-size: var(--text-3xl);
  font-weight: 700;
  margin-bottom: var(--space-5);
  letter-spacing: var(--tracking-tight);
}

.settings-tab-panel { display: none; width: 100%; }
.settings-tab-panel.active { display: block; }

.settings-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-weight: 400;
}

.settings-section {
  margin-bottom: var(--space-6);
  padding: var(--space-4);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}

.settings-section:last-child { margin-bottom: 0; }

.settings-section h3 {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--space-3);
}

@media (min-width: 769px) {
  .settings-page { flex-direction: row; }

  .settings-tabs {
    width: var(--settings-sidebar-width);
    flex-direction: column;
    overflow-x: visible;
    border-bottom: none;
    border-right: 1px solid var(--border-light);
    padding: var(--space-4) var(--space-2);
    gap: var(--space-0-5);
  }

  .settings-tab {
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }

  .settings-content {
    padding: var(--space-6) var(--space-8) var(--space-10);
  }
}

/* --- Delete Modal --- */
.delete-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
}

.delete-modal {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  width: 100%;
  max-width: 380px;
  box-shadow: var(--shadow-xl);
  animation: scaleIn 200ms var(--ease-spring);
}

.delete-modal-header {
  font-size: var(--text-xl);
  font-weight: 700;
  margin-bottom: var(--space-3);
}

.delete-modal-text {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin: var(--space-2) 0;
  line-height: var(--leading-normal);
}

.delete-modal-text strong { color: var(--text); }

.delete-modal-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text);
  font-size: var(--text-base);
  margin: var(--space-3) 0 var(--space-4);
  outline: none;
  transition: border-color var(--duration-normal) var(--ease-default);
}

.delete-modal-input:focus { border-color: var(--danger); }

.delete-modal-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.delete-modal-cancel {
  background: var(--bg-surface-hover);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-sm);
  transition: all var(--duration-normal) var(--ease-default);
}

.delete-modal-cancel:hover {
  background: var(--border);
  color: var(--text);
}

.delete-modal-confirm {
  background: var(--danger);
  border: none;
  color: white;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 600;
  transition: all var(--duration-normal) var(--ease-default);
}

.delete-modal-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
.delete-modal-confirm:not(:disabled):hover { background: var(--danger-hover); }

/* --- Save Status --- */
.save-status {
  display: inline-block;
  font-size: var(--text-xs);
  margin-left: var(--space-1);
  color: var(--text-muted);
  transition: opacity var(--duration-normal) var(--ease-default);
}
.save-status.saving { color: var(--warning); }
.save-status.saved { color: var(--success); }

/* --- Toasts --- */
.toast-container {
  position: fixed;
  top: 60px;
  right: var(--space-4);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  pointer-events: none;
}

.toast {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  box-shadow: var(--shadow-lg);
  font-size: var(--text-sm);
  animation: slideIn 250ms var(--ease-default);
  max-width: 340px;
  pointer-events: auto;
  line-height: var(--leading-normal);
  color: var(--text);
}

.toast.error { border-left: 3px solid var(--danger); background: var(--danger-subtle); }
.toast.success { border-left: 3px solid var(--success); background: var(--success-subtle); }
.toast.info { border-left: 3px solid var(--info); }

/* --- Typing Indicator --- */
.typing-indicator {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1) 0;
}

.typing-indicator span {
  width: 6px;
  height: 6px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: pulse 1.2s infinite ease-in-out;
}

.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

/* --- Voice recording hints (in input area) --- */
.voice-cancel-hint {
  position: absolute;
  right: 100px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-sm);
  color: var(--text-muted);
  opacity: 0.7;
  transition: opacity 0.2s, color 0.2s;
  pointer-events: none;
  white-space: nowrap;
}

.voice-cancel-hint.active {
  color: var(--danger);
  opacity: 1;
}

.voice-rec-timer {
  position: absolute;
  left: 56px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  color: var(--danger);
  pointer-events: none;
}

.voice-rec-timer::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: blink 1s ease-in-out infinite;
}

/* --- Memory Items --- */
.memory-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  transition: background var(--duration-normal) var(--ease-default);
  border-bottom: 1px solid var(--border-light);
}

.memory-item:hover { background: var(--bg-surface-hover); }

.memory-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: var(--space-0-5) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--accent-subtle);
  color: var(--accent);
  flex-shrink: 0;
}

.memory-content { flex: 1; color: var(--text-secondary); }

.memory-delete {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: var(--space-0-5);
  border-radius: var(--radius-sm);
  opacity: 0;
  transition: all var(--duration-normal) var(--ease-default);
  flex-shrink: 0;
}

.memory-item:hover .memory-delete { opacity: 1; }
.memory-delete:hover { color: var(--danger); background: var(--danger-subtle); }

/* --- Skills --- */
.skills-section-label {
  font-size: var(--text-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  padding: var(--space-3) var(--space-1) var(--space-1-5);
}

.skills-section-label:first-child { padding-top: 0; }

.skill-card {
  border: none;
  border-bottom: 1px solid var(--border-light);
  border-radius: 0;
  padding: var(--space-3) var(--space-4);
  transition: background var(--duration-normal) var(--ease-default);
  background: var(--bg-surface);
}

.skills-section-label + .skill-card { border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
.skill-card:last-child { border-bottom: none; border-radius: 0 0 var(--radius-lg) var(--radius-lg); }
.skills-section-label + .skill-card:last-child { border-radius: var(--radius-lg); }
.skill-card:hover { background: var(--bg-surface-hover); }

.skill-dialog {
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-top: var(--space-3);
  background: var(--bg);
}

/* --- Clone Upload --- */
.clone-upload {
  border: 2px dashed var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  text-align: center;
  cursor: pointer;
  transition: all var(--duration-normal) var(--ease-default);
}

.clone-upload:hover,
.clone-upload.dragover {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
```

- [ ] **Step 8: Verify the rewritten style.css compiles (no syntax errors)**

Run: Open browser, check DevTools console for CSS parse errors.

- [ ] **Step 9: Commit**

```bash
git add src/public/css/style.css
git commit -m "feat: rewrite style.css — Claude Desktop aesthetic, mobile-first, design tokens"
```

---

### Task 5: Rewrite chat.css — Messages, Tool Blocks, Streaming

**Files:**
- Rewrite: `src/public/css/chat.css`

- [ ] **Step 1: Rewrite chat.css with design tokens**

Full rewrite of session bar, tool blocks (thinking/call/response with proper color tokens), markdown rendering, code blocks, streaming indicators, command palette, file attachments, message copy button, empty state. All values from tokens.css. No hardcoded colors.

Key changes from current:
- Session bar: consistent spacing with `var(--space-*)`, badge sizes using tokens
- Tool blocks: use `var(--thinking)`, `var(--tool-call)`, `var(--tool-response)` color tokens
- Code blocks: `var(--bg)` for background, `var(--text)` for color — no hardcoded hex
- Streaming cursor: use `var(--accent)` not `var(--primary)`
- Command palette: consistent radius and padding from tokens
- All font sizes from the type scale

- [ ] **Step 2: Commit**

```bash
git add src/public/css/chat.css
git commit -m "feat: rewrite chat.css — tool blocks, streaming, markdown with design tokens"
```

---

### Task 6: Rewrite voice.css — Voice Panel & Orb

**Files:**
- Rewrite: `src/public/css/voice.css`

- [ ] **Step 1: Rewrite voice.css with design tokens**

Key changes:
- Orb states use `var(--accent)` for listening, `var(--success)` for speaking, `var(--accent-subtle)` for processing
- All padding/margins from spacing scale
- Touch targets: minimum 44px on mobile
- Conversation bubbles: user gets `var(--accent)` background, assistant gets `var(--bg-surface)`
- Z-index: `var(--z-voice)`
- Close button: proper safe-area padding, 44px touch target
- Remove hardcoded `#1a1a1a` — use `var(--text-inverse)`

- [ ] **Step 2: Commit**

```bash
git add src/public/css/voice.css
git commit -m "feat: rewrite voice.css — orb states, conversation bubbles with tokens"
```

---

### Task 7: Rewrite console.css — Console Panel

**Files:**
- Rewrite: `src/public/css/console.css`

- [ ] **Step 1: Rewrite console.css with design tokens**

Key changes:
- Remove hardcoded colors (`#CDD6F4`, `#89B4FA`, etc.) — use semantic tokens
- Level colors: `info` = `var(--info)`, `warn` = `var(--warning)`, `error` = `var(--danger)`, `debug` = `var(--text-muted)`
- Left offset: use `var(--sidebar-width)` on desktop, `0` on mobile
- Z-index: `var(--z-console)`
- Consistent padding from spacing scale
- Proper mobile height that accounts for safe areas

- [ ] **Step 2: Commit**

```bash
git add src/public/css/console.css
git commit -m "feat: rewrite console.css — semantic colors, responsive layout with tokens"
```

---

### Task 8: Rewrite files.css — File Manager

**Files:**
- Rewrite: `src/public/css/files.css`

- [ ] **Step 1: Rewrite files.css with design tokens**

Key changes:
- Z-index: `var(--z-files)`
- All colors from tokens
- Consistent spacing
- Mobile-first layout

- [ ] **Step 2: Commit**

```bash
git add src/public/css/files.css
git commit -m "feat: rewrite files.css — file manager with design tokens"
```

---

### Task 9: Fix JS Inline Styles

**Files:**
- Modify: `src/public/js/chat.js`
- Modify: `src/public/js/voice.js`
- Modify: `src/public/js/console.js`
- Modify: `src/public/js/files.js`
- Modify: `src/public/js/settings.js`
- Modify: `src/public/js/app.js`

- [ ] **Step 1: Fix chat.js inline styles**

Replace inline style strings in HTML templates with CSS classes:
- Avatar image: replace `style="width:100%;height:100%;object-fit:cover;border-radius:50%"` with `class="avatar-img"`
- Tool indicator badge: replace inline flex/color/padding with `.tool-badge` class
- Error display: replace `style="color:var(--danger)"` with `class="text-danger"`

- [ ] **Step 2: Fix console.js inline styles**

Replace system message `style="color:#585B70;font-style:italic"` with `.console-system-msg` class.

- [ ] **Step 3: Fix files.js inline styles**

Replace error display, image preview, and code preview inline styles with CSS classes:
- Error: `class="fm-error"`
- Image: `class="fm-preview-img"`
- Pre: `class="fm-preview-code"`

- [ ] **Step 4: Fix settings.js inline style for button color**

Replace `openBtn.style.color = "var(--primary)"` with `openBtn.classList.add("active")` and style `.settings-btn.active { color: var(--accent); }`.

- [ ] **Step 5: Fix app.js menu button display**

Replace `menuBtn.style.display = "inline-flex"` / `"none"` with class toggle. Use CSS `#menuBtn { display: inline-flex; }` on mobile and `display: none` on desktop via media query.

- [ ] **Step 6: Commit**

```bash
git add src/public/js/*.js
git commit -m "refactor: replace JS inline styles with CSS classes"
```

---

### Task 10: PWA Enhancement

**Files:**
- Rewrite: `src/public/manifest.json`
- Rewrite: `src/public/sw.js`
- Create: `src/public/offline.html`
- Modify: `src/public/js/sw-register.js`

- [ ] **Step 1: Create offline.html**

A minimal, styled offline page that matches the new design. Shows Tarsee logo, "You're offline" message, and a retry button.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1a1a1a">
  <title>Tarsee — Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
      background: #1a1a1a;
      color: #ececec;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      text-align: center;
    }
    .offline-card {
      max-width: 360px;
    }
    .offline-icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      border-radius: 16px;
      background: #2b2a27;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.3px;
    }
    p {
      color: #a8a8a0;
      font-size: 15px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    button {
      background: #c45a35;
      color: #1a1a1a;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    button:hover { background: #d4663d; }
  </style>
</head>
<body>
  <div class="offline-card">
    <div class="offline-icon">📡</div>
    <h1>You're offline</h1>
    <p>Tarsee needs a connection to your server. Check your network and try again.</p>
    <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>
```

- [ ] **Step 2: Update manifest.json**

```json
{
  "name": "Tarsee",
  "short_name": "Tarsee",
  "description": "Headless Claude Code Agent — 24/7 AI that remembers everything",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#1a1a1a",
  "orientation": "any",
  "categories": ["productivity", "utilities"],
  "icons": [
    { "src": "/icon-32.png", "sizes": "32x32", "type": "image/png" },
    { "src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    {
      "name": "New Chat",
      "short_name": "Chat",
      "url": "/",
      "icons": [{ "src": "/icon-192.png", "sizes": "192x192" }]
    }
  ]
}
```

- [ ] **Step 3: Rewrite sw.js — Service Worker v2**

```javascript
// Tarsee Service Worker v2 — better caching + offline page
const CACHE_NAME = "tarsee-v2";
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  "/",
  "/offline.html",
  "/css/tokens.css",
  "/css/utilities.css",
  "/css/style.css",
  "/css/chat.css",
  "/css/voice.css",
  "/css/console.css",
  "/css/files.css",
  "/js/api.js",
  "/js/chat.js",
  "/js/voice.js",
  "/js/console.js",
  "/js/settings.js",
  "/js/setup.js",
  "/js/files.js",
  "/js/app.js",
  "/icon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.json",
];

// Install: precache app shell + offline page
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for pages, cache-first for assets
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Skip API and WebSocket
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  // HTML pages: network-first, offline fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if (url.pathname.match(/\.(css|js|png|ico|json|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        });
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else: network-first
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
```

- [ ] **Step 4: Update sw-register.js with cache busting**

```javascript
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=2").catch(() => {});
}
```

- [ ] **Step 5: Commit**

```bash
git add src/public/offline.html src/public/manifest.json src/public/sw.js src/public/js/sw-register.js
git commit -m "feat: enhance PWA — offline page, better caching, full icon set"
```

---

### Task 11: Mobile Testing & Polish Pass

**Files:**
- Modify: Various CSS files for fixes found during testing

- [ ] **Step 1: Test on mobile viewport (375px iPhone SE)**

Check:
- Sidebar drawer opens/closes smoothly
- Input area doesn't get hidden by keyboard
- All touch targets ≥ 44px
- No horizontal overflow
- Safe area insets respected (notch, home indicator)
- Welcome suggestions stack vertically
- Settings tabs scroll horizontally

- [ ] **Step 2: Test on tablet viewport (768px iPad)**

Check:
- Layout transitions cleanly from mobile to desktop
- Settings tabs switch from horizontal to vertical sidebar
- Console panel sizing correct

- [ ] **Step 3: Test on desktop (1280px+)**

Check:
- Sidebar visible, no hamburger
- Messages centered with max-width
- Settings layout correct
- No visual regressions

- [ ] **Step 4: Test voice mode on all viewports**

Check:
- Orb sizing
- Conversation bubbles readable
- Close button accessible
- Transcript scrolls properly

- [ ] **Step 5: Fix any issues found, commit**

```bash
git add -A
git commit -m "fix: mobile polish — touch targets, safe areas, responsive tweaks"
```

---

### Task 12: Final Verification & Cleanup

- [ ] **Step 1: Grep for remaining hardcoded colors**

Run: `grep -rn '#[0-9a-fA-F]\{6\}' src/public/css/ --include='*.css' | grep -v tokens.css | grep -v 'var('`
Expected: Zero results (all colors should come from tokens)

- [ ] **Step 2: Grep for remaining inline styles in HTML**

Run: `grep -c 'style=' src/public/index.html`
Expected: Only `style="display:none"` on JS-toggled elements

- [ ] **Step 3: Check for duplicate keyframe names across files**

Run: `grep -rn '@keyframes' src/public/css/ --include='*.css'`
Expected: All keyframes defined ONLY in tokens.css

- [ ] **Step 4: Verify all z-index values use tokens**

Run: `grep -rn 'z-index:' src/public/css/ --include='*.css' | grep -v 'var(--z-'`
Expected: Zero results

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup — verify no hardcoded values, all tokens used"
```
