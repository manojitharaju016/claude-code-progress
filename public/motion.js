// motion.js — the two pieces of movement the page actually needs.
//
// Both animate transform and opacity only, so they stay on the compositor and
// hold 60fps. Everything here is a no-op when the visitor asks for less motion.

"use strict";

export const reduced = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let observer = null;

/**
 * Reveal elements as they scroll in, once each.
 *
 * A poll re-renders these cards every few seconds. Re-revealing them would make
 * the page twitch, so an element that has already been revealed keeps its state
 * and is skipped: `revealed` is the memory, `data-reveal` only marks candidates.
 */
export function revealOnScroll(root = document) {
  if (reduced()) {
    root.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("revealed"));
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        const group = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
        el.style.transitionDelay = Math.min(group, 4) * 60 + "ms";
        el.classList.add("revealed");
        observer.unobserve(el);
      }
    }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  }
  root.querySelectorAll("[data-reveal]:not(.revealed)").forEach((el) => observer.observe(el));
}

/** Mark fresh nodes for reveal, carrying over anything already shown. */
export function markReveal(el) {
  if (!el.classList.contains("revealed")) el.setAttribute("data-reveal", "");
  return el;
}

/**
 * Open or close a block by animating its measured height, then releasing it to
 * auto so later content changes do not fight the inline value.
 */
export function toggleHeight(el, open) {
  if (reduced()) { el.style.height = ""; el.hidden = !open; return; }
  el.hidden = false;
  const from = el.getBoundingClientRect().height;
  el.style.height = "auto";
  const to = open ? el.getBoundingClientRect().height : 0;
  el.style.height = from + "px";
  el.style.overflow = "hidden";
  requestAnimationFrame(() => {
    el.style.transition = "height var(--d) var(--ease-io), opacity var(--d) var(--ease-io)";
    el.style.opacity = open ? "1" : "0";
    el.style.height = to + "px";
  });
  const done = () => {
    el.style.transition = el.style.height = el.style.overflow = "";
    if (!open) el.hidden = true;
    el.removeEventListener("transitionend", done);
  };
  el.addEventListener("transitionend", done);
}

/** Slide the underline of a segmented control to the selected button. */
export function moveThumb(nav) {
  const thumb = nav.querySelector(".seg-thumb");
  const active = nav.querySelector('[aria-selected="true"]');
  if (!thumb || !active) return;
  thumb.style.width = active.offsetWidth + "px";
  thumb.style.transform = "translateX(" + active.offsetLeft + "px)";
}

/** A hairline under the nav, but only once the page has actually moved. */
export function navShadow(nav) {
  let ticking = false;
  const apply = () => { nav.classList.toggle("scrolled", window.scrollY > 4); ticking = false; };
  addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(apply); }
  }, { passive: true });
  apply();
}

/** Count a number up to its new value; instant when motion is reduced. */
export function tweenNumber(el, to, format) {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  if (reduced() || from === to) { el.textContent = format(to); return; }
  const start = performance.now(), dur = 400;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
