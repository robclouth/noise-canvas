// Platform-specific shader defines
// Nested modulation (modulating modulator parameters) is disabled on Windows
// due to shader compilation performance issues with unrolled loops

const isWindows = typeof window !== "undefined" && window.platform === "win32";

/**
 * Prepends platform-specific defines to a shader source string.
 * On Windows, adds DISABLE_NESTED_MODULATION to prevent slow shader compilation.
 */
export function withPlatformDefines(shaderSource: string): string {
  if (isWindows) {
    return `#define DISABLE_NESTED_MODULATION\n${shaderSource}`;
  }
  return shaderSource;
}
