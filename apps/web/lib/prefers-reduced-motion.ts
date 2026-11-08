/** Whether the system asks for reduced motion — decorative animations skip
 * themselves entirely when it does. False during server rendering, where no
 * animation runs anyway. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
