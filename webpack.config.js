import path from 'path';
import webpack from 'webpack';
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
    'admin-chat': path.resolve(__dirname, 'resources/scripts/admin-chat.jsx'),
    'admin-settings': path.resolve(
      __dirname,
      'resources/scripts/admin-settings.jsx',
    ),
    'skill-editor': path.resolve(
      __dirname,
      'resources/scripts/skill-editor.jsx',
    ),
  },
  output: {
    ...defaultConfig.output,
    uniqueName: 'gds-assistant',
    path: path.resolve(__dirname, 'build'),
  },
  // Disable ALL code splitting — bundle everything into one file.
  // Dynamic imports from react-streamdown create async chunks that fail to
  // load in WP admin due to CSP nonce requirements and unknown publicPath.
  optimization: {
    ...defaultConfig.optimization,
    splitChunks: false,
    // LimitChunkCountPlugin with maxChunks=1 prevents dynamic import() chunks
    minimize: defaultConfig.optimization?.minimize ?? true,
  },
  plugins: [
    ...(defaultConfig.plugins || []),
    new webpack.optimize.LimitChunkCountPlugin({
      maxChunks: 1,
    }),
  ],
};
