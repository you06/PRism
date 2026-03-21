// ---------------------------------------------------------------------------
// PRism — Annotation Card Styles
//
// CSS for inline annotation cards rendered near GitHub diff hunk headers.
// Extracted from annotation-card.ts for separation of concerns.
// ---------------------------------------------------------------------------

export const PRISM_CSS = `
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

/* ---- Chat button ---- */
.prism-card__chat-btn {
  margin-left: auto;
  background: transparent;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  padding: 1px 6px;
  line-height: 1.3;
  flex-shrink: 0;
}
.prism-card__chat-btn:hover {
  background: rgba(128, 128, 128, 0.15);
}
html[data-color-mode="dark"] .prism-card__chat-btn,
html[data-dark-theme="dark"] .prism-card__chat-btn {
  border-color: #30363d;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-card__chat-btn {
    border-color: #30363d;
  }
}

/* ---- Chat panel ---- */
.prism-chat-panel {
  width: 100%;
  margin-top: 6px;
  border-top: 1px solid #d0d7de;
  padding-top: 6px;
}
html[data-color-mode="dark"] .prism-chat-panel,
html[data-dark-theme="dark"] .prism-chat-panel {
  border-top-color: #30363d;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-panel {
    border-top-color: #30363d;
  }
}

/* ---- Suggested questions ---- */
.prism-chat-panel__suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.prism-chat-panel__suggestion {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 12px;
  border: 1px solid #d0d7de;
  background: transparent;
  color: #0969da;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}
.prism-chat-panel__suggestion:hover {
  background: rgba(9, 105, 218, 0.08);
}
html[data-color-mode="dark"] .prism-chat-panel__suggestion,
html[data-dark-theme="dark"] .prism-chat-panel__suggestion {
  border-color: #30363d;
  color: #58a6ff;
}
html[data-color-mode="dark"] .prism-chat-panel__suggestion:hover,
html[data-dark-theme="dark"] .prism-chat-panel__suggestion:hover {
  background: rgba(88, 166, 255, 0.1);
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-panel__suggestion {
    border-color: #30363d;
    color: #58a6ff;
  }
  html[data-color-mode="auto"] .prism-chat-panel__suggestion:hover {
    background: rgba(88, 166, 255, 0.1);
  }
}

.prism-chat-panel__messages {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.prism-chat-bubble {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  max-width: 85%;
  word-wrap: break-word;
  white-space: pre-wrap;
}
.prism-chat-bubble--user {
  align-self: flex-end;
  background: #0969da;
  color: #fff;
}
.prism-chat-bubble--assistant {
  align-self: flex-start;
  background: #eaeef2;
  color: #1f2328;
}
html[data-color-mode="dark"] .prism-chat-bubble--assistant,
html[data-dark-theme="dark"] .prism-chat-bubble--assistant {
  background: #21262d;
  color: #e6edf3;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-bubble--assistant {
    background: #21262d;
    color: #e6edf3;
  }
}

.prism-chat-bubble--loading {
  align-self: flex-start;
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---- Markdown in chat bubbles ---- */
.prism-chat-bubble--assistant {
  white-space: normal;
}
.prism-chat-code {
  display: block;
  margin: 4px 0;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  overflow-x: auto;
  white-space: pre;
  background: rgba(0, 0, 0, 0.06);
}
html[data-color-mode="dark"] .prism-chat-code,
html[data-dark-theme="dark"] .prism-chat-code {
  background: rgba(255, 255, 255, 0.06);
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-code {
    background: rgba(255, 255, 255, 0.06);
  }
}
.prism-chat-inline-code {
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(0, 0, 0, 0.06);
}
html[data-color-mode="dark"] .prism-chat-inline-code,
html[data-dark-theme="dark"] .prism-chat-inline-code {
  background: rgba(255, 255, 255, 0.06);
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-inline-code {
    background: rgba(255, 255, 255, 0.06);
  }
}

.prism-chat-panel__input-row {
  display: flex;
  gap: 4px;
}
.prism-chat-panel__input {
  flex: 1;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  outline: none;
}
.prism-chat-panel__input:focus {
  border-color: #0969da;
  box-shadow: 0 0 0 1px #0969da;
}
html[data-color-mode="dark"] .prism-chat-panel__input,
html[data-dark-theme="dark"] .prism-chat-panel__input {
  border-color: #30363d;
}
html[data-color-mode="dark"] .prism-chat-panel__input:focus,
html[data-dark-theme="dark"] .prism-chat-panel__input:focus {
  border-color: #58a6ff;
  box-shadow: 0 0 0 1px #58a6ff;
}
@media (prefers-color-scheme: dark) {
  html[data-color-mode="auto"] .prism-chat-panel__input {
    border-color: #30363d;
  }
  html[data-color-mode="auto"] .prism-chat-panel__input:focus {
    border-color: #58a6ff;
    box-shadow: 0 0 0 1px #58a6ff;
  }
}

.prism-chat-panel__send {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #d0d7de;
  background: #0969da;
  color: #fff;
  cursor: pointer;
  font-family: inherit;
  font-weight: 600;
  flex-shrink: 0;
}
.prism-chat-panel__send:hover {
  background: #0860c5;
}

/* ---- Card row cell reset ---- */
td.prism-card-cell {
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
}
`;
