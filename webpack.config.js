import path from 'path';
import defaultConfig from '@wordpress/scripts/config/webpack.config.js';

const __dirname = import.meta.dirname;

// Scope every Tailwind utility selector under `.gds-assistant` so utilities
// like `.inline` or `.list-disc` can't accidentally collide with WP admin
// elements that happen to share those classnames. Runs AFTER
// @tailwindcss/postcss so the prefixer sees fully-resolved selectors.
//
// Our own rules already use `.gds-assistant…` selectors and are recognised
// and left alone. CSS variable definitions stay on :root so tokens are
// globally available.
const scopeToAssistant = [
  'postcss-prefix-selector',
  {
    prefix: '.gds-assistant',
    transform(prefix, selector) {
      // Leave CSS variables at :root / html / body un-prefixed so the
      // @theme tokens remain globally referenceable.
      if (/^:root\b|^html\b|^body\b/.test(selector)) return selector;
      // Already explicitly scoped — no double-prefix.
      if (selector.startsWith('.gds-assistant')) return selector;
      // Universal resets (`*`, `::before`, `::backdrop`) get scoped to the
      // assistant container to avoid nuking WP admin styles.
      if (
        selector === '*' ||
        selector.startsWith('::') ||
        selector.startsWith(':before') ||
        selector.startsWith(':after')
      ) {
        return `${prefix} ${selector}`;
      }

      return `${prefix} ${selector}`;
    },
  },
];

// Inject @tailwindcss/postcss + the scoping pass into the existing PostCSS loader.
const updatedRules = defaultConfig.module.rules.map((rule) => {
  if (!rule.test?.toString().includes('css')) {
    return rule;
  }

  return {
    ...rule,
    use: rule.use?.map((loader) => {
      if (
        typeof loader === 'object' &&
        loader.loader &&
        loader.loader.includes('postcss-loader')
      ) {
        return {
          ...loader,
          options: {
            ...loader.options,
            postcssOptions: {
              plugins: [['@tailwindcss/postcss', {}], scopeToAssistant],
            },
          },
        };
      }
      return loader;
    }),
  };
});

export default {
  ...defaultConfig,
  module: {
    ...defaultConfig.module,
    rules: updatedRules,
  },
  entry: {
    'admin-chat': path.resolve(__dirname, 'resources/scripts/admin-chat.tsx'),
    'admin-settings': path.resolve(
      __dirname,
      'resources/scripts/admin-settings.tsx',
    ),
    'skill-editor': path.resolve(
      __dirname,
      'resources/scripts/skill-editor.tsx',
    ),
  },
  output: {
    ...defaultConfig.output,
    uniqueName: 'gds-assistant',
    path: path.resolve(__dirname, 'build'),
    // `auto` reads the loading script's URL at runtime and infers the
    // publicPath from it — works for WP admin where the absolute URL is
    // server-rendered (wp_enqueue_script). Without this, async chunks try
    // to fetch from `/` and 404.
    publicPath: 'auto',
  },
  // Code-splitting is back on. Dynamic imports (React.lazy on the modal
  // subtree, anything else that wants its own chunk) now produce real async
  // bundles. The async chunks load via the publicPath: 'auto' inferred URL.
  // If a hardened CSP ever blocks them, set __webpack_nonce__ from the
  // localized config — for now WP admin doesn't enforce script-src.
  optimization: {
    ...defaultConfig.optimization,
    minimize: defaultConfig.optimization?.minimize ?? true,
  },
  plugins: [
    ...(defaultConfig.plugins || []),
  ],
};
