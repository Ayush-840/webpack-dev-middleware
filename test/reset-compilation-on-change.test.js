import middleware from "../src";

import webpackConfig from "./fixtures/webpack.config";
import getCompiler from "./helpers/getCompiler";

jest.spyOn(globalThis.console, "log").mockImplementation();

/**
 * @param {import("../src").API} instance instance
 * @returns {Promise<unknown>} stats
 */
function waitUntilValid(instance) {
  return new Promise((resolve) => {
    instance.waitUntilValid(resolve);
  });
}

/**
 * @param {import("../src").API} instance instance
 * @returns {Promise<unknown>} close result
 */
function close(instance) {
  return new Promise((resolve) => {
    instance.close(resolve);
  });
}

// Opt-in stale-build handling (issue #369), default off. Without core support
// there is no true cancellation yet: these tests pin the middleware-side
// contract — the option changes nothing unless set, an invalidation requested
// mid-build re-asserts the queued re-run, an idle invalidation never triggers
// a spurious extra build, and `invalidate` callbacks wait for the fresh build
// instead of answering with stale stats.
describe("resetCompilationOnChange", () => {
  it("default off: an idle invalidate callback answers immediately with current stats", async () => {
    const compiler = getCompiler(webpackConfig);
    const instance = middleware(compiler);

    await waitUntilValid(instance);

    const statsBefore = instance.context.stats;

    let calls = 0;

    instance.invalidate((stats) => {
      calls += 1;

      expect(stats).toBe(statsBefore);
    });

    // `ready` answers synchronously while valid — the historical stale answer.
    expect(calls).toBe(1);

    // Let the triggered rebuild settle before closing.
    await waitUntilValid(instance);

    expect(calls).toBe(1);

    await close(instance);
  });

  it("option on: an idle invalidate callback waits for the fresh build", async () => {
    const compiler = getCompiler(webpackConfig);
    const instance = middleware(compiler, {
      resetCompilationOnChange: true,
    });

    await waitUntilValid(instance);

    const statsBefore = instance.context.stats;

    let calls = 0;
    let received;

    instance.invalidate((stats) => {
      calls += 1;
      received = stats;
    });

    // Deferred: no stale answer.
    expect(calls).toBe(0);

    await waitUntilValid(instance);

    expect(calls).toBe(1);
    expect(received).not.toBe(statsBefore);
    expect(received).toBe(instance.context.stats);

    await close(instance);
  });

  it("option on: an invalidation requested mid-build re-asserts watching.invalidate", async () => {
    const compiler = getCompiler(webpackConfig);
    const instance = middleware(compiler, {
      resetCompilationOnChange: true,
    });

    await waitUntilValid(instance);

    const invalidateSpy = jest.spyOn(instance.context.watching, "invalidate");

    // Simulate a build in flight: `state` false with no fresh `done` yet.
    instance.context.state = false;

    compiler.hooks.invalid.call("src/x.js", Date.now());

    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    invalidateSpy.mockRestore();

    await waitUntilValid(instance);
    await close(instance);
  });

  it("default off: an invalidation requested mid-build does not re-assert", async () => {
    const compiler = getCompiler(webpackConfig);
    const instance = middleware(compiler);

    await waitUntilValid(instance);

    const invalidateSpy = jest.spyOn(instance.context.watching, "invalidate");

    instance.context.state = false;

    compiler.hooks.invalid.call("src/x.js", Date.now());

    expect(invalidateSpy).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();

    // No build is running (the hook alone starts none): trigger a real rebuild
    // so the instance is valid again before closing.
    instance.invalidate();

    await waitUntilValid(instance);
    await close(instance);
  });

  it("option on: an idle invalidation never triggers a spurious rebuild", async () => {
    const compiler = getCompiler(webpackConfig);

    let doneCount = 0;

    compiler.hooks.done.tap("Counter", () => {
      doneCount += 1;
    });

    const instance = middleware(compiler, {
      resetCompilationOnChange: true,
    });

    await waitUntilValid(instance);

    expect(doneCount).toBe(1);

    const invalidateSpy = jest.spyOn(instance.context.watching, "invalidate");

    // Idle: `state` true, so this is the invalidation that starts the next
    // build, not a change during one.
    compiler.hooks.invalid.call("src/x.js", Date.now());

    expect(invalidateSpy).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();

    // Settle: no build was started by the hook alone, so no new `done`.
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    expect(doneCount).toBe(1);

    await close(instance);
  });

  it("option on, plugin mode: a mid-build invalidation is a no-op that does not throw", async () => {
    const compiler = getCompiler(webpackConfig);
    const watching = compiler.watch({}, () => {});
    const instance = middleware(
      compiler,
      { resetCompilationOnChange: true },
      true,
    );

    await waitUntilValid(instance);

    const invalidateSpy = jest.spyOn(watching, "invalidate");

    instance.context.state = false;

    expect(() => {
      compiler.hooks.invalid.call("src/x.js", Date.now());
    }).not.toThrow();

    // The host owns watching: the trigger must not touch it.
    expect(invalidateSpy).not.toHaveBeenCalled();

    await new Promise((resolve) => {
      watching.close(resolve);
    });
  });

  it("option on, plugin mode without watching: a mid-build invalidation does not throw", (done) => {
    const compiler = getCompiler(webpackConfig);
    const instance = middleware(
      compiler,
      { resetCompilationOnChange: true },
      true,
    );

    jest.spyOn(instance.context.logger, "warn").mockImplementation();

    instance.context.state = false;

    expect(() => {
      compiler.hooks.invalid.call("src/x.js", Date.now());
    }).not.toThrow();

    instance.close(() => {
      done();
    });
  });
});
