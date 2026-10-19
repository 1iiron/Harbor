const FADE_MS = 120;

export function fadeTrayMenu(
  element: HTMLElement,
  opacity: 0 | 1,
  reducedMotion: boolean,
  completed: () => void = () => {},
): () => void {
  const from = getComputedStyle(element).opacity || element.style.opacity || "0";
  element.style.opacity = String(opacity);
  if (reducedMotion || Number(from) === opacity || typeof element.animate !== "function") {
    completed();
    return () => {};
  }
  const animation = element.animate([{ opacity: from }, { opacity: String(opacity) }], {
    duration: FADE_MS,
    easing: "ease-out",
  });
  let cancelled = false;
  const finish = () => {
    if (!cancelled) completed();
  };
  void animation.finished.then(finish, finish);
  return () => {
    cancelled = true;
    // Preserve a partial entry fade when dismissal interrupts it.
    const current = getComputedStyle(element).opacity;
    animation.cancel();
    element.style.opacity = current;
  };
}

export function presentTrayMenu(
  element: HTMLElement,
  present: () => Promise<unknown>,
  reducedMotion: () => boolean,
): { ready: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let cancelFade = () => {};
  element.style.opacity = "0";
  const ready = Promise.resolve()
    .then(present)
    .then(() => {
      // Hidden WebViews can advance animation clocks before the native show.
      if (!cancelled) cancelFade = fadeTrayMenu(element, 1, reducedMotion());
    });
  return {
    ready,
    cancel() {
      cancelled = true;
      cancelFade();
    },
  };
}
