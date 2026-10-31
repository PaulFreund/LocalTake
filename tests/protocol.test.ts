import { expect, it } from "vitest";
import { clientMessageSchema } from "../packages/protocol/src/index.js";
import fixtures from "./fixtures/protocol.json";

it.each(fixtures)(
  "browser schema matches the Rust contract: $name",
  ({ input, expected }) => {
    const parsed = clientMessageSchema.safeParse(input);
    expect(parsed.success ? parsed.data : null).toEqual(expected);
  },
);
