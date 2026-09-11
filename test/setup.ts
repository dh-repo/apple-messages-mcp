import { afterEach } from "vitest";
import { resetDecodeSidecars } from "../src/db/sidecar.ts";

afterEach(() => {
  resetDecodeSidecars();
});
