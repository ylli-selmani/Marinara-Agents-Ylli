import { useLayoutEffect, useState } from "react";

/** Fill the visible viewport without assuming a height for the Engine's headers. */
export function useFillHeight<T extends HTMLElement>({ bottom = 12, min = 320, enabled = true } = {}) {
  const [element, setElement] = useState<T | null>(null);

  useLayoutEffect(() => {
    if (!element || !enabled) return;
    const previousHeight = element.style.height;
    const previousMinHeight = element.style.minHeight;
    const update = () => {
      element.style.minHeight = `${min}px`;
      const height = `${Math.max(min, window.innerHeight - element.getBoundingClientRect().top - bottom)}px`;
      if (element.style.height !== height) element.style.height = height;
    };
    update();
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    // Headers can wrap inside a fixed-size host, leaving the document's size unchanged.
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor);
      for (let sibling = ancestor.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        observer.observe(sibling);
      }
    }
    return () => {
      window.removeEventListener("resize", update);
      observer.disconnect();
      element.style.height = previousHeight;
      element.style.minHeight = previousMinHeight;
    };
  }, [element, bottom, min, enabled]);

  return setElement;
}
