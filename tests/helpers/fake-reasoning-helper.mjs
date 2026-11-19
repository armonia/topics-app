#!/usr/bin/env bun
// A stand-in for the Swift translation helper: the same NDJSON protocol, answers
// that are the same on every machine. Used by the unit tests of the adapter and
// by the e2e bench, which puts it at the process boundary of the real server.
//
// It knows English and Italian only. `translate` looks the sentence up in a
// small dictionary and otherwise marks it, so a test can tell a translated
// sentence from an untouched one.
import { createInterface } from "node:readline";

const DICTIONARY = {
  "First I need to read the failing test and see what it expects.": "Prima devo leggere il test che fallisce e vedere cosa si aspetta.",
  "Then I will check the migration file for the new column.": "Poi controllerò il file di migrazione per la nuova colonna.",
  "After that the answer can be written.": "Dopo di che si può scrivere la risposta.",
};

const lang = (text) => {
  if (/\b(the|and|to|is|of|then|first|after)\b/i.test(text)) return { lang: "en", confidence: 0.99 };
  if (/\b(il|la|di|che|per|prima|poi)\b/i.test(text)) return { lang: "it", confidence: 0.99 };
  return { lang: "und", confidence: 0 };
};

const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  let req;
  try { req = JSON.parse(line); } catch { continue; }
  const { id, op } = req;
  if (op === "ping") reply({ id, ok: true });
  else if (op === "detect") reply({ id, ...lang(req.text ?? "") });
  else if (op === "status") reply({ id, status: req.from === "en" && req.to === "it" ? "installed" : "unsupported" });
  else if (op === "translate") reply({ id, text: DICTIONARY[req.text] ?? `[${req.to}] ${req.text}` });
  else if (op === "crash") process.exit(3);
  else reply({ id, error: "unknown op" });
}
