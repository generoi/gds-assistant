/**
 * Local ambient declarations for `@wordpress/editor` + `@wordpress/plugins`
 * — just the bits skill-editor.tsx uses.
 *
 * We don't pull in the official `@types/wordpress__editor` /
 * `@types/wordpress__plugins` packages because they declare their own peer
 * trees that resolve transitive deps (`@wordpress/media-utils`,
 * `@wordpress/components@33`) to versions different from what our actual
 * runtime tree settles on, which breaks `npm ci` (the lock file ends up
 * with one resolution while CI sees another). Webpack externalises these
 * modules from `window.wp.*` at runtime anyway, so we only need just-enough
 * types to compile.
 */

declare module "@wordpress/editor" {
  import type { ReactNode } from "react";
  export const PluginDocumentSettingPanel: React.ComponentType<{
    name: string;
    title: string;
    children?: ReactNode;
  }>;
}

declare module "@wordpress/plugins" {
  export function registerPlugin(
    name: string,
    settings: {
      render: () => JSX.Element | null;
      icon?: unknown;
    },
  ): unknown;
}

declare module "@wordpress/block-editor" {
  import type { ReactNode } from "react";
  export const BlockControls: React.ComponentType<{
    group?: string;
    children?: ReactNode;
  }>;
}
