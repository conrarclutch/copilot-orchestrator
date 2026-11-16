import { common, createLowlight } from "lowlight";

type Lowlight = ReturnType<typeof createLowlight>;
let instance: Lowlight | undefined;

/** Highlight a fenced code block using one lazily-created shared registry. */
export function highlightCode(language: string, value: string) {
  instance ??= createLowlight(common);
  return instance.highlight(language, value);
}
