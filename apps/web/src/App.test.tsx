import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App.tsx";
import * as api from "./api.ts";

describe("App (#48)", () => {
  it("shows a connected status once the API answers ok", async () => {
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent("Connected to the API.");
  });

  it("shows an unreachable status when the API does not answer", async () => {
    vi.spyOn(api, "checkHealth").mockResolvedValue("error");
    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent("Could not reach the API.");
  });
});
