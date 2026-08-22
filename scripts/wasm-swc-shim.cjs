/**
 * Local development shim: force Next.js onto its WebAssembly SWC binary.
 *
 * WHY THIS EXISTS
 *
 * Next.js publishes no native SWC binary for `android/arm64`, so neither
 * `next dev` nor `next build` can start under Termux — the compiler itself fails
 * to load. Next does ship a WASM build (`@next/swc-wasm-nodejs`), but in 14.2.x
 * it is only ever attempted when `shouldLoadWasmFallbackFirst` is true, which
 * requires either:
 *
 *   - the platform triple to appear in Next's `knownDefaultWasmFallbackTriples`
 *     list (Android does not), or
 *   - `process.versions.webcontainer` to be truthy.
 *
 * `experimental.useWasmBinary` does NOT help: for a triple Next considers
 * "supported" it logs "will be ignored" and carries on to the native path. The
 * trickle-down path after a native failure only retries a *native* download and
 * then exits; it never reaches the WASM loader.
 *
 * So the only non-invasive lever is the webcontainer flag. Setting it makes Next
 * load the WASM compiler, which works correctly and is only slower.
 *
 * SCOPE
 *
 * Development convenience for this platform only. It is never imported by
 * application code and has no effect on a deployed build — Vercel's linux/x64
 * builders have a native binary and must keep using it.
 *
 * USAGE
 *
 *   NODE_OPTIONS="--require ./scripts/wasm-swc-shim.cjs" npx next dev
 *
 * Remove this file, and the `@next/swc-wasm-nodejs` devDependency, once Next.js
 * ships an android/arm64 binary or lists the triple as WASM-eligible.
 */

if (process.platform === "android" && !process.versions.webcontainer) {
  // `process.versions` is a non-writable property holding a mutable object, so
  // individual keys can still be assigned.
  process.versions.webcontainer = "termux-wasm-swc-shim"
  // eslint-disable-next-line no-console -- runs before the app logger exists
  console.log("[wasm-swc-shim] forcing Next.js onto the WebAssembly SWC binary")
}
