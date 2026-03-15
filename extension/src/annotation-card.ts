// ---------------------------------------------------------------------------
// PRism — Annotation Card Renderer
//
// Renders lightweight inline annotation cards near GitHub diff hunk headers.
// Supports loading / ready / error states with stub action buttons.
//
// Insertion strategy:
//   Cards are inserted as a <tr> immediately after the hunk header row
//   inside the diff table, using a full-width <td colspan>.
//   This keeps cards within the table layout without breaking GitHub's DOM.
//
// Deduplication:
//   Each card row carries a `data-prism-card-for` attribute matching the
//   hunk's domAnchorId. renderCard() updates existing cards in place.
// ---------------------------------------------------------------------------

import type { RiskLevel } from "@prism/shared";

// ---- Types -----------------------------------------------------------------

/** Data for a card in "ready" state. */
export interface CardAnnotation {
  summary: string;
  impact?: string;
  risk?: RiskLevel;
}

/** Discriminated union of card states.
 *  WORK14 adds offline / auth_error / rate_limited for degraded-state UI. */
export type CardState =
  | { kind: "loading" }
  | { kind: "ready"; data: CardAnnotation }
  | { kind: "error"; message: string }
  | { kind: "offline" }
  | { kind: "auth_error" }
  | { kind: "rate_limited"; retryAfterSec?: number };

// ---- Constants -------------------------------------------------------------

const PRISM_STYLE_ID = "prism-annotation-styles";
const CARD_ATTR = "data-prism-card-for";

// ---- Styles ----------------------------------------------------------------

const PRISM_CSS = `
/* ---- PRism annotation cards ---- */

.prism-card {
  margin: 4px 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  /* Light theme defaults */
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  color: #1f2328;
}

/* ---- Dark theme ---- */
html[data-color-mode="dark"] .prism-card,
html[data-dark-theme="dark"] .prism-card {
  background: #161b22;
  border-color: #30363d;
  color: #e6edf3;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card {
    background: #161b22;
    border-color: #30363d;
    color: #e6edf3;
  }
}

/* ---- Label ---- */
.prism-card__label {
  font-weight: 600;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #0969da;
  color: #fff;
  flex-shrink: 0;
}

/* ---- Loading state ---- */
.prism-card--loading .prism-card__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #0969da;
  animation: prism-pulse 1.2s ease-in-out infinite;
}
@keyframes prism-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.prism-card--loading .prism-card__text {
  color: inherit;
  opacity: 0.7;
}

/* ---- Ready state ---- */
.prism-card--ready {
  flex-direction: column;
  align-items: flex-start;
}
.prism-card__header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.prism-card__summary {
  width: 100%;
}
.prism-card__impact {
  width: 100%;
  opacity: 0.75;
  font-style: italic;
}

/* ---- Risk badges ---- */
.prism-card__risk {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.prism-card__risk--low {
  background: #dafbe1;
  color: #116329;
}
.prism-card__risk--medium {
  background: #fff8c5;
  color: #6a5304;
}
.prism-card__risk--high {
  background: #ffebe9;
  color: #a40e26;
}
/* Dark theme risk badges */
html[data-color-mode="dark"] .prism-card__risk--low,
html[data-dark-theme="dark"] .prism-card__risk--low {
  background: #12261e;
  color: #3fb950;
}
html[data-color-mode="dark"] .prism-card__risk--medium,
html[data-dark-theme="dark"] .prism-card__risk--medium {
  background: #272115;
  color: #d29922;
}
html[data-color-mode="dark"] .prism-card__risk--high,
html[data-dark-theme="dark"] .prism-card__risk--high {
  background: #2d1215;
  color: #f85149;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card__risk--low {
    background: #12261e;
    color: #3fb950;
  }
  html[data-color-mode="auto"] .prism-card__risk--medium {
    background: #272115;
    color: #d29922;
  }
  html[data-color-mode="auto"] .prism-card__risk--high {
    background: #2d1215;
    color: #f85149;
  }
}

/* ---- Error state ---- */
.prism-card--error {
  border-color: #cf222e;
  background: #ffebe9;
  color: #82071e;
}
html[data-color-mode="dark"] .prism-card--error,
html[data-dark-theme="dark"] .prism-card--error {
  background: #2d1215;
  border-color: #da3633;
  color: #f85149;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card--error {
    background: #2d1215;
    border-color: #da3633;
    color: #f85149;
  }
}

/* ---- Action buttons ---- */
.prism-card__actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.prism-card__btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #d0d7de;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}
.prism-card__btn:hover {
  background: rgba(128, 128, 128, 0.15);
}
html[data-color-mode="dark"] .prism-card__btn,
html[data-dark-theme="dark"] .prism-card__btn {
  border-color: #30363d;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card__btn {
    border-color: #30363d;
  }
}

/* ---- Offline state (WORK14) ---- */
.prism-card--offline {
  border-color: #8c959f;
  background: #f6f8fa;
  color: #656d76;
  opacity: 0.8;
}
html[data-color-mode="dark"] .prism-card--offline,
html[data-dark-theme="dark"] .prism-card--offline {
  background: #161b22;
  border-color: #30363d;
  color: #8b949e;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card--offline {
    background: #161b22;
    border-color: #30363d;
    color: #8b949e;
  }
}

/* ---- Auth error state (WORK14) ---- */
.prism-card--auth-error {
  border-color: #bf8700;
  background: #fff8c5;
  color: #6a5304;
}
html[data-color-mode="dark"] .prism-card--auth-error,
html[data-dark-theme="dark"] .prism-card--auth-error {
  background: #272115;
  border-color: #6a5304;
  color: #d29922;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card--auth-error {
    background: #272115;
    border-color: #6a5304;
    color: #d29922;
  }
}

/* ---- Rate-limited state (WORK14) ---- */
.prism-card--rate-limited {
  border-color: #bf8700;
  background: #fff8c5;
  color: #735c0f;
}
html[data-color-mode="dark"] .prism-card--rate-limited,
html[data-dark-theme="dark"] .prism-card--rate-limited {
  background: #272115;
  border-color: #6a5304;
  color: #e3b341;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card--rate-limited {
    background: #272115;
    border-color: #6a5304;
    color: #e3b341;
  }
}

/* ---- Card row cell reset ---- */
td.prism-card-cell {
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
}
`;

// ---- Style injection -------------------------------------------------------

/** Inject PRism card styles into the page. Idempotent. */
export function injectPrismStyles(): void {
  if (document.getElementById(PRISM_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = PRISM_STYLE_ID;
  style.textContent = PRISM_CSS;
  document.head.appendChild(style);
}

// ---- Helpers ---------------------------------------------------------------

function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

function findCardRow(domAnchorId: string): HTMLTableRowElement | null {
  return document.querySelector<HTMLTableRowElement>(
    `tr[${CARD_ATTR}="${CSS.escape(domAnchorId)}"]`,
  );
}

function findHunkRow(domAnchorId: string): HTMLTableRowElement | null {
  return document.querySelector<HTMLTableRowElement>(
    `tr[data-prism-hunk-id="${CSS.escape(domAnchorId)}"]`,
  );
}

/** Count columns in the table so we can span the full width. */
function getTableColCount(row: HTMLTableRowElement): number {
  const table = row.closest("table");
  if (!table) return 4;
  const firstRow = table.querySelector<HTMLTableRowElement>("tr");
  if (!firstRow) return 4;
  let count = 0;
  for (let i = 0; i < firstRow.cells.length; i++) {
    count += firstRow.cells[i].colSpan || 1;
  }
  return Math.max(count, 4);
}

// ---- Card content builders -------------------------------------------------

function buildLoadingContent(): string {
  return `<div class="prism-card prism-card--loading">
    <span class="prism-card__dot"></span>
    <span class="prism-card__text">PRism is analyzing this change\u2026</span>
  </div>`;
}

function buildReadyContent(data: CardAnnotation): string {
  const riskBadge = data.risk
    ? `<span class="prism-card__risk prism-card__risk--${data.risk}">${data.risk} risk</span>`
    : "";

  const impactLine = data.impact
    ? `<div class="prism-card__impact">${escapeHtml(data.impact)}</div>`
    : "";

  return `<div class="prism-card prism-card--ready">
    <div class="prism-card__header">
      <span class="prism-card__label">PRism</span>
      ${riskBadge}
    </div>
    <div class="prism-card__summary">${escapeHtml(data.summary)}</div>
    ${impactLine}
    <div class="prism-card__actions">
      <button class="prism-card__btn" data-prism-action="refresh">Refresh</button>
      <button class="prism-card__btn" data-prism-action="explain">Explain deeper</button>
    </div>
  </div>`;
}

function buildErrorContent(message: string): string {
  return `<div class="prism-card prism-card--error">
    <span class="prism-card__label">PRism</span>
    <span class="prism-card__text">${escapeHtml(message)}</span>
    <div class="prism-card__actions">
      <button class="prism-card__btn" data-prism-action="retry">Retry</button>
    </div>
  </div>`;
}

function buildOfflineContent(): string {
  return `<div class="prism-card prism-card--offline">
    <span class="prism-card__label">PRism</span>
    <span class="prism-card__text">Daemon is offline. Start the PRism daemon and retry.</span>
    <div class="prism-card__actions">
      <button class="prism-card__btn" data-prism-action="retry">Retry</button>
    </div>
  </div>`;
}

function buildAuthErrorContent(): string {
  return `<div class="prism-card prism-card--auth-error">
    <span class="prism-card__label">PRism</span>
    <span class="prism-card__text">Pairing token not configured or invalid. Check extension settings.</span>
    <div class="prism-card__actions">
      <button class="prism-card__btn" data-prism-action="retry">Retry</button>
    </div>
  </div>`;
}

function buildRateLimitedContent(retryAfterSec?: number): string {
  const hint = retryAfterSec != null
    ? `Rate limited. Try again in ${retryAfterSec}s.`
    : "Rate limited. Try again later.";
  return `<div class="prism-card prism-card--rate-limited">
    <span class="prism-card__label">PRism</span>
    <span class="prism-card__text">${escapeHtml(hint)}</span>
    <div class="prism-card__actions">
      <button class="prism-card__btn" data-prism-action="retry">Retry</button>
    </div>
  </div>`;
}

function buildCardInnerHtml(state: CardState): string {
  switch (state.kind) {
    case "loading":
      return buildLoadingContent();
    case "ready":
      return buildReadyContent(state.data);
    case "error":
      return buildErrorContent(state.message);
    case "offline":
      return buildOfflineContent();
    case "auth_error":
      return buildAuthErrorContent();
    case "rate_limited":
      return buildRateLimitedContent(state.retryAfterSec);
  }
}

// ---- Public API ------------------------------------------------------------

/**
 * Render or update an annotation card for the given hunk.
 *
 * If a card already exists for this domAnchorId, its content is replaced
 * in place (no DOM reflow from remove + insert). If no card exists, a new
 * <tr> is inserted immediately after the hunk header row.
 */
export function renderCard(domAnchorId: string, state: CardState): void {
  const existing = findCardRow(domAnchorId);

  if (existing) {
    const td = existing.querySelector<HTMLTableCellElement>("td");
    if (td) td.innerHTML = buildCardInnerHtml(state);
    return;
  }

  // Create new card row
  const hunkRow = findHunkRow(domAnchorId);
  if (!hunkRow) return;

  const colCount = getTableColCount(hunkRow);
  const cardRow = document.createElement("tr");
  cardRow.setAttribute(CARD_ATTR, domAnchorId);

  const td = document.createElement("td");
  td.className = "prism-card-cell";
  td.setAttribute("colspan", String(colCount));
  td.innerHTML = buildCardInnerHtml(state);

  cardRow.appendChild(td);
  hunkRow.parentNode?.insertBefore(cardRow, hunkRow.nextSibling);
}

/** Remove the annotation card for a specific hunk. */
export function removeCard(domAnchorId: string): void {
  findCardRow(domAnchorId)?.remove();
}

/** Remove all PRism annotation cards from the page. */
export function removeAllCards(): void {
  document.querySelectorAll(`tr[${CARD_ATTR}]`).forEach((el) => el.remove());
}
