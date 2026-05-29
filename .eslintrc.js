/**
 * Inherits the @wordpress/scripts defaults (recommended config + bundled
 * babel/prettier wiring) and only opts out of rules that don't fit a JS-first
 * codebase plus the @wordpress/* externals pattern.
 *
 * - env.browser: covers document/window/navigator/localStorage refs (we run
 *   in wp-admin, not in Node).
 * - import/no-extraneous-dependencies: @wordpress/* packages are externalised
 *   by webpack from window.wp.* at runtime, not bundled, so they don't appear
 *   in our package.json. The rule needs to know to allow them.
 * - jsdoc/require-param-type + similar: the existing codebase doesn't use
 *   typed @param tags (we're plain JS with descriptions only). The TS
 *   migration in #14 will pick these up properly.
 * - no-nested-ternary: not great, but the diff helpers use them legibly;
 *   we'll clean up when those modules move to TS.
 */
module.exports = {
  root: true,
  extends: [require.resolve("@wordpress/scripts/config/.eslintrc.js")],
  env: {
    browser: true,
    es2022: true,
  },
  settings: {
    "import/resolver": {
      node: {
        extensions: [".js", ".jsx"],
      },
    },
  },
  rules: {
    // @wordpress/* packages are provided as externals (window.wp.*) at
    // runtime and don't appear in package.json. The build step catches truly
    // missing imports anyway, so this rule mainly produces noise here.
    "import/no-extraneous-dependencies": "off",
    "import/no-unresolved": [
      "error",
      {
        ignore: ["^@wordpress/"],
      },
    ],
    "jsdoc/require-param-type": "off",
    "jsdoc/require-returns-type": "off",
    "jsdoc/require-returns-description": "off",
    "jsdoc/check-param-names": "off",
    "jsdoc/check-tag-names": "off",
    "no-nested-ternary": "warn",
    // Real concerns, but separate work: a11y on click-handler divs needs
    // proper role/tabIndex/keyboard wiring; declaration ordering touches
    // every component; confirm() calls deserve real dialog UI. Track as
    // warnings until each gets its own focused pass.
    "@wordpress/no-unused-vars-before-return": "warn",
    "jsx-a11y/no-static-element-interactions": "warn",
    "no-alert": "warn",
  },
};
