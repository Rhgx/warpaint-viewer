interface WebGL2ProbeContext {
  getExtension(name: 'WEBGL_lose_context'): { loseContext(): void } | null;
}

/** Reports whether a WebGL 2 context can be created, then releases the probe context. */
export function canUseWebGL2(createContext: () => WebGL2ProbeContext | null): boolean {
  const gl = createContext();
  if (!gl) return false;
  // Release the probe now so it does not count against the browser's context limit.
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}
