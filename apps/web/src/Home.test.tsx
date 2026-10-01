import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as api from "./api.ts";
import Home from "./Home.tsx";
import { renderWithIntl } from "./test-utils.tsx";

describe("Home (#48, #53)", () => {
  it("shows a connected status once the API answers ok", async () => {
    vi.spyOn(api, "checkHealth").mockResolvedValue("ok");
    renderWithIntl(<Home />);

    expect(await screen.findByRole("status")).toHaveTextContent("Connected to the API.");
  });

  it("shows an unreachable status when the API does not answer", async () => {
    vi.spyOn(api, "checkHealth").mockResolvedValue("error");
    renderWithIntl(<Home />);

    expect(await screen.findByRole("status")).toHaveTextContent("Could not reach the API.");
  });
});
