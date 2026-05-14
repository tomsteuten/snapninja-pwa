# SnapNinja PWA

Vanilla JS phone PWA. One HTML file, one app.js, one service worker.

## Deploy to GitHub Pages

1. Create a new public repo (suggest `snapninja-pwa`).
2. Copy the contents of this folder to the repo root.
3. Add icon-192.png and icon-512.png (any green-on-dark camera icon works; PWA installability requires both sizes).
4. Push. In repo Settings → Pages, set source to `main` branch / `/ (root)`.
5. Wait ~30s; visit `https://<you>.github.io/snapninja-pwa/` on your phone.
6. Tap "Add to Home Screen" in your browser's share menu.
7. First open: tap ⚙️, paste the Apps Script `/exec` URL and shared secret.

## Notes

- Resize is done in-browser (longest edge 1600px, JPEG q80, ~300 KB target).
- "1 photo pending" banner appears on upload failure; only the most recent failed photo is kept (multi-photo offline queue is a known v1 gap).
- If no active job context is in the Sheet, the capture button is disabled.
- If context is older than 8h, capture requires a one-tap confirmation.
- HTTPS is required for `getUserMedia` and PWA install — GitHub Pages provides this.
