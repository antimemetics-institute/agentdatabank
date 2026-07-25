/* Navigation with feedback (round-3 loading UX): the clicked element gets a
   pulsating glow ring (.nav-glow, index.css) while the target's data is prefetched,
   then the hash flips — so the destination paints with content instead of a
   placeholder. The prefetch is capped; navigation never blocks on a slow fetch. */

export async function navigateWithGlow(
  el: Element | null,
  hash: string,
  prefetch?: () => Promise<unknown>,
): Promise<void> {
  if (location.hash === hash) return;
  el?.classList.add("nav-glow");
  try {
    if (prefetch)
      await Promise.race([prefetch(), new Promise((r) => setTimeout(r, 1200))]);
  } finally {
    el?.classList.remove("nav-glow");
    location.hash = hash;
  }
}
