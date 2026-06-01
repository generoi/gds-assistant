// CSS side-effect imports (`import "./foo.css"`) are how wp-scripts/webpack
// wires per-entry stylesheets into the bundle. TypeScript needs a module
// declaration so the import resolves; this file lives in its own ambient
// .d.ts (no exports → loaded as a global script) so the wildcard is honored
// without intersecting with anything in globals.d.ts.

declare module "*.css";
