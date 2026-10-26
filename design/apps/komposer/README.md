# Komposer

The local web app that edits fuse-flow workflows, shows their workstreams and, on Kanvas, a project's design boards. Source: `fuse/komposer/`.

- Purpose: one engineer looks at the workflows, workstreams and design boards of the projects on their own machine.
- Theme: Komposer's own tokens, imported by `design/system/tokens/tokens.css`. The webfonts are not loaded in the options.
- Framework: React. Icons are lucide-react in the app; the options draw the same icons from `shared/Icon.tsx`, because a design folder cannot resolve lucide-react.
- Languages: English only, as Komposer is today. Not yet confirmed by the owner.
- Example data in the options is made up: no real projects, paths or people.
