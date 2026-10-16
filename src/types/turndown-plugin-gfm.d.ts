// turndown-plugin-gfm ships no type declarations. This is the one plugin signature the code uses.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: (service: TurndownService) => void;
}
