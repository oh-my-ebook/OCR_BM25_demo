import { Match, type Kiwi } from "kiwi-nlp";

type KiwiTextTools = Pick<Kiwi, "tokenize" | "joinSent">;

export function postprocessKiwiText(kiwi: KiwiTextTools, text: string) {
  return text
    .split("\n")
    .map((line) => {
      const tokens = kiwi.tokenize(line, Match.allWithNormalizing);
      return tokens.length
        ? kiwi.joinSent(tokens.map((token) => ({ form: token.str, tag: token.tag })), true).str
        : line;
    })
    .join("\n");
}
