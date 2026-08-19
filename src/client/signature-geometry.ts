/** The signature canvas has a fixed internal pixel buffer (400x160, set via
 *  the width/height attributes on <canvas>) but is stretched to the
 *  container's full width by CSS (.signature-canvas { width: 100% }) — on
 *  any viewport narrower than ~400px (i.e. every phone) the rendered size no
 *  longer matches the buffer size, so a raw client-vs-rect pointer offset
 *  must be rescaled into buffer space or the drawn stroke drifts away from
 *  the actual touch point. Kept dependency-free (no DOM types, no Preact) so
 *  it's importable from a plain unit test — see
 *  test/job-compliance-signature.test.ts. */
export function scalePointerPosition(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number }
): { x: number; y: number } {
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}
