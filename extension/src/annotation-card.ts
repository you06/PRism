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

import type { RiskLevel } from "./shared.js";
import { PRISM_CSS } from "./prism-card-css.js";

// ---- Types -----------------------------------------------------------------

/** Data for a card in "ready" state. */
export interface CardAnnotation {
  summary: string;
  impact?: string;
  risk?: RiskLevel;
}

/** Discriminated union of card states.
 *  WORK14 adds offline / rate_limited for degraded-state UI. */
export type CardState =
  | { kind: "loading" }
  | { kind: "ready"; data: CardAnnotation }
  | { kind: "error"; message: string }
  | { kind: "offline" }
  | { kind: "rate_limited"; retryAfterSec?: number };

// ---- Constants -------------------------------------------------------------

const PRISM_STYLE_ID = "prism-annotation-styles";
const CARD_ATTR = "data-prism-card-for";


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
