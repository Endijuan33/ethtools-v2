/**
 * Shared setup for the component/route suite.
 *
 * jsdom omits several browser APIs the component tree uses (media queries
 * for the toast host, ResizeObserver and pointer capture for Radix
 * primitives, object URLs for backup downloads). They are stubbed here —
 * minimally and visibly — rather than per test, so component behavior is
 * the only variable under test. Storage is reset between tests so vault
 * state never leaks across cases. Suites pinned to the node environment
 * (`@vitest-environment node`) skip every DOM stub.
 */
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { Buffer as NodeBuffer } from "node:buffer"
import { afterEach, vi } from "vitest"

const hasDom = typeof window !== "undefined"

// Realm alignment for typed arrays. Vitest populates the test globals
// from the jsdom window, whose Uint8Array is a different realm's
// constructor than Node's. Dependencies that hand back Node Buffers
// (ethers' node:crypto hash path returns them from mnemonic checksum
// math) then fail ethers' own `instanceof Uint8Array` BytesLike guard —
// a valid recovery phrase "fails" validation in tests while passing in
// Node and in the browser. Point the global at Node's constructor so
// instanceof checks agree with the values actually flowing through.
const NodeUint8Array = Object.getPrototypeOf(NodeBuffer) as typeof Uint8Array
if (globalThis.Uint8Array !== NodeUint8Array) {
  globalThis.Uint8Array = NodeUint8Array
}

afterEach(() => {
  cleanup()
  if (hasDom) {
    localStorage.clear()
    sessionStorage.clear()
  }
})

if (hasDom) {
  // jsdom has no layout engine. Treat the viewport as desktop-sized
  // (min-width queries match) so dialogs take their Radix Dialog path
  // rather than the touch drawer, which needs real pointer geometry.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: ResizeObserverStub,
  })

  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}

  // Backup export triggers a download through an object URL; jsdom cannot
  // create one, and the download itself is not what the tests assert.
  URL.createObjectURL = vi.fn(() => "blob:test-object-url")
  URL.revokeObjectURL = vi.fn()

  // jsdom's Blob lacks the text() reader the backup import flow uses to
  // read a chosen file; bridge it through FileReader, which jsdom has.
  if (typeof Blob.prototype.text !== "function") {
    Blob.prototype.text = function text(): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(this)
      })
    }
  }
}
