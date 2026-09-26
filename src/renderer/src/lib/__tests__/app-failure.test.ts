import { MantineProvider } from "@mantine/core";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../../components/app-failure";
import { host } from "../host";

function Crashing(): null {
  useEffect(() => {
    throw new Error("the addon did not load");
  }, []);
  return null;
}

describe("AppErrorBoundary", () => {
  const container = document.createElement("div");
  document.body.append(container);
  afterEach(() => vi.restoreAllMocks());

  it("replaces a crashed app with the error and a way to the log", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reveal = vi.spyOn(host.diag, "revealLogFile").mockImplementation(() => {});
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        createElement(
          MantineProvider,
          { forceColorScheme: "dark" },
          createElement(AppErrorBoundary, null, createElement(Crashing)),
        ),
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Noise Canvas Has Stopped"));
    expect(container.textContent).toContain("the addon did not load");
    expect(container.textContent).toContain("Open an issue on GitHub");

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Show Log File");
    button?.click();
    expect(reveal).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
