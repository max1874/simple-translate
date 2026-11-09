# Design record

Verdicts Max gave on this extension's UI, newest last. A rejected element does not come back; a chosen one is not lost.

## 2026-11-09 — the toolbar icon opens a panel

- **Shown:** two options after Max hit a rejected DeepSeek key (HTTP 401) with nowhere obvious to change it. A: keep one-click translation; the error toast gets a "settings" button and the icon opens settings while the key stays rejected. B: the icon opens a small panel (translate button with its shortcut, service · model, API key status with an inline field, "All settings").
- **Chosen:** B, an explicit pick. His words: "点一下图标应该是弹出一个界面，不然现在我就尬住了，还要找地方去 setup key".
- **Kept:** ⌥A still translates directly, without the panel. The panel reuses the settings page's colours and controls (`popup.css` on top of `options.css`).
