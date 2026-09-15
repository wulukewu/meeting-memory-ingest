export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Meeting Memory">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="play" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#93c5fd"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#bg)"/>
  <rect x="24" y="18" width="24" height="32" rx="5" fill="#2c3a57" opacity=".55"/>
  <rect x="20" y="16" width="24" height="32" rx="5" fill="#3a4a6b" opacity=".75"/>
  <rect x="16" y="14" width="24" height="32" rx="5" fill="#1e293b" stroke="#5b6f97" stroke-width="1.2"/>
  <rect x="19" y="17" width="18" height="13" rx="3" fill="#0f172a"/>
  <path d="M26 20.2 31.8 23.5 26 26.8Z" fill="url(#play)"/>
  <rect x="20.5" y="34" width="15.5" height="3.2" rx="1.6" fill="#f8fafc"/>
  <rect x="20.5" y="39.2" width="10.5" height="3.2" rx="1.6" fill="#e2e8f0"/>
</svg>`;

export function faviconResponse(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}
