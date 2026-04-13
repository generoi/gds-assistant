import path from 'path';
import webpack from 'webpack';
import defaultConfig from '@wordpress/scripts/config/webpack.config.js';

const __dirname = import.meta.dirname;

// Inject @tailwindcss/postcss into the existing PostCSS loader.
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
              plugins: [['@tailwindcss/postcss', {}]],
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
    'admin-settings': path.resolve(__dirname, 'resources/scripts/admin-settings.jsx'),
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
