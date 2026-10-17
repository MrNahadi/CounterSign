import { describe, expect, it } from "vitest";
import { NOT_SET_UP_MESSAGE } from "../src/checkout";
import { readCaptureResponse, readCreateResponse } from "../src/checkout-client";
import { PRODUCTS } from "../src/products";
import { productPageProps, SHOP_NOTICE, shopListProps } from "../src/shop-props";

// What the shop pages hand to the browser, and how the browser reads the checkout routes' answers.

const SECRET = "fake-client-secret-do-not-leak";
const CLIENT_ID = "fake-client-id-for-tests";
const env = {
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: CLIENT_ID,
  PAYPAL_CLIENT_SECRET: SECRET,
  DATABASE_URL: "postgres://user:db-password@localhost/db",
  PAYPAL_SEED_VAULT_TOKEN: "fake-vault-token-a",
};

describe("the shop list", () => {
  it("lists every product with its name, description, price and page", () => {
    const list = shopListProps();
    expect(list.map((item) => item.name)).toEqual(PRODUCTS.map((product) => product.name));
    expect(list[0]).toEqual({
      id: "market-basket",
      name: "Market basket",
      description: PRODUCTS[0]?.description,
      price: "$48.00",
      href: "/products/market-basket",
    });
    expect(list.find((item) => item.id === "floor-basket")?.price).toBe("$240.00");
  });

  it("says the shop is illustrative and the sandbox moves no money", () => {
    expect(SHOP_NOTICE).toBe(
      "Kikapu Studio is an illustrative demo shop. Payments use the PayPal sandbox, so no real money moves.",
    );
  });
});

describe("the product page's props", () => {
  it("passes the product and the client ID, and nothing else from the environment", () => {
    const props = productPageProps("laundry-hamper", env);
    expect(props).toEqual({
      product: {
        id: "laundry-hamper",
        name: "Laundry hamper",
        description: "A tall hamper with a lid and a cotton liner.",
        price: "$120.00",
        href: "/products/laundry-hamper",
      },
      checkout: { ready: true, clientId: CLIENT_ID },
    });
    const sent = JSON.stringify(props);
    for (const value of Object.values(env)) {
      if (value !== CLIENT_ID) expect(sent).not.toContain(value);
    }
  });

  it("shows the not-set-up message when a PayPal variable is missing", () => {
    for (const name of ["PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const) {
      const props = productPageProps("coaster-set", { ...env, [name]: undefined });
      expect(props?.checkout).toEqual({ ready: false, message: NOT_SET_UP_MESSAGE });
      expect(JSON.stringify(props)).not.toContain(SECRET);
    }
  });

  it("refuses checkout outside the sandbox", () => {
    const props = productPageProps("coaster-set", {
      ...env,
      PAYPAL_BASE_URL: "https://api-m.paypal.com",
    });
    expect(props?.checkout).toEqual({ ready: false, message: NOT_SET_UP_MESSAGE });
    expect(JSON.stringify(props)).not.toContain(CLIENT_ID);
  });

  it("has no page for an unknown product", () => {
    expect(productPageProps("market", env)).toBeUndefined();
    expect(productPageProps("", env)).toBeUndefined();
  });
});

describe("reading the create route's answer", () => {
  it("returns the order ID", () => {
    expect(readCreateResponse(200, { orderId: "5O190127TN364715T" })).toEqual({
      ok: true,
      orderId: "5O190127TN364715T",
    });
  });

  it("returns PayPal's message and debug ID on a failure", () => {
    expect(readCreateResponse(502, { error: "PayPal refused.", debugId: "abc123" })).toEqual({
      ok: false,
      message: "PayPal refused.",
      debugId: "abc123",
    });
    expect(readCreateResponse(503, { error: NOT_SET_UP_MESSAGE })).toEqual({
      ok: false,
      message: NOT_SET_UP_MESSAGE,
      debugId: null,
    });
  });

  it("never finds an order ID in an answer it can't read", () => {
    for (const [status, body] of [
      [200, {}],
      [200, { orderId: "" }],
      [200, "nope"],
      [500, undefined],
    ] as const) {
      expect(readCreateResponse(status, body).ok).toBe(false);
    }
  });
});

describe("reading the capture route's answer", () => {
  it("is paid with the order ID, capture ID and amount", () => {
    expect(
      readCaptureResponse(200, {
        paid: true,
        orderId: "5O190127TN364715T",
        captureId: "3C679366HH908993F",
        amount: { minor: 12000, currency: "USD" },
      }),
    ).toEqual({
      kind: "paid",
      orderId: "5O190127TN364715T",
      captureId: "3C679366HH908993F",
      amount: "$120.00",
    });
  });

  it("is not completed with PayPal's status", () => {
    expect(readCaptureResponse(200, { paid: false, status: "PENDING" })).toEqual({
      kind: "not_paid",
      status: "PENDING",
    });
  });

  it("is a failure with the message and debug ID on an error status", () => {
    expect(
      readCaptureResponse(502, { error: "PayPal couldn't capture.", debugId: "dbg-1" }),
    ).toEqual({ kind: "failed", message: "PayPal couldn't capture.", debugId: "dbg-1" });
  });

  it("is never paid when the answer can't be read", () => {
    for (const [status, body] of [
      [200, { paid: true, orderId: "X" }],
      [200, { paid: true, orderId: "A", captureId: "B", amount: { minor: 1.5, currency: "USD" } }],
      [200, { paid: "yes" }],
      [502, { paid: true, orderId: "A", captureId: "B", amount: { minor: 100, currency: "USD" } }],
      [200, null],
    ] as const) {
      expect(readCaptureResponse(status, body).kind).not.toBe("paid");
    }
  });
});
