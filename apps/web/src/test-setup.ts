import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "@testing-library/jest-dom/vitest";

// Vitest, unlike Jest, has no implicit global afterEach for RTL to hook into automatically.
afterEach(cleanup);
