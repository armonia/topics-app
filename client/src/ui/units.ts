/**
 * A number and its unit are one word: «38 s» must never break so that «s» sits alone on a line.
 * Writes a no-break space between a digit and a short unit; text without such a pair comes back as it was.
 */
const NUMBER_UNIT = /(\d) (ms|s|min|h|m|km|kg|%)(?![\p{L}\d])/gu;

export const NO_BREAK_SPACE = ' ';

export function bindUnits(text: string): string {
  return text.replace(NUMBER_UNIT, `$1${NO_BREAK_SPACE}$2`);
}
