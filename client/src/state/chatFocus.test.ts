/**
 * Who receives something nobody asked for.
 *
 * @covers CHAT-FOCUS-01
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { chatFocus } from "./chatFocus";

beforeEach(() => chatFocus._reset());

describe("chatFocus", () => {
  test("una chat sola prende tutto, anche senza aver mai avuto il focus", () => {
    chatFocus.register("a");
    expect(chatFocus.isRecipient("a")).toBe(true);
  });

  test("con più chat aperte riceve SOLO l'ultima usata", () => {
    chatFocus.register("a");
    chatFocus.register("b");
    chatFocus.focus("b");
    expect(chatFocus.isRecipient("b")).toBe(true);
    expect(chatFocus.isRecipient("a")).toBe(false);
  });

  test("chi non è montato non riceve niente", () => {
    chatFocus.register("a");
    expect(chatFocus.isRecipient("fantasma")).toBe(false);
  });

  test("smontare il destinatario passa il testimone, non lascia il vuoto", () => {
    chatFocus.register("a");
    chatFocus.register("b");
    chatFocus.focus("b");
    chatFocus.unregister("b");
    expect(chatFocus.isRecipient("a")).toBe(true);
  });

  test("il focus di una chat smontata non può rubare il destinatario", () => {
    chatFocus.register("a");
    chatFocus.register("b");
    chatFocus.unregister("b");
    chatFocus.focus("b");
    expect(chatFocus.isRecipient("a")).toBe(true);
    expect(chatFocus.isRecipient("b")).toBe(false);
  });

  test("il primo registrato è il destinatario finché nessuno prende il focus", () => {
    chatFocus.register("a");
    chatFocus.register("b");
    expect(chatFocus.isRecipient("a")).toBe(true);
    expect(chatFocus.isRecipient("b")).toBe(false);
  });
});
