# Komposer

Komposer is the local web app that edits fuse-flow workflows and shows their workstreams; see
`README.md` for what it does and how to run it. These rules cover its user interface. The checks
in `test/uiRules.test.ts` enforce the parts that can be checked mechanically. Run them with
`bun test test/uiRules.test.ts`, and the whole suite with `bun run test`.

## Interface rules

1. **Actor glyphs have one meaning each.** `User` is the owner, `Bot` is the agent, and `Cog` is
   mechanical work: checks and scripts. An attended step shows `User` and `Bot`, an unattended
   step shows `Bot` alone, and `User` alone is kept for a step that is entirely the owner's manual
   work. Take the icons from `GATE_ICON` and the colours from `GATE_STYLE` in `src/Flow.tsx`; do
   not give these actors another icon or colour anywhere.
2. **Icons come from `lucide-react`.** Do not use emoji or Unicode symbols as icons: emoji ignore
   the CSS colour and look different on every platform. Text arrows such as `←` and `↩` in chips
   are characters, not icons, and stay.
3. **Glyphs alone on the diagram, glyph and word in the editor.** Pills on a diagram stay compact,
   and a pill that shows only glyphs carries a tooltip and an accessible label (`aria-label`). An
   editing control shows the glyph next to its word, as the Autonomy Mode field does.
4. **Nothing is drawn over a native form control.** Put an icon or a badge beside a `select` or
   an `input`, never on top of it with padding to make room: some browsers ignore padding on a
   native `select`, and the text then runs under the badge.
5. **Tooltip text is written for the person using Komposer.** Say what they can expect, in
   sentence case and in few words. Emphasise only the key terms, in bold, and do not repeat the
   field's label. The schema descriptions in `fuse/flow/src/schemas/` are written for the
   engine; where one reads poorly as a tooltip, give the field Komposer's own text in
   `src/docs.ts`.

## Checks

`test/uiRules.test.ts` fails when:

- an element has a `title` attribute. Komposer has one tooltip, drawn by `src/Tooltip.tsx`: give
  an element a plain-text tip with `data-tip`, and richer content through `useTooltip`, as
  `InfoTip` does. Where the title was an element's only name, as on an icon-only button, also
  give it an `aria-label`.
- a source file contains an emoji (rule 2).
- a script hard-codes a colour (a hex value or a colour function). Colours come from the theme's
  tokens in `src/tokens/colors.css`, used through CSS variables, and a background always comes
  with its text colour so both themes stay readable.
